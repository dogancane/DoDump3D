/* ==========================================================================
 * particles.js
 * Seeded RNG and the stone factory (grade mass sampler + shape generator).
 * ========================================================================== */
(function (FP) {
  'use strict';

  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * factory(grade, cfg)
   *   make(rng) -> stone (see shapes.makeStone)
   *   stats     -> sample statistics used for scaling, time step and checks
   */
  function factory(grade, cfg) {
    const S = cfg.shape;
    const smp = FP.grades.sampler(grade, { dnPerD: cfg.shape.dnPerD, uniform: S.uniform });
    // Pre-sample to size the neighbour grid and gather statistics (fixed seed).
    const r = rng(12345);
    const NS = 4000;
    let sm = 0, sa = 0, sdn = 0, rmaxSub = 0, minRatio = Infinity, capped = 0, measured = 0;
    const sample = [];
    for (let i = 0; i < NS; i++) {
      const st = FP.shapes.makeStone(smp.sample(r), grade, S, r, null);
      sm += st.m; sa += st.areaPlane; sdn += st.Dn;
      st.subs.forEach(s => { rmaxSub = Math.max(rmaxSub, s[2]); });
      minRatio = Math.min(minRatio, st.m / (st.Dn / 2));
      if (st.capped) capped++; if (st.measured) measured++;
      if (i < 1500) sample.push({ m: st.m, Dn: st.Dn, L: st.L, B: st.B, T: st.T, a: st.a, b: st.b, LT: st.LT, cls: st.cls });
    }
    const maxSubR = rmaxSub * 1.15;
    const mp = massPercentile;
    const items = sample.map(s => ({ d: s.Dn, m: s.m }));
    const clsN = {}, clsM = {}; let mT = 0, lt3N = 0, lt3M = 0;
    sample.forEach(s2 => { clsN[s2.cls] = (clsN[s2.cls] || 0) + 1; clsM[s2.cls] = (clsM[s2.cls] || 0) + s2.m; mT += s2.m; if (s2.LT > 3) { lt3N++; lt3M += s2.m; } });
    Object.keys(clsN).forEach(k => { clsN[k] /= sample.length; clsM[k] /= mT; });
    const stats = {
      clsN, clsM, lt3N: lt3N / sample.length, lt3M: lt3M / mT,
      meanMass: sm / NS, meanArea: sa / NS, meanDn: sdn / NS, minRatio, maxSubR,
      cappedFrac: capped / NS, measuredFrac: measured / NS,
      Dn10: mp(items, 0.1), Dn50: mp(items, 0.5), Dn90: mp(items, 0.9),
      M50: FP.grades.massMedian(sample.map(s => s.m)),
      sample
    };
    let maxBoundR = 0;
    for (let i = 0; i < 300; i++) maxBoundR = Math.max(maxBoundR, FP.shapes.makeStone(smp.sample(r), grade, S, r, maxSubR).br);
    return {
      make: (rr) => FP.shapes.makeStone(smp.sample(rr), grade, S, rr, maxSubR),
      sampler: smp, grade, maxSubR, maxBoundR, stats,
      describe: smp.label + '. ' + FP.shapes.describe(S, grade)
    };
  }

  /** Mass-based characteristic size from a list of (d, m). */
  function massPercentile(items, frac) {
    if (!items.length) return NaN;
    const s = items.slice().sort((a, b) => a.d - b.d);
    const tot = s.reduce((a, b) => a + b.m, 0);
    let acc = 0;
    for (const it of s) { acc += it.m; if (acc >= frac * tot) return it.d; }
    return s[s.length - 1].d;
  }

  FP.particles = { rng, factory, massPercentile };
})(self.FP = self.FP || {});
