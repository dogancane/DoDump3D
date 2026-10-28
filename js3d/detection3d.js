/* ==========================================================================
 * js3d/detection3d.js
 * Blockage / bridging detector for the 3D engine. Same signals, status
 * levels, events and run classification as the 2D detector (detection.js),
 * so results compare one to one. What changes in 3D:
 *
 *   - Solid fraction per axial bin is a VOLUME fraction: stone volume in
 *     the bin over the pipe volume of the bin (2D: in-plane area fraction).
 *   - Spanning structure (arch / dome): in 2D a stalled group touching both
 *     walls spans the section. In a round pipe the wall is a ring, so the
 *     engine records the azimuth of every wall contact in 12 sectors of
 *     30 deg. A connected group of stalled stones spans the pipe when its
 *     wall contacts are NOT confined to one half of the circumference
 *     (the largest run of sectors without contact is shorter than 180 deg)
 *     and it touches at least 3 sectors. A dome that only leans on one side
 *     of the wall cannot carry the column above it; one that is supported
 *     all round can. A single stone meeting that test alone is a
 *     single-stone obstruction.
 *
 * Status levels (thresholds are user inputs, not engineering criteria)
 *   0 GREEN, 1 YELLOW, 2 ORANGE (spanning dome), 3 RED (persistent), as 2D.
 * ========================================================================== */
