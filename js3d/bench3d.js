/* ==========================================================================
 * js3d/bench3d.js
 * Validation benchmark for the 3D engine: clogging of a flat-bottomed silo
 * discharging identical dry spheres through a round orifice.
 *
 * Reference: Zuriguel et al. (2005), Phys. Rev. E 71, 051303, and the
 * review by Zuriguel (2014): in 3D silos of spheres the mean number of
 * grains discharged before a jam grows steeply with D/d and jams are no
 * longer observed above about D/d = 4.9 (spheres; rice-shaped grains need
 * about 6.2). At D/d = 3 jams form after a few to a few tens of grains.
 * The test checks this trend with the same contact model, integrator and
 * walls as the fall-pipe runs. It does not test water forces or rock shape.
 *
 * Case: silo radius D/2 + 3.5 d, height 7 d, flat bottom plate with a central
 * orifice of diameter D, closed by a gate while the random fill settles
 * (3 s), then opened. When outflow stops for 3 s, the run is a jam if grains
 * still stand in the column over the orifice (at least 3: a loaded arch);
 * otherwise the silo has emptied down to
 * its dead zone (grains resting on the flat bottom around the orifice) and
 * the run counts as no jam. Friction 0.5, restitution 0.5, rolling
 * resistance 0.02, no fluid.
 * ========================================================================== */
