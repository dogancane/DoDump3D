/* ==========================================================================
 * js3d/shapes3d.js
 * 3D rock generator: mass -> shape class -> L x B x T -> rigid sphere clump.
 *
 * Uses the same stone statistics as the 2D generator (shapes.js): mass from
 * the grade, Dn = (M / rho)^(1/3), Zingg shape classes (or the legacy L/T
 * model), volume factor vf L B T = Dn^3, optional Lmax cap, measured
 * sub-population. The difference: there is no section plane, so nothing is
 * projected. The full body is kept and filled with overlapping spheres:
 *
 *   The stone body is a superellipsoid inside the L x B x T box:
 *     |x/a|^p + |y/b|^p + |z/c|^p = 1   (a = L/2, b = B/2, c = T/2)
 *   with the exponent p set so its volume is vf L B T (vf = volume factor):
 *     vf = Gamma(1 + 1/p)^3 / Gamma(1 + 3/p)
 *   p = 2 is the ellipsoid (vf 0.524, rounded class and L/T model), vf 0.6
 *   gives p ~ 2.4 (quarried blocks: flat-ish faces, rounded corners), vf -> 1
 *   gives the sharp cuboid. The body keeps the full L, B and T (the sieve and
 *   passage dimensions) but its corners are only as large as the volume
 *   factor allows. An earlier version put spheres at the cuboid corners,
 *   which made blocks up to 40 % wider across the diagonal than L and let
 *   stones smaller than the opening wedge across it.
 *
 *   Sphere fill: every sphere is INSCRIBED in the superellipsoid (radius =
 *   distance from its centre to the surface), so no sphere sticks out of the
 *   stone. Spheres are chosen greedily from interior candidates to cover the
 *   surface within a tolerance of 5 % of c, in mirror-symmetric groups. Fills are
 *   computed once per shape (axis ratios rounded down on a 4 % scale, then stretched to the exact axes) and cached
 *   in this browser. The drawn stone is the same
 *   superellipsoid, so what is drawn is what collides.
 *
 * Body frame: x along L, y along B, z along T. Orientation: uniform random
 * unit quaternion (Shoemake). Mass is the sampled mass; inertia is diagonal
 * in the body frame: blocks m (b^2 + c^2) / 4 (between cuboid /3 and
 * ellipsoid /5, for a volume factor near 0.6), rounded m (b^2 + c^2) / 5.
 * Drag area: mean projected area = ellipsoid surface / 4 (as in 2D).
 * ========================================================================== */
