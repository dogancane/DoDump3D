/* ==========================================================================
 * js3d/particles3d.js
 * 3D stone factory: grade mass sampler (shared with 2D) + 3D clump builder.
 * Same interface as FP.particles.factory, so the shared checks and unit
 * validation can read its statistics.
 * ========================================================================== */
(function (FP) {
  'use strict';

  function factory(grade, cfg) {
    const S = cfg.shape;
    const smp = FP.grades.sampler(grade, { dnPerD: cfg.shape.dnPerD, uniform: S.uniform });
    const r = FP.particles.rng(12345);
    const NS = 3000;
    let errSum = 0, errMax = 0, covMin = 1, pBlock = null, sm = 0, sv = 0, sdn = 0, rmaxSub = 0, minRatio = Infinity, minRatioRot = Infinity, capped = 0, measured = 0, nSub = 0;
    const sample = [];
    for (let i = 0; i < NS; i++) {
      const st = FP.shapes3d.makeStone(smp.sample(r), grade, S, r, null);
      sm += st.m; sv += st.vol; sdn += st.Dn; nSub += st.subs.length;
      st.subs.forEach(s => { rmaxSub = Math.max(rmaxSub, s[3]); });
      minRatio = Math.min(minRatio, st.m / (st.Dn / 2));
      // effective mass at the most exposed contact, including rotation about each body axis
      let dI = 0;
      for (let ax = 0; ax < 3; ax++) {
        let d2 = 0;
        st.subs.forEach(q => { const o = [q[0], q[1], q[2]]; o[ax] = 0; const d = Math.hypot(o[0], o[1], o[2]) + q[3]; d2 = Math.max(d2, d * d); });
        dI = Math.max(dI, d2 / st.I[ax]);
      }
      minRatioRot = Math.min(minRatioRot, 1 / (1 / st.m + dI) / (st.Dn / 2));
      errSum += st.fitErr || 0; errMax = Math.max(errMax, st.fitErr || 0); covMin = Math.min(covMin, st.fitCover == null ? 1 : st.fitCover); if (st.boxLike) pBlock = st.pexp;
      if (st.capped) capped++; if (st.measured) measured++;
      if (i < 1500) sample.push({ m: st.m, Dn: st.Dn, L: st.L, B: st.B, T: st.T, LT: st.LT, cls: st.cls });
    }
    const maxSubR = rmaxSub * 1.1;
    const items = sample.map(s => ({ d: s.Dn, m: s.m }));
    const mp = FP.particles.massPercentile;
    const clsN = {}, clsM = {}; let mT = 0, lt3N = 0, lt3M = 0;
    sample.forEach(s2 => { clsN[s2.cls] = (clsN[s2.cls] || 0) + 1; clsM[s2.cls] = (clsM[s2.cls] || 0) + s2.m; mT += s2.m; if (s2.LT > 3) { lt3N++; lt3M += s2.m; } });
    Object.keys(clsN).forEach(k => { clsN[k] /= sample.length; clsM[k] /= mT; });
    const stats = {
      clsN, clsM, lt3N: lt3N / sample.length, lt3M: lt3M / mT,
      meanMass: sm / NS, meanVol: sv / NS, meanDn: sdn / NS, meanSubs: nSub / NS,
      meanArea: Math.pow(sv / NS, 2 / 3), // placeholder for shared code that expects it (not used in 3D)
      minRatio, minRatioRot, maxSubR, fitErrMean: errSum / NS, fitErrMax: errMax, fitCoverMin: covMin,
      cappedFrac: capped / NS, measuredFrac: measured / NS,
      Dn10: mp(items, 0.1), Dn50: mp(items, 0.5), Dn90: mp(items, 0.9),
      M50: FP.grades.massMedian(sample.map(s => s.m)),
      sample
    };
    FP.shapes3d.saveTemplates();
    let maxBoundR = 0;
    for (let i = 0; i < 400; i++) maxBoundR = Math.max(maxBoundR, FP.shapes3d.makeStone(smp.sample(r), grade, S, r, maxSubR).br);
    return {
      make: (rr) => FP.shapes3d.makeStone(smp.sample(rr), grade, S, rr, maxSubR),
      sampler: smp, grade, maxSubR, maxBoundR, stats, pBlock: pBlock || FP.shapes3d.pOfVf((grade.shape && grade.shape.vfBlock) || 0.6),
      describe: smp.label + '. ' + FP.shapes3d.describe(S, grade)
    };
  }

  FP.particles3d = { factory };
})(self.FP = self.FP || {});