(function (FP) {
  'use strict';

  const CASES = [3, 4, 6];
  const SEEDS = 6;

  function buildCase(ratio) {
    const cfg = FP.config3d.defaultConfig();
    cfg.physics.fluid = false; cfg.physics.precision = 'high';
    cfg.physics.muPP = 0.5; cfg.physics.ePP = 0.5; cfg.physics.muRollPP = 0.02;
    cfg.physics.wallContactFrom = 'global'; cfg.physics.muPW = 0.5; cfg.physics.ePW = 0.5; cfg.physics.muRollPW = 0.02;
    cfg.physics.wallStiffMode = 'same';
    cfg.shape.mode = 'sphere'; cfg.shape.uniform = true;
    cfg.feed.mode = 'count'; cfg.feed.partRate = 1e-9; cfg.feed.prefill = true; cfg.feed.settle = 3; cfg.feed.source = 'drop';
    cfg.pipe.dryLen = 0; cfg.vessel.on = false;
    // sphere size from the default grade at M50 (uniform stones)
    const fac0 = FP.particles3d.factory(cfg.grade, cfg);
    const d = fac0.stats.sample[0].Dn * Math.cbrt(6 / Math.PI);
    const D = ratio * d, R = D / 2 + 3.5 * d, H = 7 * d;
    cfg.pipe.type = 'inclined';
    cfg.pipe.inclined = { d: 2 * R * 1000, L: H * 1000, angle: 90, angleRef: 'horizontal', t: 20, mat: 'S355' };
    cfg.pipe.feedLen = 300; cfg.pipe.funnel = { on: false, topWidth: 3000 };
    cfg.run.duration = 120;
    const geom = FP.geometry3d.build(cfg);
    // replace the walls: silo wall, bottom plate with orifice, gate under the orifice, lid above
    const t = 0.03, W = [];
    const quad = (pts, meta) => { for (let i = 0; i < 4; i++) { const p = pts[i], q = pts[(i + 1) % 4]; W.push(Object.assign({ s1: p[0], r1: p[1], s2: q[0], r2: q[1], mat: 0, bucket: 0 }, meta || {})); } };
    quad([[-0.3, R], [H, R], [H, R + t], [-0.3, R + t]]);
    quad([[H, D / 2], [H, R + t], [H + t, R + t], [H + t, D / 2]]);
    quad([[H + t, 0], [H + t, D / 2 + 0.1 * d], [H + 2 * t, D / 2 + 0.1 * d], [H + 2 * t, 0]], { gate: true, bucket: -2 });
    quad([[-0.3 - t, 0], [-0.3 - t, R + t], [-0.3, R + t], [-0.3, 0]], { bucket: -1 });
    geom.wsegs = W; geom.L = H; geom.exitS = H + 3 * d;
    geom.box = { r: R + 0.4, z0: -0.7, z1: geom.exitS + 0.3 };
    geom.widthAt = () => 2 * R; geom.rAt = () => R; geom.gAt = () => [0, 1];
    let vol = Math.PI * R * R * H; geom.volume = vol;
    const fac = FP.particles3d.factory(cfg.grade, cfg);
    const dv = FP.config3d.derive(cfg, geom, fac);
    dv.cap = Math.min(4000, Math.ceil(vol * 0.7 / fac.stats.meanVol + 60));
    return { cfg, geom, fac, dv, d, D, R, H, ratio };
  }

  /** One benchmark run; returns { ratio, seed, jammed, nOut, nFill, tJam }. */
  function runCase(bench, seed, onProgress) {
    const C = buildCase(bench.ratio);
    const e = new FP.physics3d.Engine(C.cfg, C.geom, C.fac, C.dv, seed);
    let lastP = 0, nFill = 0, jammed = false, tJam = null;
    const tMax = 90;
    while (e.t < tMax) {
      for (let i = 0; i < 200; i++) e.step();
      if (e.gateOpen && !nFill) nFill = e.nActive;
      if (e.gateOpen) {
        if (e.dirty) e.rebuildActive();
        // grains over the orifice (an arch, or grains still flowing into it); the ring resting on the flat
        // bottom outside the orifice is the silo's dead zone and does not count
        let over = 0;
        for (let k = 0; k < e.nActive; k++) { const b = e.active[k]; if (e.pz[b] < C.H && Math.hypot(e.px[b], e.py[b]) < C.D / 2) over++; }
        const tOpen = e.settleTime, tLast = e.tLastOut < 0 ? tOpen : Math.max(tOpen, e.tLastOut);
        if (e.t - tLast > 3) { if (over >= 3) { jammed = true; tJam = tLast; } break; }   // >= 3 grains in the column over the orifice: a loaded arch   // no outflow for 3 s: jam if grains still span the orifice, else empty
      }
      if (onProgress && e.t - lastP > 1) { lastP = e.t; onProgress(Math.min(0.99, e.t / 40)); }
    }
    return { ratio: bench.ratio, seed, jammed, nOut: e.outCount, nFill, tJam, d: C.d, D: C.D, maxOverlap: e.maxOverlapRun, lost: e.lostCount };
  }

  /** Expected trend (pass criteria) per D/d. */
  const EXPECT = {
    3: { maxNoJam: 0.25, text: 'jams in most runs (Zuriguel 2005: a few to a few tens of grains per avalanche)' },
    4: { text: 'fewer jams than at 3; in a silo this small (about 300 grains) most runs empty before a jam' },
    6: { maxJam: 0.25, text: 'no jams in most runs (none observed above about 4.9 for spheres)' }
  };

  function judge(results) {
    const by = {};
    results.forEach(r => { if (!r || r.error) return; (by[r.ratio] = by[r.ratio] || []).push(r); });
    const rows = CASES.map(k => {
      const L = by[k] || [], n = L.length, nj = L.filter(r => r.jammed).length;
      const outs = L.filter(r => r.jammed).map(r => r.nOut).sort((a, b) => a - b);
      const ex = EXPECT[k];
      let pass = null;
      if (n) {
        if (ex.maxNoJam != null) pass = (n - nj) / n <= ex.maxNoJam;
        if (ex.maxJam != null) pass = nj / n <= ex.maxJam;
      }
      return { ratio: k, n, jams: nj, medianOut: outs.length ? outs[Math.floor(outs.length / 2)] : null, fill: n ? Math.round(L.reduce((a, r) => a + r.nFill, 0) / n) : null, pass, expect: ex.text };
    });
    // trend: the share of runs that jam must not grow with D/d
    const fr = rows.filter(r => r.n).map(r => r.jams / r.n);
    const trend = fr.length === rows.length ? fr.every((v, i) => i === 0 || v <= fr[i - 1] + 1e-9) : null;
    return { rows, trend };
  }

  function jobs() { const J = []; CASES.forEach(k => { for (let s = 1; s <= SEEDS; s++) J.push({ kind: 'bench', bench: { ratio: k }, seed: s * 101 + k }); }); return J; }

  FP.bench3d = { CASES, SEEDS, buildCase, runCase, judge, jobs, EXPECT };
})(self.FP = self.FP || {});
