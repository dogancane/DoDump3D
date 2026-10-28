/* ==========================================================================
 * stats.js
 * Statistics for repeated runs (Monte Carlo over random seeds).
 *
 *  - Probability of each outcome class: p = k/n with the Wilson score 95 %
 *    interval (better coverage than the normal approximation for small n
 *    and for p near 0 or 1).
 *  - Blockage rate per discharged mass, treating persistent blockage as a
 *    Poisson process in discharged mass (Thomas & Durian 2015 argue clogging
 *    is Poissonian). Runs that did not block contribute their full discharged
 *    mass as censored exposure. Rate lambda = r / M_total with exact
 *    chi-square bounds: [chi2(0.025; 2r) / (2M), chi2(0.975; 2r+2) / (2M)].
 *    Chi-square quantiles use the Wilson-Hilferty approximation.
 *    P(blockage within mass X) = 1 - exp(-lambda X).
 * ========================================================================== */
(function (FP) {
  'use strict';

  function wilson(k, n, z) {
    z = z || 1.959964;
    if (!n) return { p: NaN, lo: NaN, hi: NaN };
    const p = k / n, z2 = z * z, den = 1 + z2 / n;
    const c = (p + z2 / (2 * n)) / den;
    const h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
    return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
  }

  /** Inverse standard normal (Acklam). */
  function probit(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628274631];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /** Chi-square quantile, Wilson-Hilferty approximation (exact for nu = 2). */
  function chi2q(p, nu) {
    if (nu <= 0) return 0;
    if (nu === 2) return -2 * Math.log(1 - p);
    const z = probit(p), a = 2 / (9 * nu);
    return nu * Math.pow(1 - a + z * Math.sqrt(a), 3);
  }

  function poissonRate(r, exposure) {
    if (!(exposure > 0)) return { rate: NaN, lo: NaN, hi: NaN };
    return { rate: r / exposure, lo: r > 0 ? chi2q(0.025, 2 * r) / (2 * exposure) : 0, hi: chi2q(0.975, 2 * r + 2) / (2 * exposure) };
  }

  function quantile(arr, q) {
    if (!arr.length) return NaN;
    const s = arr.slice().sort((a, b) => a - b), k = (s.length - 1) * q, f = Math.floor(k), c = Math.min(f + 1, s.length - 1);
    return s[f] + (s[c] - s[f]) * (k - f);
  }

  const ORDER = ['free', 'restricted', 'temporary', 'persistent'];

  /** Aggregate run summaries (one configuration, several seeds). */
  function aggregate(runs) {
    const ok = runs.filter(r => r && !r.error && r.cls);
    const n = ok.length;
    const cnt = { free: 0, restricted: 0, temporary: 0, persistent: 0 };
    ok.forEach(r => { cnt[r.cls]++; });
    const atLeast = (cls) => ok.filter(r => ORDER.indexOf(r.cls) >= ORDER.indexOf(cls)).length;
    const blocked = ok.filter(r => r.cls === 'persistent');
    // exposure: discharged mass (3D eq. t) up to blockage, or the whole run if no blockage
    let exposure = 0;
    ok.forEach(r => { exposure += r.cls === 'persistent' && r.massOutBeforeBlock != null ? r.massOutBeforeBlock : (r.massOutTotal || 0); });
    const rate = poissonRate(blocked.length, exposure);
    const tB = blocked.map(r => r.tBlock).filter(v => v != null);
    const mB = blocked.map(r => r.massOutBeforeBlock).filter(v => v != null);
    const pos = blocked.map(r => ({ s: r.blockLocation, sg: r.blockLocationGlobal, feat: r.blockFeature, dn: r.blockSizes, L: r.blockLens, n: r.blockSizes.length }));
    const featCount = {};
    blocked.forEach(r => { const f = (r.blockFeature || 'outflow stop, no spanning arch').replace(/ \(.*\)$/, ''); featCount[f] = (featCount[f] || 0) + 1; });
    const allDn = [], allL = [];
    blocked.forEach(r => { r.blockSizes.forEach(v => allDn.push(v)); (r.blockLens || []).forEach(v => allL.push(v)); });
    return {
      n, counts: cnt,
      p: { free: wilson(cnt.free, n), restricted: wilson(cnt.restricted, n), temporary: wilson(cnt.temporary, n), persistent: wilson(cnt.persistent, n),
        atLeastRestricted: wilson(atLeast('restricted'), n), atLeastTemporary: wilson(atLeast('temporary'), n) },
      exposure, rate,
      tBlock: { min: Math.min.apply(null, tB.concat([Infinity])), median: quantile(tB, 0.5), max: Math.max.apply(null, tB.concat([-Infinity])), list: tB },
      massBeforeBlock: { median: quantile(mB, 0.5), min: Math.min.apply(null, mB.concat([Infinity])), max: Math.max.apply(null, mB.concat([-Infinity])), list: mB },
      positions: pos, featCount,
      rocks: { n: allDn.length, dnMax: Math.max.apply(null, allDn.concat([-Infinity])), dnMedian: quantile(allDn, 0.5), lMax: Math.max.apply(null, allL.concat([-Infinity])), lMedian: quantile(allL, 0.5), perArch: quantile(pos.map(p => p.n), 0.5) },
      worst: ok.reduce((a, r) => ORDER.indexOf(r.cls) > ORDER.indexOf(a) ? r.cls : a, 'free'),
      flowRatio: ok.map(r => r.flowRatio)
    };
  }

  FP.stats = { wilson, chi2q, probit, poissonRate, quantile, aggregate, ORDER };
})(self.FP = self.FP || {});