(function (FP) {
  'use strict';

  const NSECT = 12;
  /** True when the sector mask is not confined to a half circle. */
  function spans(mask) {
    let n = 0; for (let i = 0; i < NSECT; i++) if (mask & (1 << i)) n++;
    if (n < 3) return false;
    // largest circular run of empty sectors
    let run = 0, best = 0;
    for (let i = 0; i < 2 * NSECT; i++) {
      if (mask & (1 << (i % NSECT))) run = 0; else { run++; if (run > best) best = run; }
    }
    return best < NSECT / 2;
  }
  function nSect(mask) { let n = 0; for (let i = 0; i < NSECT; i++) if (mask & (1 << i)) n++; return n; }

  function Detector(cfg, geom, eng, dv) {
    this.cfg = cfg; this.geom = geom; this.eng = eng; this.dv = dv;
    const D = this.D = cfg.detect;
    this.sampleDt = D.sampleDt; this.warmup = dv.warmup;
    this.W = Math.max(D.window, 10 / Math.max(dv.partRate, 1e-6));
    this.dMaxGrade = 2 * eng.fac.maxBoundR;
    this.s0 = -geom.feedLen; this.s1 = geom.L;
    this.binLen = Math.max(0.02, D.binLen / 1000);
    this.nb = Math.max(1, Math.ceil((this.s1 - this.s0) / this.binLen));
    const F = (n) => new Float64Array(n);
    this.binW = F(this.nb); this.binMid = F(this.nb); this.binA = F(this.nb);
    for (let j = 0; j < this.nb; j++) {
      const sm = this.s0 + (j + 0.5) * this.binLen;
      this.binMid[j] = sm; this.binW[j] = geom.widthAt(sm); this.binA[j] = Math.PI * this.binW[j] * this.binW[j] / 4;
    }
    this.binCnt = F(this.nb); this.binVol = F(this.nb); this.binVax = F(this.nb); this.binPhi = F(this.nb);
    this.binSlow = F(this.nb);
    this.slowAccum = F(this.nb);
    this.stallTime = F(this.nb);
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

  Detector.prototype.maybeSample = function () {
    if (this.eng.t + 1e-12 >= this.nextSample) { this.sample(); this.nextSample += this.sampleDt; return true; }
    return false;
  };

  Detector.prototype.sample = function () {
    const e = this.eng, g = this.geom, D = this.D, t = e.t;
    if (e.dirty) e.rebuildActive();
    const nb = this.nb;
    this.binCnt.fill(0); this.binVol.fill(0); this.binVax.fill(0); this.binSlow.fill(0);
    const slow = this.slowFlag; slow.fill(0);
    let nInside = 0, vSum = 0, nStalledIn = 0;
    const vSt = D.vStall;

    for (let k = 0; k < e.nActive; k++) {
      const b = e.active[k];
      const s = e.pz[b];
      const sp = Math.sqrt(e.vx[b] * e.vx[b] + e.vy[b] * e.vy[b] + e.vz[b] * e.vz[b]);
      const j = Math.floor((s - this.s0) / this.binLen);
      if (j >= 0 && j < nb) {
        this.binCnt[j]++;
        this.binVax[j] += e.vz[b];
        if (sp < vSt) this.binSlow[j]++;
      }
      {
        const r = e.br[b], a0 = s - r, a1 = s + r, dens = e.vol[b] / (a1 - a0);
        const j0 = Math.max(0, Math.floor((a0 - this.s0) / this.binLen)), j1 = Math.min(nb - 1, Math.floor((a1 - this.s0) / this.binLen));
        for (let jj = j0; jj <= j1; jj++) {
          const lo = Math.max(a0, this.s0 + jj * this.binLen), hi = Math.min(a1, this.s0 + (jj + 1) * this.binLen);
          if (hi > lo) this.binVol[jj] += dens * (hi - lo);
        }
      }
      if (e.entered[b] && !e.exited[b]) { nInside++; vSum += sp; }
      if (sp < vSt && s > this.s0 && s < this.s1) slow[b] = 1;
      if (sp < vSt && s >= 0 && s < this.s1) nStalledIn++;
    }

    let vMin = Infinity;
    this.stalledBins = [];
    for (let j = 0; j < nb; j++) {
      const phi = this.binVol[j] / (this.binA[j] * this.binLen);
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

    // contact network of stalled stones
    const uf = this.uf;
    for (let k = 0; k < e.nActive; k++) { const b = e.active[k]; uf[b] = b; }
    for (let c = 0; c < e.cN; c++) {
      const a = e.cA[c], b = e.cB[c];
      if (slow[a] && slow[b]) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) uf[ra] = rb; }
    }
    const comps = new Map();
    for (let k = 0; k < e.nActive; k++) {
      const b = e.active[k];
      if (!slow[b]) continue;
      const r = this.find(b);
      let cp = comps.get(r);
      if (!cp) { cp = { members: [], mask: 0, mass: 0, sWall: -Infinity }; comps.set(r, cp); }
      cp.members.push(b); cp.mass += e.m[b];
      const wm = e.wallMask[b];
      if (wm) { cp.mask |= wm; cp.sWall = Math.max(cp.sWall, e.pz[b]); }
    }
    let best = null;
    comps.forEach(cp => {
      if (!spans(cp.mask)) return;
      cp.sArch = cp.sWall;
      if (!best || cp.sArch > best.sArch) best = cp;
    });

    let arch = null;
    if (best) {
      const band = Math.max(this.dMaxGrade, 0.05);
      const sizes = [], lens = [], clsCount = {}; let single = null;
      for (const b of best.members) {
        const s = e.pz[b];
        if (s >= best.sArch - band && s <= best.sArch + 0.5 * band) {
          sizes.push(e.d[b]); lens.push(e.L[b]);
          const kc = FP.physics3d.Engine.CLS[e.cls[b]]; clsCount[kc] = (clsCount[kc] || 0) + 1;
          if (spans(e.wallMask[b])) single = b;
        }
      }
      let phiLoc = 0;
      const ja = Math.max(0, Math.floor((best.sArch - band - this.s0) / this.binLen)), jz = Math.min(nb - 1, Math.floor((best.sArch - this.s0) / this.binLen));
      for (let jj = ja; jj <= jz; jj++) phiLoc = Math.max(phiLoc, this.binPhi[jj]);
      arch = {
        s: best.sArch, width: g.widthAt(Math.max(0, best.sArch)),
        type: single != null ? 'single' : 'arch',
        singleD: single != null ? e.d[single] : null,
        singleLBT: single != null ? [e.L[single], e.Bd[single], e.Td[single]] : null,
        sizes: sizes.slice().sort((a, b) => b - a), lens: lens.slice().sort((a, b) => b - a),
        sGlobal: best.sArch + (g.s0Global || 0),
        nPlug: best.members.length, massPlug: best.mass, clsCount, sectors: nSect(best.mask), mask: best.mask,
        phi: phiLoc, members: best.members, inFeed: best.sArch < 0
      };
    }
    this.arch = arch;

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
      const den = Math.max(span, this.W);
      inRate = (e.inMass - T.inM[i0]) / den;
      outRate = (e.outMass - T.outM[i0]) / den;
    }
    const nominal = this.dv.nominalSliceMassRate;
    const acc = !e.hopper && span > 1e-9 && e.massRate > 0 ? Math.min(1.5, (e.feedMass - T.feedM[i0]) / (e.massRate * span)) : null;
    T.acc.push(acc);
    if (acc !== null && t >= this.W) { this.accept = acc; this.minAccept = Math.min(this.minAccept, acc); }
    const rIO = inRate > 1e-6 ? outRate / inRate : null;
    const rON = nominal > 1e-9 ? outRate / nominal : null;
    T.inRate.push(inRate * 3.6); T.outRate.push(outRate * 3.6);
    T.rIO.push(rIO); T.rON.push(rON);

    let active = false;
    if (!e.gateOpen) active = false;
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
      if (!e.hopper && acc !== null && e.feeding()) {
        if (acc < D.rRestrict) { lvl = Math.max(lvl, 1); reasons.push('inlet accepts only ' + (acc * 100).toFixed(0) + ' % of the requested feed'); }
        if (acc <= D.rBlock) this.chokeTime += this.sampleDt; else this.chokeTime = 0;
        if (this.chokeTime >= D.tPersist) { lvl = 3; reasons.push('inlet choked for ' + this.chokeTime.toFixed(1) + ' s'); this.markInletChoke(t, this.chokeTime); }
      }
      if (arch) { lvl = Math.max(lvl, 2); reasons.push((arch.type === 'single' ? 'single-stone obstruction' : 'spanning dome') + ' at s = ' + arch.s.toFixed(2) + ' m (' + arch.sectors + ' of 12 wall sectors)'); }
      if (arch && ev && (t - ev.tStart) >= D.tPersist && rON !== null && rON <= D.rBlock) {
        lvl = 3; reasons.push('dome age ' + (t - ev.tStart).toFixed(1) + ' s with outlet/nominal ' + rON.toFixed(2));
      }
      const tSinceOut = e.tLastOut < 0 ? t - Math.max(this.tActive != null ? this.tActive : this.warmup, e.tFirstIn) : t - e.tLastOut;
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

  Detector.prototype.updateEvents = FP.detection.Detector.prototype.updateEvents;
  Detector.prototype.markOutflowStop = FP.detection.Detector.prototype.markOutflowStop;
  Detector.prototype.markInletChoke = FP.detection.Detector.prototype.markInletChoke;
  Detector.prototype.closeEvent = FP.detection.Detector.prototype.closeEvent;
  Detector.prototype.finalize = FP.detection.Detector.prototype.finalize;
  Detector.CLASS = FP.detection.Detector.CLASS;
  Detector.LEVEL = FP.detection.Detector.LEVEL;

  FP.detection3d = { Detector, spans, NSECT };
})(self.FP = self.FP || {});
