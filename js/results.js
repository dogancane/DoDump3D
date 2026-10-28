/* ==========================================================================
 * results.js
 * Run summaries, the in-browser run store and comparison data.
 * Masses in the slice are converted to 3D-equivalent tonnes by dividing by
 * the slice factor; that conversion inherits the slice-scaling assumption.
 * ========================================================================== */
(function (FP) {
  'use strict';

  const KEY = 'fallpipe.runs.v2';

  function geometryText(cfg, geom) {
    if (cfg.pipe.type === 'bucket') {
      const S = cfg.pipe.string, str = geom.string, w = geom.window;
      const T = S.types.find(t => t.id === S.defaultType) || S.types[0];
      return str.totals.nStacks + ' stacks, ' + str.totals.nBuckets + ' buckets (type ' + T.name + ': ID ' + T.dTop + ' to ' + T.dBot + ' mm, H ' + T.h + ' mm, insertion ' + T.ins + ' mm, t ' + T.t + ' mm, ' + T.mat + '), string ' + str.totals.length.toFixed(1) + ' m; DEM window buckets ' + w.start + ' to ' + w.end + ' (' + geom.L.toFixed(2) + ' m from ' + geom.s0Global.toFixed(2) + ' m)';
    }
    const I = cfg.pipe.inclined;
    return 'ID ' + I.d + ' mm, L ' + I.L + ' mm, ' + I.angle + ' deg from ' + I.angleRef + ', ' + I.mat;
  }

  function summarize(cfg, geom, dv, eng, det, fin, fac) {
    const ins = eng.insideCount(), alive = eng.aliveMass();
    const bridges = det.events.filter(e => e.type !== 'outflow-stop' && !e.transient);
    const key = det.events.find(e => e.persistent) || bridges[0] || null;
    const to3D = (kg) => kg == null ? null : kg / dv.sliceFactor / 1000; // slice kg -> 3D-equivalent t
    const mb = fin.massAtBlock;
    return {
      id: Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      when: new Date().toISOString(),
      seed: eng.seedUsed != null ? eng.seedUsed : cfg.run.seed,
      pipeType: cfg.pipe.type === 'bucket' ? 'Moonpool bucket' : 'Inclined side pipe',
      geometry: geometryText(cfg, geom),
      minPassage: geom.minPassage, s0Global: geom.s0Global || 0,
      grade: cfg.grade.name, gradeId: cfg.grade.id,
      rho: cfg.grade.rho,
      shape: fac.describe,
      realized: { dn10: fac.stats.Dn10 * 1000, dn50: fac.stats.Dn50 * 1000, dn90: fac.stats.Dn90 * 1000, m50: fac.stats.M50, meanMass: fac.stats.meanMass },
      flow: (cfg.feed.mode === 'mass' ? cfg.feed.massFlow + ' t/h nominal' : cfg.feed.partRate + ' stones/s (slice)') + ', continuous' + (cfg.feed.maxStones > 0 ? ' up to ' + cfg.feed.maxStones + ' stones' : '') + ', v0 ' + dv.v0.toFixed(2) + ' m/s',
      medium: !cfg.physics.fluid ? 'No fluid' : (cfg.water && cfg.water.model === 'coupled' ? 'Water, coupled entrained flow' + (cfg.water.leakage ? ' with joint leakage' : ', sealed joints') : 'Still water') + ', rho ' + cfg.physics.rhoF + ' kg/m3, Cd ' + cfg.physics.cd + ', Ca ' + (cfg.water ? cfg.water.Ca : 0) + (cfg.water && cfg.water.hindered ? ', Di Felice hindrance' : ''),
      water: eng.water && eng.water.on ? waterSummary(det, eng) : null,
      feedMode: cfg.feed.mode, prefilled: eng.prefilled || 0, prefillMass: eng.prefillMass ? to3D(eng.prefillMass) : 0,
      feedAccepted: cfg.feed.mode !== 'hopper' && eng.massRate > 0 && eng.t > 0 ? eng.feedMass / (eng.massRate * eng.t) : null,
      feedAcceptMin: det.minAccept < 1 ? det.minAccept : null,
      achievedInflow: eng.t > 0 ? eng.feedMass / eng.t * dv.toTph : null, // t/h 3D equivalent
      duration: eng.t,
      cls: fin.cls, clsLabel: FP.detection.Detector.CLASS[fin.cls].label,
      maxLevel: fin.maxLevel,
      tBlock: fin.tBlock, tBridge: fin.tBridge, tRestrict: fin.tRestrict,
      massOutBeforeBlock: mb ? to3D(mb.out) : null, massInBeforeBlock: mb ? to3D(mb.inn) : null, stonesOutBeforeBlock: mb ? mb.outN : null,
      massOutTotal: to3D(eng.outMass), massInTotal: to3D(eng.inMass), massReleased: to3D(eng.spawnedMass),
      blockLocation: key && key.s != null ? key.s : null,
      blockLocationGlobal: key && key.sGlobal != null ? key.sGlobal : null,
      blockWidth: key && key.width != null ? key.width : null,
      blockType: key ? key.type : null,
      blockSizes: key ? key.sizes.map(v => v * 1000) : [],
      blockLens: key && key.lens ? key.lens.map(v => v * 1000) : [],
      blockDuration: key ? key.duration : null,
      blockParticles: key ? key.nPlugMax : 0, blockMass: key ? key.massPlugMax : 0,
      blockFeature: key && key.s != null ? nearestFeature(geom, key.s) : null,
      events: det.events.map(e => Object.assign({}, e)),
      spawned: eng.spawned, entered: eng.inCount, exited: eng.outCount, inside: ins.n, lost: eng.lostCount,
      flowRatio: eng.inMass > 0 ? eng.outMass / eng.inMass : null,
      maxAccum: fin.maxAccum,
      restrictedShare: fin.restrictedShare,
      dt: dv.dt, kn: dv.kn, maxOverlap: eng.maxOverlapRun, capacityWait: eng.capacityWait, cap: eng.cap, peakBodies: eng.peakBodies,
      aliveN: alive.n - alive.nExitedAlive,
      sliceFactor: dv.sliceFactor,
      cfg: FP.config.clone(cfg)
    };
  }

  function waterSummary(det, eng) {
    const T = det.ts, n = T.t.length, w = eng.water.state();
    // mean over the second half of the run (after start-up)
    let su = 0, sq = 0, k = 0;
    for (let i = Math.floor(n / 2); i < n; i++) { su += T.uw[i]; sq += T.Qw[i]; k++; }
    return { uWinMean: k ? su / k : 0, QinMean: k ? sq / k : 0, uTopEnd: w.uTop, QoutEnd: w.Qout, qGapEnd: w.qGap, pTopEnd: w.pTop, forcePerM: w.forcePerM, Ltot: w.Ltot, nGaps: w.nGaps };
  }

  function nearestFeature(geom, s) {
    if (s == null || !geom) return '-';
    if (s < 0) return geom.feedTopWidth > geom.inletWidth + 1e-6 ? 'Feed funnel above the pipe inlet' : 'Feed zone above the pipe inlet';
    let best = null, bd = Infinity;
    geom.features.forEach(f => {
      if (f.kind === 'ledge') return;
      const d = f.kind === 'overlap' ? (s >= f.s && s <= f.s2 ? 0 : Math.min(Math.abs(s - f.s), Math.abs(s - f.s2))) : Math.abs(s - f.s);
      if (d < bd) { bd = d; best = f; }
    });
    return best ? best.label + (bd > 0 ? ' (' + bd.toFixed(2) + ' m away)' : ' (inside)') : '-';
  }

  function load() {
    try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : []; } catch (e) { return []; }
  }
  function save(list) {
    try {
      // drop bulky config copies of older runs to stay within storage limits
      const trimmed = list.slice(-80).map((r, i, a) => i < a.length - 30 ? Object.assign({}, r, { cfg: null }) : r);
      localStorage.setItem(KEY, JSON.stringify(trimmed));
    } catch (e) { /* storage unavailable */ }
  }

  const store = {
    runs: (typeof localStorage !== 'undefined') ? load() : [],
    add(r) { this.runs.push(r); save(this.runs); },
    remove(id) { this.runs = this.runs.filter(r => r.id !== id); save(this.runs); },
    clear() { this.runs = []; save(this.runs); }
  };

  FP.results = { summarize, store, geometryText, nearestFeature };
})(self.FP = self.FP || {});