(function (FP) {
  'use strict';

  const K6PI = 6 / Math.PI;
  const MAXS = 24;

  /* ---------- superellipsoid helpers ---------- */
  function lgamma(x) {   // Lanczos
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1; let a = c[0]; const t = x + g + 0.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function vfOfP(p) { return Math.exp(3 * lgamma(1 + 1 / p) - lgamma(1 + 3 / p)); }
  /** Superellipsoid exponent for a volume factor V / (L B T). */
  function pOfVf(vf) {
    vf = Math.max(0.36, Math.min(0.95, vf));
    let lo = 1.05, hi = 12;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (vfOfP(m) < vf) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  /** Mean of u^2 over the unit superellipsoid (for the inertia), Monte Carlo, cached per p. */
  const e2Cache = new Map();
  function e2Of(p) {
    const k = p.toFixed(3); if (e2Cache.has(k)) return e2Cache.get(k);
    const r = FP.particles.rng(99); let n = 0, s = 0;
    for (let i = 0; i < 40000; i++) {
      const x = 2 * r() - 1, y = 2 * r() - 1, z = 2 * r() - 1;
      if (Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p) + Math.pow(Math.abs(z), p) <= 1) { n++; s += x * x; }
    }
    const v = n ? s / n : 0.2; e2Cache.set(k, v); return v;
  }
  /** Point on the surface in direction (dx, dy, dz) for semi-axes (1, b, c). */
  function surfAlong(dx, dy, dz, b, c, p) {
    const u = Math.pow(Math.abs(dx), p) + Math.pow(Math.abs(dy / b), p) + Math.pow(Math.abs(dz / c), p);
    const t = Math.pow(u, -1 / p);
    return [t * dx, t * dy, t * dz];
  }

  const TPL_KEY = 'fallpipe3d.clumps.v4';
  const tplCache = new Map();
  let tplDirty = 0;
  try { const raw = typeof localStorage !== 'undefined' && localStorage.getItem(TPL_KEY); if (raw) Object.entries(JSON.parse(raw)).forEach(([k, v]) => tplCache.set(k, v)); } catch (e) { /* storage unavailable */ }
  /** Store new clump templates in the browser so the next visit starts fast. */
  function saveTemplates() {
    if (!tplDirty) return; tplDirty = 0;
    try { const o = {}; tplCache.forEach((v, k) => { o[k] = { subs: v.subs.map(q => q.map(x => +x.toFixed(5))), err: +v.err.toFixed(4), cover: +v.cover.toFixed(3) }; }); localStorage.setItem(TPL_KEY, JSON.stringify(o)); } catch (e) { /* storage full or unavailable */ }
  }
  // 62 unit directions (icosphere-like) for the containment test of a sphere
  const DIRS = (() => { const d = [], n = 62, ga = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < n; i++) { const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), t = ga * i; d.push([r * Math.cos(t), y, r * Math.sin(t)]); } return d.concat([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]); })();
  const DIRS26 = (() => { const d = []; for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) { if (!x && !y && !z) continue; const n = Math.hypot(x, y, z); d.push([x / n, y / n, z / n]); } return d; })();
  /** Largest sphere at (x, y, z) inside the superellipsoid (1, b, c, p). hi: an upper bound (distance to surface samples). */
  function inscribedR(x, y, z, b, c, p, hi) {
    const ib = 1 / b, ic = 1 / c, two = Math.abs(p - 2) < 1e-9;
    const F = two ? (X, Y, Z) => X * X + Y * Y * ib * ib + Z * Z * ic * ic
      : (X, Y, Z) => Math.pow(Math.abs(X), p) + Math.pow(Math.abs(Y * ib), p) + Math.pow(Math.abs(Z * ic), p);
    if (F(x, y, z) >= 1) return 0;
    const ok = (m, D) => { for (const d of D) if (F(x + m * d[0], y + m * d[1], z + m * d[2]) > 1) return false; return true; };
    let lo = 0; hi = Math.min(hi, c * 1.01);
    for (let it = 0; it < 9; it++) { const m = (lo + hi) / 2; if (ok(m, DIRS26)) lo = m; else hi = m; }
    while (lo > 0 && !ok(lo, DIRS)) lo *= 0.995;   // verify with the dense direction set
    return lo * 0.995;
  }
  /**
   * Sphere fill of the superellipsoid with semi-axes (1, b, c), b, c <= 1.
   * Every sphere is inside the body. Greedy choice: each step adds the sphere that most reduces
   * the summed gap between the surface samples and the clump surface.
   * Returns { subs, err: max surface gap / c, cover: share of samples within 5 % of c }.
   */
  function template(b, c, p) {
    const key = b.toFixed(2) + '|' + c.toFixed(2) + '|' + p.toFixed(2);
    const hit = tplCache.get(key); if (hit) return hit;
    const NSf = 300, S = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NSf; i++) {
      const y = 1 - 2 * (i + 0.5) / NSf, rr = Math.sqrt(1 - y * y), th = ga * i;
      S.push(surfAlong(rr * Math.cos(th), y * b, rr * Math.sin(th) * c, b, c, p));
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) S.push(surfAlong(sx, sy * b, sz * c, b, c, p));
    S.push([1, 0, 0], [-1, 0, 0], [0, b, 0], [0, -b, 0], [0, 0, c], [0, 0, -c]);
    const ns = S.length;
    // the six axis tips carry L, B and T (sieve and passage sizes): weight them so they are always reached
    const W = new Float32Array(ns).fill(1); for (let i = ns - 6; i < ns; i++) W[i] = 40;
    // candidate groups: a sphere and its mirror images (the body is symmetric in all three planes)
    const G = [];
    const hx = Math.min(c / 1.5, 0.1), hy = Math.min(c / 1.5, b / 3), hz = c / 2.5;
    const xs = []; for (let x = 0; x < 1; x += hx) xs.push(x);
    [0.12, 0.25, 0.4, 0.6].forEach(f => { const x = 1 - f * c * c / Math.max(c, 0.05) * 1.2; if (x > 0) xs.push(x); });   // near the tips
    for (const x of xs) for (let y = 0; y < b; y += hy) for (let z = 0; z < c * 0.7; z += hz) {
      let dmin = Infinity; for (let i = 0; i < ns; i++) { const q = S[i], dd = (q[0] - x) * (q[0] - x) + (q[1] - y) * (q[1] - y) + (q[2] - z) * (q[2] - z); if (dd < dmin) dmin = dd; }
      const r = inscribedR(x, y, z, b, c, p, Math.sqrt(dmin) * 1.02);
      if (r < 0.15 * c) continue;
      const mem = [];
      for (const sx of x ? [-1, 1] : [1]) for (const sy of y ? [-1, 1] : [1]) for (const sz of z ? [-1, 1] : [1]) mem.push([sx * x, sy * y, sz * z, r]);
      G.push(mem);
    }
    // extra candidates on the B axis near its tip
    [0.3, 0.5, 0.7, 0.9].forEach(f => {
      const y = b - f * c; if (y <= 0) return;
      let dmin = Infinity; for (let i = 0; i < ns; i++) { const q = S[i], dd = q[0] * q[0] + (q[1] - y) * (q[1] - y) + q[2] * q[2]; if (dd < dmin) dmin = dd; }
      const r = inscribedR(0, y, 0, b, c, p, Math.sqrt(dmin) * 1.02);
      if (r >= 0.15 * c) G.push([[0, y, 0, r], [0, -y, 0, r]]);
    });
    if (!G.length) G.push([[0, 0, 0, c * 0.98]]);
    const ng = G.length, tol = 0.05 * c;
    const gap = new Float32Array(ng * ns);
    for (let j = 0; j < ng; j++) for (let i = 0; i < ns; i++) {
      const s2 = S[i]; let g = Infinity;
      for (const q of G[j]) { const v = Math.hypot(s2[0] - q[0], s2[1] - q[1], s2[2] - q[2]) - q[3]; if (v < g) g = v; }
      gap[j * ns + i] = Math.max(0, g);
    }
    const best = new Float32Array(ns);
    for (let i = 0; i < ns; i++) best[i] = Math.hypot(S[i][0], S[i][1], S[i][2]);
    const subsOut = [], used = new Uint8Array(ng);
    while (subsOut.length < MAXS) {
      let bj = -1, bs = 0;
      for (let j = 0; j < ng; j++) {
        if (used[j] || subsOut.length + G[j].length > MAXS) continue;
        let gain = 0;
        for (let i = 0; i < ns; i++) { const d = best[i] - gap[j * ns + i]; if (d > 0) gain += W[i] * (Math.min(d, Math.max(0, best[i] - tol)) + d * 0.02); }
        gain /= Math.sqrt(G[j].length);   // spheres cost time: prefer groups that do more per sphere
        if (gain > bs) { bs = gain; bj = j; }
      }
      if (bj < 0 || bs < 1e-6) break;
      used[bj] = 1; G[bj].forEach(q => subsOut.push(q.slice()));
      let mx = 0; for (let i = 0; i < ns; i++) { const gv = gap[bj * ns + i]; if (gv < best[i]) best[i] = gv; if (best[i] > mx) mx = best[i]; }
      if (mx <= tol) break;
    }
    let err = 0, cov = 0; for (let i = 0; i < ns; i++) { err = Math.max(err, best[i]); if (best[i] <= tol) cov++; }
    const out = { subs: subsOut, err: err / c, cover: cov / ns };
    tplCache.set(key, out); tplDirty++;
    return out;
  }
  // ratios rounded DOWN on a 4 % geometric scale: the template is never fatter than the stone, and stretching
  // it to the exact axes keeps every sphere inside (the stretched sphere is an ellipsoid containing it)
  const LQ = Math.log(1.04);
  const q2 = (v) => Math.min(1, Math.exp(Math.floor(Math.log(Math.max(0.08, v)) / LQ + 1e-9) * LQ));
  /** Clump for semi-axes a >= b >= c with exponent p (scaled template). */
  function fillBody(a, b, c, p, irr, r) {
    const qb = q2(b / a), qc = q2(c / a), t = template(qb, qc, p);
    // map the cached template to the exact axes (removes the rounding of the ratios); radii take the smaller factor
    const fy = b / (qb * a), fz = c / (qc * a), fr = 1;   // fy, fz >= 1
    const subs = t.subs.map(q => [q[0] * a, q[1] * a * fy, q[2] * a * fz, q[3] * a * fr]);   // irregularity is not applied in 3D: the body shape carries the angularity
    return { subs, err: t.err, cover: t.cover };
  }

  function pickClass(mix, r) {
    const C = FP.shapes.CLASSES;
    let tot = 0; C.forEach(c => { tot += Math.max(0, mix[c.id] || 0); });
    if (tot <= 0) return C[0];
    let u = r() * tot;
    for (const c of C) { u -= Math.max(0, mix[c.id] || 0); if (u <= 0) return c; }
    return C[0];
  }

  /** Uniform random unit quaternion [w, x, y, z]. */
  function randomQuat(r) {
    const u1 = r(), u2 = r(), u3 = r();
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    return [b * Math.cos(2 * Math.PI * u3), a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3)];
  }

  /** Block of half extents A >= B >= C: core grid plus 8 corner spheres. */
  function fillBlock(A, B, C, corner, irr, r) {
    const subs = [];
    const rc = C * 0.96;
    const spanX = Math.max(0, A - C), spanY = Math.max(0, B - C);
    const nA = spanX < 0.05 * C ? 1 : Math.min(3, 1 + Math.ceil(spanX / C));
    const nB = spanY < 0.25 * C ? 1 : (spanY > 1.2 * C ? 3 : 2);
    for (let i = 0; i < nA; i++) for (let j = 0; j < nB; j++) {
      const x = nA === 1 ? 0 : -spanX + 2 * spanX * i / (nA - 1);
      const y = nB === 1 ? 0 : -spanY + 2 * spanY * j / (nB - 1);
      const jit = irr > 0 ? 1 + 0.3 * irr * (2 * r() - 1) : 1;
      subs.push([x, y, 0, rc * jit]);
    }
    const rk = Math.max(0.12, Math.min(0.45, corner)) * C;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      let x = sx * (A - rk), y = sy * (B - rk), z = sz * (C - rk);
      if (irr > 0) { x += irr * rk * (2 * r() - 1); y += irr * rk * (2 * r() - 1); z += 0.5 * irr * rk * (2 * r() - 1); }
      subs.push([x, y, z, rk * (1 + (irr > 0 ? 0.5 * irr * (2 * r() - 1) : 0))]);
    }
    return subs.slice(0, MAXS);
  }

  /** Ellipsoid of half axes A >= B >= C filled with inscribed spheres. */
  function fillEllipsoid(A, B, C, irr, r) {
    if (A / C < 1.12) return [[0, 0, 0, Math.cbrt(A * B * C)]];
    const ratio = A / C;
    const k = Math.min(7, 1 + 2 * Math.ceil((ratio - 1) * 1.5));
    const nB = B / C > 1.35 ? 2 : 1;
    const subs = [];
    const c2 = A * A - C * C, xe = c2 / A;
    for (let i = 0; i < k; i++) {
      const x = k === 1 ? 0 : -xe + 2 * xe * i / (k - 1);
      for (let j = 0; j < nB; j++) {
        const y = nB === 1 ? 0 : (j ? 1 : -1) * (B - C) * 0.7;
        let rr = C * Math.sqrt(Math.max(0.04, 1 - (x * x) / (A * A) - (y * y) / (B * B)));
        if (i === 0 || i === k - 1) rr = Math.max(rr * 0.8, C * C / A);
        if (irr > 0) rr *= 1 + irr * (2 * r() - 1);
        subs.push([x, y, 0, Math.max(rr, 0.3 * C)]);
      }
    }
    return subs.slice(0, MAXS);
  }

  /**
   * Build one 3D stone.
   * S: cfg.shape (mode 'rock' | 'sphere' | 'clump2' | 'clump3', shapeModel, capL, useMeasured, irregularScale, elong)
   */
  function makeStone(m, g, S, r, maxSubR) {
    const rho = g.rho, Dn = Math.cbrt(m / rho);
    const sh = g.shape || FP.grades.defaultShape();
    let subs, L, B, T, LT, cls = 'ellipsoid', boxLike = false, vf = Math.PI / 6, capped = false, measured = false, pexp = 2, fitErr = 0, fitCover = 1;
    if (S.mode === 'sphere') {
      const R = Math.cbrt(K6PI) * Dn / 2;
      subs = [[0, 0, 0, R]]; L = B = T = 2 * R; LT = 1;
    } else if (S.mode === 'clump2' || S.mode === 'clump3') {
      const e = Math.max(1, S.elong);
      const d = Math.cbrt(K6PI * Dn * Dn * Dn / e); L = e * d; B = T = d; LT = e;
      const off = (L - d) / 2;
      if (S.mode === 'clump2') subs = [[-off, 0, 0, d / 2], [off, 0, 0, d / 2]];
      else subs = [[-off, -0.12 * d, 0, 0.5 * d], [off, -0.12 * d, 0.05 * d, 0.42 * d], [0.15 * off, 0.22 * d, -0.05 * d, 0.45 * d]];
    } else if (S.shapeModel !== 'lt') {
      const ms = sh.measuredSub, C = FP.shapes.CLASSES;
      let c, bl, tb;
      if (S.useMeasured && ms && r() < ms.frac) {
        LT = ms.LTlo + (ms.LThi - ms.LTlo) * r(); measured = true; c = C[3];
        bl = tb = 1 / Math.sqrt(LT);
      } else {
        const mix = sh.mix || FP.shapes.DEFAULT_MIX, LTmaxCap = sh.classLTmax || 99;
        for (let k = 0; k < 30; k++) {
          c = pickClass(mix, r);
          bl = c.bl[0] + (c.bl[1] - c.bl[0]) * r();
          tb = c.tb[0] + (c.tb[1] - c.tb[0]) * r();
          if (1 / (bl * tb) <= LTmaxCap) break;
        }
        LT = 1 / (bl * tb);
      }
      vf = c.outline === 'round' ? Math.PI / 6 : (sh.vfBlock || c.vf);
      L = Math.cbrt(Dn * Dn * Dn / (vf * bl * bl * tb)); B = bl * L; T = tb * B;
      if (S.capL && g.LmaxRatio && L > g.LmaxRatio * Dn) { L = g.LmaxRatio * Dn; B = Math.sqrt(Dn * Dn * Dn / (vf * L * tb)); T = tb * B; capped = true; LT = L / T; }
      const irr = sh.irregular * (S.irregularScale == null ? 1 : S.irregularScale);
      cls = c.id; boxLike = c.outline !== 'round';
      pexp = boxLike ? pOfVf(vf) : 2;
      const fb = fillBody(L / 2, B / 2, T / 2, pexp, irr, r); subs = fb.subs; fitErr = fb.err; fitCover = fb.cover;
    } else {
      const ms = sh.measuredSub;
      if (S.useMeasured && ms && r() < ms.frac) { LT = ms.LTlo + (ms.LThi - ms.LTlo) * r(); measured = true; }
      else LT = FP.shapes.truncNormal(r, sh.LTmean, sh.LTsd, Math.max(1, sh.LTmin), Math.max(sh.LTmin, sh.LTmax));
      const phi = sh.phi;
      if (S.capL && g.LmaxRatio) {
        const LTcap = Math.pow(g.LmaxRatio / Math.cbrt(K6PI), 3 / (2 - phi));
        if (LT > LTcap) { LT = Math.max(1, LTcap); capped = true; }
      }
      T = Math.cbrt(K6PI * Dn * Dn * Dn / Math.pow(LT, 1 + phi));
      L = LT * T; B = Math.pow(LT, phi) * T;
      pexp = 2;
      const fb = fillBody(L / 2, B / 2, T / 2, 2, sh.irregular * (S.irregularScale == null ? 1 : S.irregularScale), r); subs = fb.subs; fitErr = fb.err; fitCover = fb.cover;
    }
    // limit the sub-sphere size to the neighbour grid (scales the whole stone if exceeded)
    let rmax = 0; subs.forEach(s => { rmax = Math.max(rmax, s[3]); });
    let scale = 1;
    if (maxSubR && rmax > maxSubR) { scale = maxSubR / rmax; subs.forEach(s => { s[0] *= scale; s[1] *= scale; s[2] *= scale; s[3] *= scale; }); }
    // centroid of sphere volumes (overlaps ignored)
    if (S.mode === 'clump2' || S.mode === 'clump3') {   // legacy clumps: centre on the sphere volumes
      let wx = 0, wy = 0, wz = 0, ws = 0;
      subs.forEach(s => { const w = s[3] * s[3] * s[3]; wx += w * s[0]; wy += w * s[1]; wz += w * s[2]; ws += w; });
      subs.forEach(s => { s[0] -= wx / ws; s[1] -= wy / ws; s[2] -= wz / ws; });
    }
    let br = 0, rmin = Infinity;
    subs.forEach(s => { br = Math.max(br, Math.hypot(s[0], s[1], s[2]) + s[3]); rmin = Math.min(rmin, s[3]); });
    const a = L / 2 * scale, b = B / 2 * scale, c = T / 2 * scale;
    // inertia of the superellipsoid body: I_x = m (b^2 + c^2) E[u^2] (E[u^2] = 1/5 ellipsoid, 1/3 cuboid)
    const e2 = S.mode === 'sphere' ? 0.2 : (S.mode === 'clump2' || S.mode === 'clump3' ? 0.2 : e2Of(pexp));
    return {
      m, Dn, L, B, T, LT, cls, boxLike, vf, capped, measured, subs, br, rmin, pexp, fitErr, fitCover,
      half: [a, b, c],
      I: [m * (b * b + c * c) * e2, m * (a * a + c * c) * e2, m * (a * a + b * b) * e2],
      q: randomQuat(r),
      vol: m / rho,
      dragArea: FP.shapes.ellipsoidArea(L / 2, B / 2, T / 2) / 4 * (boxLike ? Math.pow(vf / (Math.PI / 6), 2 / 3) : 1)
    };
  }

  function describe(S, g) {
    if (S.mode === 'sphere') return 'Equal-volume spheres. Fastest; no shape interlocking.';
    if (S.mode === 'clump2') return 'Legacy rigid 2-sphere clumps, L/d = ' + S.elong + '.';
    if (S.mode === 'clump3') return 'Legacy rigid 3-sphere clumps, L/d ~ ' + S.elong + '.';
    const sh = g.shape, C = FP.shapes.CLASSES;
    if (S.shapeModel !== 'lt') {
      const mix = sh.mix || FP.shapes.DEFAULT_MIX; let tot = 0; C.forEach(c => { tot += Math.max(0, mix[c.id] || 0); });
      return '3D shape classes (Zingg): ' + C.map(c => c.name.split(' (')[0].toLowerCase() + ' ' + Math.round(100 * Math.max(0, mix[c.id] || 0) / (tot || 1)) + ' %').join(', ') +
        '. Angular classes as superellipsoids with exponent ' + pOfVf(sh.vfBlock || 0.6).toFixed(2) + ' (volume ' + (sh.vfBlock || 0.6) + ' L B T, rounded corners), rounded class as ellipsoid; each filled with up to ' + MAXS + ' inscribed spheres covering the surface within 5 % of T/2. Random 3D orientation, full 6 degrees of freedom.' +
        (S.useMeasured && sh.measuredSub ? ' Measured sub-population ' + (sh.measuredSub.frac * 100).toFixed(1) + ' % at L/T ' + sh.measuredSub.LTlo + ' to ' + sh.measuredSub.LThi + '.' : '') +
        ' Mix source: ' + (sh.mixSrc || 'assumption') + '.';
    }
    return '3D ellipsoid L x B x T with L/T ~ N(' + sh.LTmean + ', ' + sh.LTsd + ') in [' + sh.LTmin + ', ' + sh.LTmax + '], B = T (L/T)^' + sh.phi + ', sphere-filled, random 3D orientation. Shape source: ' + sh.src + '.';
  }

  FP.shapes3d = { saveTemplates, makeStone, describe, randomQuat, fillBody, template, pOfVf, vfOfP, surfAlong, MAXS };
})(self.FP = self.FP || {});
