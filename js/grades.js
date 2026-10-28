/* ==========================================================================
 * grades.js
 * Rock grade library and mass samplers.
 *
 * DATA RULES
 *   - Values are entered exactly as given in the source; nothing is estimated.
 *     Fields with no source value are null and shown as "not given".
 *   - Values derived from given data are marked as derived and show the rule
 *     (for example Dn = (M / rho)^(1/3)).
 *
 * SOURCES
 *   T1  User grade tables (Oct 2026): LMA 10/60, LMA 60/300, LMA 40/200
 *       (ELL/NLL/NUL/EUL mass, nominal diameter Dn, maximum expected length,
 *       and for 40/200 also the sphere diameter Ds).
 *   T2  User class table "described in EN 13383": range, M50 range for
 *       category A, D50 range (cm), D85/D15, Dn50 (cm).
 *   S1  prEN 13383-1:2021 (CEN enquiry draft, June 2021): Table 1 coarse
 *       grading sieve envelopes, Table 2 LMA and Table 3 LMB mass limits.
 *       Draft standard, subject to change.
 *   B1  User batch test LMA_40-200_batch_test.xlsx (200 weighed stones).
 *       Light-grading tolerances (<ELL 0-2 %, <NLL 0-10 %, <NUL 70-100 %,
 *       <EUL 97-100 % by mass) are taken from this sheet.
 *
 * DERIVED (from the data above, shown in the UI)
 *   - rho = 2650 kg/m3 reproduces every Dn in T1 to within rounding.
 *   - Lmax / Dn = 1.80 for every limit in T1.
 *   - Dn50 / D50(mid) = 0.82 to 0.86 in T2, i.e. the class-table D50 is a
 *     sieve-type size with Dn ~ 0.84 D.
 *
 * SAMPLING
 *   A grade yields a NUMBER sampler of stone MASS (kg):
 *   'empirical' : bootstrap from measured masses (optionally log-smoothed)
 *   'envelope'  : a curve chosen inside the standard's envelope
 *                 (fine edge, mid, coarse edge, or the curve that matches the
 *                 Mem midpoint). Envelopes are % passing BY MASS, converted
 *                 to number weights by dividing each mass increment by its
 *                 stone mass. Tails outside the outermost limits are truncated.
 *   'dvalues'   : legacy D-value curve (Dmin, D10, D50, D90, Dmax as Dn, mm)
 * ========================================================================== */
