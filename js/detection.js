/* ==========================================================================
 * detection.js
 * Blockage / bridging detector. Reads engine state at a fixed sampling
 * interval and classifies flow from OBSERVABLE simulation quantities only.
 *
 * Signals per sample
 *   - cumulative mass/count entering (s = 0) and leaving (s = L) the pipe
 *   - moving-window inlet and outlet mass rates over window W
 *   - axial bins: count, in-plane solid fraction phi, mean axial velocity
 *   - stalled particles: speed < vStall
 *   - contact network of stalled particles (union-find on the engine's
 *     contact list). A connected group of stalled particles that touches
 *     BOTH walls (side A and side B) is a spanning structure: a bridge/arch.
 *     If a single particle touches both walls itself, it is a single-particle
 *     obstruction.
 *
 * Status levels (all thresholds are user inputs, not engineering criteria)
 *   0 GREEN   free flowing
 *   1 YELLOW  outlet/inlet < rRestrict, or a dense stalled zone, or feed
 *             cannot insert particles (back-up into the feed chute)
 *   2 ORANGE  a spanning bridge exists (probable bridging)
 *   3 RED     a bridge has persisted >= tPersist while outlet/nominal <= rBlock,
 *             or outlet flow has been zero for >= tPersist with material in
 *             the pipe while feed is still active
 * Detection is suppressed during the warm-up time (transit of the first
 * particles) to avoid flagging the start-up transient.
 * ========================================================================== */
(function (FP) {
  'use strict';

  function Detector(cfg, geom, eng, dv) {
    this.cfg = cfg; this.geom = geom; this.eng = eng; this.dv = dv;
    const D = this.D = cfg.detect;
    this.sampleDt = D.sampleDt; this.warmup = dv.warmup;
    // Rate window: at least the input window, and long enough to contain about
    // 10 stones at the nominal release rate (sparse coarse-rock flow is noisy).
    this.W = Math.max(D.window, 10 / Math.max(dv.partRate, 1e-6));
    this.dMaxGrade = 2 * eng.fac.maxBoundR; // largest stone extent in the plane
    this.s0 = -geom.feedLen; this.s1 = geom.L;
    this.binLen = Math.max(0.02, D.binLen / 1000);
    this.nb = Math.max(1, Math.ceil((this.s1 - this.s0) / this.binLen));
    const F = (n) => new Float64Array(n);
    this.binW = F(this.nb); this.binMid = F(this.nb);
    for (let j = 0; j < this.nb; j++) {
      const sm = this.s0 + (j + 0.5) * this.binLen;
      this.binMid[j] = sm; this.binW[j] = geom.widthAt(sm);
    }
    this.binCnt = F(this.nb); this.binArea = F(this.nb); this.binVax = F(this.nb); this.binPhi = F(this.nb);
    this.binSlow = F(this.nb);
    this.slowAccum = F(this.nb);   // integral of stalled count over time per bin [particle*s]
    this.stallTime = F(this.nb);   // time each bin spent as a dense stalled zone [s]
    this.phiMax = F(this.nb);

    this.chokeTime = 0; this.accept = null; this.minAccept = 1;
    this.ts = { t: [], inM: [], outM: [], inN: [], outN: [], nIn: [], vMean: [], vMin: [], uw: [], Qw: [], feedM: [], acc: [],
      level: [], rIO: [], rON: [], inRate: [], outRate: [] };
    this.events = []; this.openEv = null;
    this.level = 0; this.maxLevel = 0; this.levelTime = [0, 0, 0, 0]; this.activeTime = 0;
    this.firstLevelTime = [null, null, null, null];
    this.firstLevelMass = [null, null, null, null];
    this.arch = null; this.stalledBins = []; this.slowFlag = new Uint8Array(eng.N);
    this.nextSample = this.sampleDt;
    this.uf = new Int32Array(eng.N);
    this.reasons = [];
  }

  Detector.prototype.find = function (i) {
    const p = this.uf;
    while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; }
    return i;
  };

  /** Call after each engine step; samples when the interval elapses. */
  Detector.prototype.maybeSample = function () {
    if (this.eng.t + 1e-12 >= this.nextSample) {
      this.sample();
      this.nextSample += this.sampleDt;
      return true;
    }
    return false;
  };

  Detector.prototype.sample = function () {
    const e = this.eng, g = this.geom, D = this.D, A = g.axis, t = e.t;
    if (e.dirty) e.rebuildActive();
    const nb = this.nb;
    this.binCnt.fill(0); this.binArea.fill(0); this.binVax.fill(0); this.binSlow.fill(0);
    const slow = this.slowFlag; slow.fill(0);
    let nInside = 0, vSum = 0, nStalledIn = 0;
    const vSt = D.vStall;

    for (let k = 0; k < e.nActive; k++) {
      const b = e.active[k];
      const s = (e.x[b] - A.ox) * A.ux + (e.y[b] - A.oy) * A.uy;
      const sp = Math.hypot(e.vx[b], e.vy[b]);
      const j = Math.floor((s - this.s0) / this.binLen);
      if (j >= 0 && j < nb) {
        this.binCnt[j]++;
        this.binVax[j] += e.vx[b] * A.ux + e.vy[b] * A.uy;
        if (sp < vSt) { this.binSlow[j]++; }
      }
      // in-plane area spread over the axial extent [s - r, s + r] so large stones
      // straddling bins do not push a single bin above the physical limit
      {
        const r = e.br[b], a0 = s - r, a1 = s + r, ar = e.aPlane[b] / (a1 - a0);
        const j0 = Math.max(0, Math.floor((a0 - this.s0) / this.binLen)), j1 = Math.min(nb - 1, Math.floor((a1 - this.s0) / this.binLen));
        for (let jj = j0; jj <= j1; jj++) {
          const lo = Math.max(a0, this.s0 + jj * this.binLen), hi = Math.min(a1, this.s0 + (jj + 1) * this.binLen);
          if (hi > lo) this.binArea[jj] += ar * (hi - lo);
        }
      }
      if (e.entered[b] && !e.exited[b]) { nInside++; vSum += sp; }
      if (sp < vSt && s > this.s0 && s < this.s1) slow[b] = 1;
      if (sp < vSt && s >= 0 && s < this.s1) nStalledIn++;
    }

    // Bins: solid fraction, mean axial velocity, stalled dense zones
    let vMin = Infinity;
    this.stalledBins = [];
    for (let j = 0; j < nb; j++) {
      const area = this.binW[j] * this.binLen;
      const phi = this.binArea[j] / area;
      this.binPhi[j] = phi;
      if (phi > this.phiMax[j]) this.phiMax[j] = phi;
      if (this.binCnt[j] > 0) {
        this.binVax[j] /= this.binCnt[j];
        if (this.binMid[j] >= 0 && this.binVax[j] < vMin) vMin = this.binVax[j];
      }
      this.slowAccum[j] += this.binSlow[j] * this.sampleDt;
      if (phi >= D.phiJam && this.binCnt[j] >= 2 && Math.abs(this.binVax[j]) < vSt) {
        this.stalledBins.push(j); this.stallTime[j] += this.sampleDt;
      }
    }
    if (!isFinite(vMin)) vMin = 0;

    // Contact network of stalled particles
    const uf = this.uf;
    for (let k = 0; k < e.nActive; k++) { const b = e.active[k]; uf[b] = b; }
    for (let c = 0; c < e.cN; c++) {
      const a = e.cA[c], b = e.cB[c];
      if (slow[a] && slow[b]) {
        const ra = this.find(a), rb = this.find(b);
        if (ra !== rb) uf[ra] = rb;
      }
    }
    const comps = new Map();
    for (let k = 0; k < e.nActive; k++) {
      const b = e.active[k];
      if (!slow[b]) continue;
      const r = this.find(b);
      let cp = comps.get(r);
      if (!cp) { cp = { members: [], mask: 0, mass: 0, maxSA: -Infinity, maxSB: -Infinity }; comps.set(r, cp); }
      const s = (e.x[b] - A.ox) * A.ux + (e.y[b] - A.oy) * A.uy;
      cp.members.push(b); cp.mass += e.m[b];
      const wm = e.wallMask[b]; cp.mask |= wm;
      if (wm & 1) cp.maxSA = Math.max(cp.maxSA, s);
      if (wm & 2) cp.maxSB = Math.max(cp.maxSB, s);
    }
    // Deepest spanning structure
    let best = null;
    comps.forEach(cp => {
      if ((cp.mask & 3) !== 3) return;
      cp.sArch = Math.min(cp.maxSA, cp.maxSB);
      if (!best || cp.sArch > best.sArch) best = cp;
    });

    let arch = null;
    if (best) {
      const band = Math.max(this.dMaxGrade, 0.05);
      const sizes = [], lens = [], clsCount = {}; let single = null;
      for (const b of best.members) {
        const s = (e.x[b] - A.ox) * A.ux + (e.y[b] - A.oy) * A.uy;
        if (s >= best.sArch - band && s <= best.sArch + 0.5 * band) {
          sizes.push(e.d[b]); lens.push(e.L[b]); if (e.cls) { const k = ['equant', 'prolate', 'oblate', 'bladed', 'rounded', 'ellipsoid'][e.cls[b]]; clsCount[k] = (clsCount[k] || 0) + 1; }
          if (e.wallMask[b] === 3) single = b;
        }
      }
      // local solid fraction: highest bin value over the arch band [sArch - band, sArch]
      let phiLoc = 0;
      const ja = Math.max(0, Math.floor((best.sArch - band - this.s0) / this.binLen)), jz = Math.min(nb - 1, Math.floor((best.sArch - this.s0) / this.binLen));
      for (let jj = ja; jj <= jz; jj++) phiLoc = Math.max(phiLoc, this.binPhi[jj]);
      arch = {
        s: best.sArch, width: g.widthAt(Math.max(0, best.sArch)),
        type: single != null ? 'single' : 'arch',
        singleD: single != null ? e.d[single] : null,
        sizes: sizes.slice().sort((a, b) => b - a), lens: lens.slice().sort((a, b) => b - a),
        sGlobal: best.sArch + (g.s0Global || 0),
        nPlug: best.members.length, massPlug: best.mass, clsCount,
        phi: phiLoc, members: best.members, inFeed: best.sArch < 0
      };
    }
    this.arch = arch;

    // Time series and moving-window rates
    const T = this.ts;
    T.t.push(t); T.inM.push(e.inMass); T.outM.push(e.outMass); T.inN.push(e.inCount); T.outN.push(e.outCount);
    T.nIn.push(nInside); T.vMean.push(nInside ? vSum / nInside : 0); T.vMin.push(vMin);
    const ws = e.water ? e.water.state() : null;
    T.uw.push(ws ? ws.uWin : 0); T.Qw.push(ws ? ws.Q0 : 0);
    T.feedM.push(e.feedMass);
    let i0 = T.t.length - 1;
    while (i0 > 0 && T.t[i0 - 1] >= t - this.W - 1e-9) i0--;
    const span = t - T.t[i0];
    let inRate = 0, outRate = 0;
    if (span > 1e-9) {
      // divide by at least the full window so the first samples do not spike
      const den = Math.max(span, this.W);
      inRate = (e.inMass - T.inM[i0]) / den;
      outRate = (e.outMass - T.outM[i0]) / den;
    }
    const nominal = this.dv.nominalSliceMassRate;
    // feed acceptance over the rate window (metered feed only)
    const acc = !e.hopper && span > 1e-9 && e.massRate > 0 ? Math.min(1.5, (e.feedMass - T.feedM[i0]) / (e.massRate * span)) : null;
    T.acc.push(acc);
    if (acc !== null && t >= this.W) { this.accept = acc; this.minAccept = Math.min(this.minAccept, acc); }
    const rIO = inRate > 1e-6 ? outRate / inRate : null;
    const rON = nominal > 1e-9 ? outRate / nominal : null;
    const toTph = 3.6 / this.dv.sliceFactor; // slice kg/s -> 3D-equivalent t/h
    T.inRate.push(inRate * toTph); T.outRate.push(outRate * toTph);
    T.rIO.push(rIO); T.rON.push(rON);

    // Status
    // Warm-up: manual time, or (auto) first outlet arrival + window, capped by
    // the transit-based estimate so a pipe that never discharges is still assessed.
    let active = false;
    if (!e.gateOpen) active = false;          // restart case: column still settling on the closed gate
    else if (this.D.warmupMode === 'auto') {
      active = (e.tFirstOut >= 0 && t >= e.tFirstOut + this.W) || t >= this.warmup;
      if (active && this.tActive == null) this.tActive = t;
    } else active = t >= this.warmup;
    const feeding = e.feeding() || e.feedBlocked;
    const reasons = [];
    let lvl = 0;
    const ev = this.updateEvents(arch, t);
    if (active) {
      if (rIO !== null && rIO < D.rRestrict && feeding) { lvl = 1; reasons.push('outlet/inlet ' + rIO.toFixed(2) + ' < ' + D.rRestrict); }
      if (this.stalledBins.length) { lvl = Math.max(lvl, 1); reasons.push(this.stalledBins.length + ' dense stalled bin(s)'); }
      // inlet acceptance: share of the requested (metered) feed that the inlet takes
      if (!e.hopper && acc !== null && e.feeding()) {
        if (acc < D.rRestrict) { lvl = Math.max(lvl, 1); reasons.push('inlet accepts only ' + (acc * 100).toFixed(0) + ' % of the requested feed'); }
        if (acc <= D.rBlock) this.chokeTime += this.sampleDt; else this.chokeTime = 0;
        if (this.chokeTime >= D.tPersist) { lvl = 3; reasons.push('inlet choked for ' + this.chokeTime.toFixed(1) + ' s'); this.markInletChoke(t, this.chokeTime); }
      }
      if (arch) { lvl = Math.max(lvl, 2); reasons.push((arch.type === 'single' ? 'single-particle obstruction' : 'spanning bridge') + ' at s = ' + arch.s.toFixed(2) + ' m'); }
      if (arch && ev && (t - ev.tStart) >= D.tPersist && rON !== null && rON <= D.rBlock) {
        lvl = 3; reasons.push('bridge age ' + (t - ev.tStart).toFixed(1) + ' s with outlet/nominal ' + rON.toFixed(2));
      }
      const tSinceOut = e.tLastOut < 0 ? t - Math.max(this.tActive != null ? this.tActive : this.warmup, e.tFirstIn) : t - e.tLastOut;
      // Outflow stop: no outflow for the persistence time (or 5 mean stone
      // intervals, whichever is longer, so sparse flow is not mistaken for a
      // stop) while stalled stones remain inside the pipe.
      const tNoOut = Math.max(D.tPersist, 5 / Math.max(this.dv.partRate, 1e-6));
      if (feeding && nStalledIn > 0 && tSinceOut >= tNoOut && e.tFirstIn >= 0) {
        lvl = 3; reasons.push('no outflow for ' + tSinceOut.toFixed(1) + ' s');
        if (!arch) this.markOutflowStop(t, tSinceOut);
      }
      this.activeTime += this.sampleDt;
      this.levelTime[lvl] += this.sampleDt;
      for (let L = 1; L <= lvl; L++) if (this.firstLevelTime[L] === null) {
        this.firstLevelTime[L] = t;
        this.firstLevelMass[L] = { out: e.outMass, inn: e.inMass, spawned: e.spawnedMass, outN: e.outCount };
      }
    } else {
      reasons.push(this.D.warmupMode === 'auto' ? 'warm-up: detection starts one window after the first outlet arrival (latest ' + this.warmup.toFixed(1) + ' s)' : 'warm-up (detection starts at ' + this.warmup.toFixed(1) + ' s)');
    }
    if (ev && lvl === 3) ev.persistent = true;
    this.level = lvl; this.maxLevel = Math.max(this.maxLevel, lvl); this.reasons = reasons; this.active = active;
    T.level.push(active ? lvl : -1);
  };

  /** Match the current arch with an open event, or start a new one. */
  Detector.prototype.updateEvents = function (arch, t) {
    const D = this.D;
    let ev = this.openEv;
    if (ev && t - ev.tLast > D.breakTol) { this.closeEvent(ev); ev = this.openEv = null; }
    if (!arch) return ev;
    if (ev && ev.type !== 'outflow-stop' && Math.abs(arch.s - ev.s) <= 2 * this.dMaxGrade) {
      ev.tLast = t; ev.s = arch.s; ev.width = arch.width;
      ev.nPlugMax = Math.max(ev.nPlugMax, arch.nPlug); ev.massPlugMax = Math.max(ev.massPlugMax, arch.massPlug);
      ev.phi = Math.max(ev.phi, arch.phi);
      if (arch.type === 'single') { ev.type = 'single'; ev.singleD = arch.singleD; }
      if (arch.sizes.length > ev.sizes.length) { ev.sizes = arch.sizes.slice(0, 20); ev.lens = arch.lens.slice(0, 20); }
      ev.sGlobal = arch.sGlobal;
      ev.duration = t - ev.tStart;
      return ev;
    }
    if (ev) this.closeEvent(ev);
    ev = {
      id: this.events.length + 1, type: arch.type, tStart: t, tLast: t, tEnd: null, duration: 0,
      s: arch.s, sGlobal: arch.sGlobal, width: arch.width, sizes: arch.sizes.slice(0, 20), lens: arch.lens.slice(0, 20), singleD: arch.singleD,
      outMassStart: this.eng.outMass, inMassStart: this.eng.inMass,
      nPlugMax: arch.nPlug, massPlugMax: arch.massPlug, phi: arch.phi, persistent: false, open: true,
      inFeed: arch.inFeed
    };
    this.events.push(ev); this.openEv = ev;
    return ev;
  };

  Detector.prototype.markOutflowStop = function (t, dur) {
    const last = this.events[this.events.length - 1];
    if (last && last.type === 'outflow-stop' && last.open) { last.tLast = t; last.duration = dur; last.persistent = true; return; }
    this.events.push({ id: this.events.length + 1, type: 'outflow-stop', tStart: t - dur, tLast: t, tEnd: null,
      duration: dur, s: null, sGlobal: null, width: null, sizes: [], lens: [], outMassStart: this.eng.outMass, inMassStart: this.eng.inMass, nPlugMax: 0, massPlugMax: 0, phi: 0, persistent: true, open: true });
  };

  Detector.prototype.markInletChoke = function (t, dur) {
    const last = this.events[this.events.length - 1];
    if (last && last.type === 'inlet-choke' && last.open) { last.tLast = t; last.duration = dur; return; }
    this.events.push({ id: this.events.length + 1, type: 'inlet-choke', tStart: t - dur, tLast: t, tEnd: null, duration: dur, s: -this.geom.feedLen / 2, sGlobal: this.geom.s0Global - this.geom.feedLen / 2,
      width: this.geom.inletWidth, sizes: [], lens: [], outMassStart: this.eng.outMass, inMassStart: this.eng.inMass, nPlugMax: 0, massPlugMax: 0, phi: 0, persistent: true, open: true });
  };

  Detector.prototype.closeEvent = function (ev) {
    ev.open = false; ev.tEnd = ev.tLast; ev.duration = ev.tEnd - ev.tStart;
    if (ev.duration >= this.D.tPersist && ev.type !== 'outflow-stop') ev.persistent = ev.persistent || false;
  };

  /** Close everything and return a run classification. */
  Detector.prototype.finalize = function () {
    this.events.forEach(ev => { if (ev.open) { ev.open = false; ev.tEnd = ev.tLast; ev.duration = ev.tEnd - ev.tStart; } });
    this.openEv = null;
    const tMin = this.D.tMinBridge || 0;
    this.events.forEach(ev => { ev.transient = ev.type !== 'outflow-stop' && !ev.persistent && ev.duration < tMin; });
    const bridges = this.events.filter(ev => ev.type !== 'outflow-stop' && !ev.transient);
    let cls;
    if (this.maxLevel >= 3 || this.events.some(ev => ev.persistent)) cls = 'persistent';
    else if (bridges.length) cls = 'temporary';
    else if (this.activeTime > 0 && (this.levelTime[1] + this.levelTime[2] + this.levelTime[3]) / this.activeTime >= this.D.restrictedFrac) cls = 'restricted';
    else cls = 'free';
    let jMax = 0;
    for (let j = 1; j < this.nb; j++) if (this.slowAccum[j] > this.slowAccum[jMax]) jMax = j;
    return {
      cls, maxLevel: this.maxLevel,
      tBlock: this.firstLevelTime[3], tBridge: this.firstLevelTime[2], tRestrict: this.firstLevelTime[1],
      massAtBlock: this.firstLevelMass[3], massAtBridge: this.firstLevelMass[2],
      maxAccum: { s: this.binMid[jMax], value: this.slowAccum[jMax], width: this.binW[jMax] },
      restrictedShare: this.activeTime > 0 ? (this.levelTime[1] + this.levelTime[2] + this.levelTime[3]) / this.activeTime : 0
    };
  };

  Detector.CLASS = {
    free: { label: 'Free flow', level: 0 },
    restricted: { label: 'Restricted flow', level: 1 },
    temporary: { label: 'Temporary bridging', level: 2 },
    persistent: { label: 'Persistent blockage', level: 3 }
  };
  Detector.LEVEL = ['GREEN: free flowing', 'YELLOW: restricted / accumulation', 'ORANGE: probable bridging', 'RED: persistent blockage'];

  FP.detection = { Detector };
})(self.FP = self.FP || {});