(function (FP) {
  'use strict';

  const TOL_LM = { ELL: [0, 2], NLL: [0, 10], NUL: [70, 100], EUL: [97, 100] }; // % lighter than, by mass (B1)
  const REV = 'R1 2026-10-14';

  function lm(id, name, fam, lims, cls, extra) {
    return Object.assign({
      id, name, family: fam, kind: 'mass', revision: REV,
      nominal: { lower: lims.NLL.m, upper: lims.NUL.m, unit: 'kg' },
      limits: ['ELL', 'NLL', 'NUL', 'EUL'].map(k => ({ name: k, mass: lims[k].m, Dn: lims[k].Dn == null ? null : lims[k].Dn, Lmax: lims[k].L == null ? null : lims[k].L, Ds: lims[k].Ds == null ? null : lims[k].Ds, pass: TOL_LM[k], src: lims[k].src })),
      classTable: cls,
      rho: 2650, rhoSrc: 'derived: reproduces the Dn values in the user grade tables (Dn = (M/rho)^(1/3))',
      bulkDensity: null, bulkSrc: 'not given',
      LmaxRatio: null, LmaxSrc: 'not given',
      shape: defaultShape(),
      measured: null,
      dist: { mode: 'envelope', pos: 'mem', smoothing: 0 }
    }, extra || {});
  }

  function cp(id, name, sieves, cls, extra) {
    return Object.assign({
      id, name, family: 'CP', kind: 'sieve', revision: REV,
      nominal: { lower: +name.match(/(\d+)\s*\/\s*(\d+)/)[1], upper: +name.match(/(\d+)\s*\/\s*(\d+)/)[2], unit: 'mm' },
      sieves: sieves.map(s => ({ size: s[0], pass: [s[1], s[2]] })),
      sieveSrc: 'S1 prEN 13383-1:2021 Table 1 (draft)',
      classTable: cls,
      rho: 2650, rhoSrc: 'derived: consistent with Dn50 and M50 in the user class table (same value as the LMA tables)',
      bulkDensity: null, bulkSrc: 'not given',
      LmaxRatio: null, LmaxSrc: 'not given',
      shape: defaultShape(),
      measured: null,
      dist: { mode: 'envelope', pos: 'mid', smoothing: 0 }
    }, extra || {});
  }

  function defaultShape() {
    // ASSUMPTION: no measured shape data for the grade. Editable.
    return { LTmean: 2.0, LTsd: 0.4, LTmin: 1.0, LTmax: 3.5, phi: 0.5, irregular: 0.15, src: 'assumption (no measured L/B/T for this grade)', measuredSub: null,
      // shape-class mix (Zingg classes), percent. ASSUMPTION guided by Domokos et al. 2020 (fragments
      // cube-like on average) and Rock Manual 3.4.1.6 (L/T > 3 typically < 5 % heavy, < 20 % light)
      mix: { equant: 55, prolate: 15, oblate: 15, bladed: 10, rounded: 5 },
      mixSrc: 'assumption guided by Domokos et al. 2020 and Rock Manual 3.4.1.6; replace with measured L/B/T',
      vfBlock: 0.6, corner: 0.3, classLTmax: null };
  }

  const T2 = (m50, d50, r, dn50) => ({ M50: m50, D50cm: d50, D85D15: r, Dn50cm: dn50, src: 'T2 user class table' });

  const LIBRARY = [
    cp('cp32-90', 'CP 32/90', [[16, 0, 5], [31.5, 0, 15], [45, 0, 50], [90, 90, 100], [125, 98, 100], [180, 100, 100]],
      null, { notes: 'Not in the user snippet. Sieve envelope from prEN 13383-1:2021 (draft). No M50, D50, D85/D15 or Dn50 given.' }),
    cp('cp45-125', 'CP 45/125', [[22.4, 0, 5], [45, 0, 15], [63, 0, 50], [125, 90, 100], [180, 98, 100], [250, 100, 100]], T2([0.4, 1.2], [6.3, 9.0], 2.8, 6.4)),
    cp('cp45-180', 'CP 45/180', [[22.4, 0, 5], [45, 0, 15], [63, 0, 50], [180, 90, 100], [250, 98, 100], [360, 100, 100]], T2([0.4, 1.2], [6.3, 9.0], 4.0, 6.4)),
    cp('cp63-180', 'CP 63/180', [[31.5, 0, 5], [63, 0, 15], [90, 0, 50], [180, 90, 100], [250, 98, 100], [360, 100, 100]], T2([1.2, 3.1], [9.0, 12.5], 2.8, 9)),
    cp('cp90-180', 'CP 90/180', [[45, 0, 5], [90, 0, 20], [180, 80, 100], [250, 98, 100], [360, 100, 100]], T2([2.1, 2.8], [11, 12], 2.0, 9.7),
      { notes: 'prEN 13383-1:2021 note: the fraction between the 90 mm and 180 mm sieves shall be at least 80 % by mass.' }),
    cp('cp90-250', 'CP 90/250', [[45, 0, 5], [90, 0, 15], [125, 0, 50], [250, 90, 100], [360, 98, 100], [500, 100, 100]], T2([3.1, 9.3], [12.5, 18], 2.8, 12.8)),
    lm('lma5-40', 'LMA 5/40', 'LMA', { ELL: { m: 1.5, src: 'S1' }, NLL: { m: 5, src: 'S1' }, NUL: { m: 40, src: 'S1' }, EUL: { m: 80, src: 'S1' } },
      T2([10, 20], [18, 23], 1.7, 17), { Mem: [10, 20], MemSrc: 'S1 Table 2', notes: 'In the class table snippet but not in the requested list. Mass limits from prEN 13383-1:2021 (draft). No Dn or Lmax table given.' }),
    lm('lma10-60', 'LMA 10/60', 'LMA', {
      ELL: { m: 2, Dn: 91, L: 164, src: 'T1' }, NLL: { m: 10, Dn: 156, L: 281, src: 'T1' }, NUL: { m: 60, Dn: 283, L: 509, src: 'T1' }, EUL: { m: 120, Dn: 356, L: 641, src: 'T1' }
    }, T2([20, 35], [23, 28], 1.5, 21), { Mem: [20, 35], MemSrc: 'S1 Table 2 (equals the T2 M50 range)', LmaxRatio: 1.80, LmaxSrc: 'derived from T1: maximum expected length / Dn = 1.80 at every limit' }),
    lm('lma40-200', 'LMA 40/200', 'LMA', {
      ELL: { m: 15, Dn: 178, L: 321, Ds: 221, src: 'T1' }, NLL: { m: 40, Dn: 247, L: 445, Ds: 307, src: 'T1' }, NUL: { m: 200, Dn: 423, L: 761, Ds: 524, src: 'T1' }, EUL: { m: 300, Dn: 484, L: 871, Ds: 600, src: 'T1' }
    }, T2([80, 120], [37, 42], 1.5, 34), { Mem: [80, 120], MemSrc: 'S1 Table 2 (equals the T2 M50 range)', LmaxRatio: 1.80, LmaxSrc: 'derived from T1: maximum expected length / Dn = 1.80 at every limit' }),
    lm('lmb40-200', 'LMB 40/200', 'LMB', { ELL: { m: 15, src: 'S1' }, NLL: { m: 40, src: 'S1' }, NUL: { m: 200, src: 'S1' }, EUL: { m: 300, src: 'S1' } },
      null, { Mem: null, MemSrc: 'not applicable: category B has no average-mass requirement (S1 Table 3)', dist: { mode: 'envelope', pos: 'mid', smoothing: 0 },
        notes: 'Not in the user snippet. Same mass limits as LMA 40/200 in prEN 13383-1:2021 (draft) but no Mem. No D50, Dn50 or Lmax given.' }),
    lm('lma60-300', 'LMA 60/300', 'LMA', {
      ELL: { m: 30, Dn: 225, L: 404, src: 'T1' }, NLL: { m: 60, Dn: 283, L: 509, src: 'T1' }, NUL: { m: 300, Dn: 484, L: 871, src: 'T1' }, EUL: { m: 450, Dn: 554, L: 997, src: 'T1' }
    }, T2([120, 190], [42, 49], 1.5, 38), { Mem: [120, 190], MemSrc: 'S1 Table 2 (equals the T2 M50 range)', LmaxRatio: 1.80, LmaxSrc: 'derived from T1: maximum expected length / Dn = 1.80 at every limit' })
  ];

  /* Measured batch: B1 (embedded so it is available without uploading). */
  const BATCH_MASSES = [17.5, 19, 24.5, 24.5, 25, 26.5, 26.5, 27, 27.5, 27.5, 28.5, 28.5, 28.5, 29, 30, 30.5, 32.5, 33, 34.5, 35, 35, 35.5, 36, 37, 38, 39, 40, 40.5, 41.5, 42, 44, 44.5, 45.5, 46.5, 47, 47.5, 48, 48, 49, 49, 50, 50.5, 51, 54, 55, 55.5, 56, 56.5, 57, 57, 57, 59, 59.5, 60, 61, 61.5, 63, 63.5, 65.5, 66.5, 67, 68.5, 70, 72, 72.5, 73, 73.5, 73.5, 74.5, 76.5, 76.5, 76.5, 76.5, 76.5, 77.5, 77.5, 77.5, 78.5, 79, 79.5, 80.5, 82, 82.5, 83, 83, 84.5, 85, 85, 86, 86.5, 86.5, 87, 87, 88.5, 89.5, 90.5, 91.5, 92, 93.5, 95, 95.5, 96.5, 98, 98.5, 99.5, 99.5, 101.5, 103.5, 104, 104.5, 105.5, 105.5, 105.5, 106, 107, 107, 108.5, 110, 112, 112.5, 113.5, 114, 114.5, 115.5, 117, 117, 117.5, 118.5, 119, 119, 120.5, 121, 121, 122, 124, 125.5, 128, 129, 130, 131, 138, 135, 136.5, 138, 139.5, 140, 142, 144, 144.5, 146, 147, 148.5, 150, 150.5, 150.5, 150.5, 152, 156.5, 157.5, 159, 159.5, 162, 162, 164.5, 165, 167.5, 168.5, 169.5, 170.5, 175, 176, 177, 179.5, 180, 182, 183.5, 184.5, 185, 187, 187.5, 188.5, 190, 191, 192.5, 193.5, 196.5, 199, 200.5, 202, 216, 221.5, 228, 229.5, 232.5, 252, 262.5, 266.5, 281, 282.5, 303.5];
  const BATCH = {
    file: 'LMA_40-200_batch_test.xlsx', sheet: 'Sheet1', range: 'B7:D206',
    masses: BATCH_MASSES, rows: BATCH_MASSES.map((_, i) => 7 + i), ids: BATCH_MASSES.map((_, i) => i + 1),
    fines: 179, finesNote: 'Fragments below 15 kg weighed in bulk (cell E210), not individually.',
    ld: [[5, 3], [54, 2.9], [86, 3], [142, 3], [175, 3]],
    ldNote: 'Shape column "l/d-ratio" is filled for 5 of 200 stones (2.5 %), values 2.9 to 3.0. Interpreted as the stones recorded as elongated; the others are taken as below 2.9. This interpretation is an assumption.',
    dims: null
  };

  function batchGrade() {
    const base = LIBRARY.find(g => g.id === 'lma40-200');
    const g = JSON.parse(JSON.stringify(base));
    g.id = 'batch-lma40-200'; g.name = 'LMA 40/200 batch test (measured)'; g.family = 'measured';
    g.measured = JSON.parse(JSON.stringify(BATCH));
    g.dist = { mode: 'empirical', pos: 'mid', smoothing: 0 };
    g.shape = Object.assign(defaultShape(), { LTmax: 2.9, classLTmax: 2.9, src: 'assumption for unrecorded stones, capped at 2.9 by the interpretation of the l/d column', measuredSub: { frac: 5 / 200, LTlo: 2.9, LThi: 3.0, src: 'B1 l/d column' } });
    g.notes = 'Empirical grade from the 200 weighed stones of B1. Limits and table values as LMA 40/200.';
    g.revision = REV;
    return g;
  }

  function fullLibrary() { return LIBRARY.map(g => JSON.parse(JSON.stringify(g))).concat([batchGrade()]); }

  /* ---------------- derived helpers ---------------- */
  const DnOf = (m, rho) => Math.cbrt(m / rho);           // m
  const massOfDn = (dn, rho) => rho * dn * dn * dn;      // kg

  /** Dn/D ratio from the class table (Dn50 / mid D50), or null. */
  function dnPerD(g) {
    const c = g.classTable; if (!c || !c.D50cm || !c.Dn50cm) return null;
    return c.Dn50cm / ((c.D50cm[0] + c.D50cm[1]) / 2);
  }

  /** Curve points (mass kg, cumulative fraction by mass 0..1) for an envelope position e in [0,1]. */
  function envelopePoints(g, e, opts) {
    let pts;
    const interp = (g.dist && g.dist.interp) || (g.kind === 'mass' ? 'rrm' : 'loglinear');
    if (g.kind === 'mass' && interp === 'rrm') {
      // Rosin-Rammler through the NLL and NUL points at envelope position e
      // (CIRIA/CUR/CETMEF 2007 interpolation between standard grading limits):
      //   y(M) = 1 - exp( ln(0.5) (M/M50)^n )
      const L = {}; g.limits.forEach(l => { L[l.name] = l; });
      const pAt = (l) => Math.min(0.995, Math.max(0.005, (l.pass[1] - e * (l.pass[1] - l.pass[0])) / 100));
      const q1 = Math.log(1 - pAt(L.NLL)) / Math.log(0.5), q2 = Math.log(1 - pAt(L.NUL)) / Math.log(0.5);
      const n = Math.log(q2 / q1) / Math.log(L.NUL.mass / L.NLL.mass);
      const M50 = L.NLL.mass / Math.pow(q1, 1 / n);
      const y = (M) => 1 - Math.exp(Math.log(0.5) * Math.pow(M / M50, n));
      const a = Math.log(L.ELL.mass), b = Math.log(L.EUL.mass);
      pts = [];
      for (let k = 0; k <= 60; k++) { const M = Math.exp(a + (b - a) * k / 60); pts.push({ m: M, p: y(M) }); }
      pts.rrm = { n, M50 };
      const p0 = pts[0].p, p1 = pts[pts.length - 1].p, span = p1 - p0 || 1;
      const outp = pts.map(q => ({ m: q.m, p: (q.p - p0) / span }));
      outp.rrm = { n, M50, truncLow: p0, truncHigh: 1 - p1 };
      return outp;
    }
    if (g.kind === 'mass') {
      pts = g.limits.map(L => ({ m: L.mass, p: (L.pass[1] - e * (L.pass[1] - L.pass[0])) / 100 }));
    } else {
      const r = dnPerD(g) || opts.dnPerD;
      pts = g.sieves.map(S => ({ m: massOfDn(S.size / 1000 * r, g.rho), p: (S.pass[1] - e * (S.pass[1] - S.pass[0])) / 100 }));
    }
    // enforce monotonic and truncate tails: first point -> 0, last point -> 1
    for (let i = 1; i < pts.length; i++) pts[i].p = Math.max(pts[i].p, pts[i - 1].p);
    const p0 = pts[0].p, p1 = pts[pts.length - 1].p;
    const span = p1 - p0 || 1;
    return pts.map(q => ({ m: q.m, p: (q.p - p0) / span }));
  }

  /** Build a binned number distribution from mass-fraction points. */
  function binned(points) {
    const NB = 300, l0 = Math.log(points[0].m), l1 = Math.log(points[points.length - 1].m);
    const P = (m) => {
      const l = Math.log(m);
      if (l <= l0) return 0; if (l >= l1) return 1;
      for (let i = 0; i < points.length - 1; i++) {
        const a = Math.log(points[i].m), b = Math.log(points[i + 1].m);
        if (l <= b) return b > a ? points[i].p + (points[i + 1].p - points[i].p) * (l - a) / (b - a) : points[i + 1].p;
      }
      return 1;
    };
    const edges = new Float64Array(NB + 1), cdf = new Float64Array(NB + 1);
    for (let k = 0; k <= NB; k++) edges[k] = l0 + (l1 - l0) * k / NB;
    let acc = 0, massAcc = 0;
    for (let k = 0; k < NB; k++) {
      const dm = P(Math.exp(edges[k + 1])) - P(Math.exp(edges[k]));
      const mc = Math.exp(0.5 * (edges[k] + edges[k + 1]));
      acc += dm / mc; massAcc += dm;
      cdf[k + 1] = acc;
    }
    const meanMass = massAcc / (acc || 1);
    for (let k = 0; k <= NB; k++) cdf[k] /= acc || 1;
    return { edges, cdf, NB, meanMass, P };
  }

  function sampleBinned(B, r) {
    const u = r();
    let lo = 0, hi = B.NB;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (B.cdf[mid] < u) lo = mid; else hi = mid; }
    return Math.exp(B.edges[lo] + (B.edges[lo + 1] - B.edges[lo]) * r());
  }

  /**
   * Make a mass sampler for grade g.
   * opts: { dnPerD (fallback ratio), uniform (bool: identical stones at M50) }
   * Returns { sample(rng) -> kg, curve: [{m, pMass}], meanMass, label, warnings }
   */
  function sampler(g, opts) {
    opts = opts || {};
    const W = [];
    const mode = g.dist.mode;
    let s;
    if (mode === 'empirical' && g.measured && g.measured.masses && g.measured.masses.length) {
      const ms = g.measured.masses.filter(v => v > 0).slice().sort((a, b) => a - b);
      const n = ms.length;
      const lm = ms.map(Math.log), mean = lm.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(lm.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, n - 1));
      const bw = (g.dist.smoothing || 0) * 1.06 * sd * Math.pow(n, -0.2); // Silverman bandwidth x factor
      const lo = ms[0], hi = ms[n - 1];
      s = {
        sample(r) {
          const m = ms[Math.floor(r() * n)];
          if (bw <= 0) return m;
          const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
          return Math.min(hi, Math.max(lo, m * Math.exp(bw * z)));
        },
        meanMass: ms.reduce((a, b) => a + b, 0) / n,
        label: 'Measured masses (' + n + ' stones), ' + (bw > 0 ? 'log-smoothed bootstrap' : 'bootstrap') + ', fragments below ELL excluded',
        points: null, empirical: ms
      };
    } else if (mode === 'dvalues' && g.dvals) {
      const D = g.dvals; // mm as Dn
      const pts = [[D.dMin, 0], [D.d10, 0.1], [D.d50, 0.5], [D.d90, 0.9], [D.dMax, 1]].map(q => ({ m: massOfDn(q[0] / 1000, g.rho), p: q[1] }));
      let B;
      if (D.basis === 'number') {
        // number fractions: sample directly in log size
        B = { NB: 4, edges: Float64Array.from(pts.map(q => Math.log(q.m))), cdf: Float64Array.from(pts.map(q => q.p)) };
        B.meanMass = NaN;
      } else B = binned(pts);
      s = { sample: (r) => sampleBinned(B, r), meanMass: B.meanMass, label: 'D-value curve (Dn, ' + (D.basis || 'mass') + ' basis)', points: pts };
    } else {
      if (mode === 'empirical') W.push('No measured masses in this grade; using the envelope curve instead.');
      let e = { fine: 0, mid: 0.5, coarse: 1 }[g.dist.pos];
      let label = { fine: 'fine edge', mid: 'mid', coarse: 'coarse edge' }[g.dist.pos];
      if (g.dist.pos === 'mem') {
        if (g.Mem) {
          const target = (g.Mem[0] + g.Mem[1]) / 2;
          let a = 0, b = 1;
          const f = (x) => binned(envelopePoints(g, x, opts)).meanMass - target;
          if (f(a) > 0 || f(b) < 0) { e = f(a) > 0 ? 0 : 1; W.push('Mem midpoint ' + target + ' kg is outside what the envelope allows; using the ' + (e ? 'coarse' : 'fine') + ' edge.'); }
          else { for (let i = 0; i < 40; i++) { const c = (a + b) / 2; if (f(c) < 0) a = c; else b = c; } e = (a + b) / 2; }
          label = 'matched to Mem midpoint (' + target + ' kg), position ' + e.toFixed(2);
        } else { e = 0.5; label = 'mid (no Mem for this grade)'; }
      }
      if (e === undefined) e = 0.5;
      const pts = envelopePoints(g, e, opts);
      const B = binned(pts);
      const rr = pts.rrm ? ' Rosin-Rammler interpolation (n = ' + pts.rrm.n.toFixed(2) + ', M50 = ' + pts.rrm.M50.toFixed(1) + ' kg), truncated at ELL and EUL (' + (pts.rrm.truncLow * 100).toFixed(1) + ' % and ' + (pts.rrm.truncHigh * 100).toFixed(1) + ' % of mass removed).' : ' Log-linear interpolation between limits, tails beyond the outermost limits truncated.';
      s = { sample: (r) => sampleBinned(B, r), meanMass: B.meanMass, label: 'Synthetic curve inside the ' + (g.kind === 'mass' ? 'mass-limit' : 'sieve') + ' envelope: ' + label + '.' + rr, points: pts, envPos: e, rrm: pts.rrm || null };
    }
    if (opts.uniform) {
      // deliberate simplification: identical stones at the mass-weighted median
      const r0 = FP.particles.rng(4242), arr = [];
      for (let i = 0; i < 4000; i++) arr.push(s.sample(r0));
      const m50 = massMedian(arr);
      return { sample: () => m50, meanMass: m50, label: 'Identical stones at M50 = ' + m50.toFixed(2) + ' kg (deliberate simplification)', points: null, warnings: W };
    }
    s.warnings = W;
    return s;
  }

  function massMedian(arr) {
    const s = arr.slice().sort((a, b) => a - b), T = s.reduce((a, b) => a + b, 0);
    let acc = 0; for (const v of s) { acc += v; if (acc >= T / 2) return v; }
    return s[s.length - 1];
  }

  /** Short read-only summary rows for the UI. */
  function summaryRows(g) {
    const rows = [];
    const f = (v, d) => v == null ? 'not given' : (typeof v === 'number' ? +v.toFixed(d == null ? 2 : d) : v);
    rows.push(['Family / revision', g.family + ' / ' + (g.revision || '-')]);
    rows.push(['Nominal range', g.nominal ? g.nominal.lower + ' to ' + g.nominal.upper + ' ' + g.nominal.unit : 'not given']);
    if (g.classTable) {
      const c = g.classTable;
      rows.push(['M50 range, category A [kg] (T2)', c.M50 ? c.M50[0] + ' to ' + c.M50[1] : 'not given']);
      rows.push(['D50 lower / upper [cm] (T2)', c.D50cm ? c.D50cm[0] + ' / ' + c.D50cm[1] : 'not given']);
      rows.push(['D85/D15 (T2)', f(c.D85D15, 1)]);
      rows.push(['Dn50 [cm] (T2)', f(c.Dn50cm, 1)]);
      const r = dnPerD(g); if (r) rows.push(['Dn50 / D50 mid (derived)', r.toFixed(3)]);
    } else rows.push(['Class-table values (D50, M50, D85/D15)', 'not given']);
    if (g.Mem !== undefined) rows.push(['Mem [kg]', g.Mem ? g.Mem[0] + ' to ' + g.Mem[1] + ' (' + g.MemSrc + ')' : (g.MemSrc || 'not given')]);
    rows.push(['Density [kg/m3]', g.rho + ' (' + g.rhoSrc + ')']);
    rows.push(['Bulk density [kg/m3]', g.bulkDensity == null ? 'not given' : g.bulkDensity]);
    rows.push(['Lmax / Dn', g.LmaxRatio == null ? 'not given' : g.LmaxRatio + ' (' + g.LmaxSrc + ')']);
    return rows;
  }

  FP.grades = { fullLibrary, LIBRARY, BATCH, batchGrade, sampler, envelopePoints, binned, dnPerD, DnOf, massOfDn, massMedian, summaryRows, defaultShape, TOL_LM, REV };
})(self.FP = self.FP || {});
