/* ==========================================================================
 * shapes.js
 * Rock shape generator: mass -> 3D ellipsoid -> orientation -> in-plane clump.
 *
 * 1. Nominal diameter Dn = (M / rho)^(1/3).
 * 2. Elongation L/T from the grade shape model (truncated normal), or from a
 *    measured sub-population (e.g. the l/d records of the batch test).
 *    Intermediate axis B = T * (L/T)^phi  (phi = 0.5: B is the geometric mean).
 * 3. Ellipsoid of equal volume: (pi/6) L B T = Dn^3.
 *    Optional cap: L <= (Lmax/Dn) * Dn when the grade gives a maximum length.
 * 4. Orientation:
 *    'random'  uniform random 3D rotation; the stone's outline in the section
 *              plane is the orthogonal projection of the ellipsoid (shadow).
 *    'inplane' long and intermediate axes lie in the plane (worst case for
 *              spanning the pipe).
 * 5. The projected ellipse (semi-axes a >= b) is filled with k overlapping
 *    circles along the major axis. Interior circles are inscribed in the
 *    ellipse; the end circles have the tip curvature radius b^2/a, so the
 *    clump reaches the full length 2a. 'irregular' perturbs radii and offsets
 *    to approximate angular stones (contacts stay rounded).
 * Mass is the sampled mass. Inertia about the plane normal: m (a^2 + b^2) / 5.
 * Drag area: mean projected area of the 3D ellipsoid = surface area / 4
 * (Cauchy), independent of orientation.
 * ========================================================================== */
(function (FP) {
  'use strict';

  const K6PI = 6 / Math.PI;

  function truncNormal(r, mean, sd, lo, hi) {
    if (!(sd > 0)) return Math.min(hi, Math.max(lo, mean));
    for (let i = 0; i < 40; i++) {
      const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
      const v = mean + sd * z;
      if (v >= lo && v <= hi) return v;
    }
    return Math.min(hi, Math.max(lo, mean));
  }

  /** Knud Thomsen approximation of ellipsoid surface area (semi-axes). */
  function ellipsoidArea(a, b, c) {
    const p = 1.6075;
    return 4 * Math.PI * Math.pow((Math.pow(a * b, p) + Math.pow(a * c, p) + Math.pow(b * c, p)) / 3, 1 / p);
  }

  /** Random rotation matrix (uniform) from a random unit quaternion. */
  function randomRotation(r) {
    const u1 = r(), u2 = r(), u3 = r();
    const q1 = Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2), q2 = Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2);
    const q3 = Math.sqrt(u1) * Math.sin(2 * Math.PI * u3), q0 = Math.sqrt(u1) * Math.cos(2 * Math.PI * u3);
    return [
      [1 - 2 * (q2 * q2 + q3 * q3), 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2)],
      [2 * (q1 * q2 + q0 * q3), 1 - 2 * (q1 * q1 + q3 * q3), 2 * (q2 * q3 - q0 * q1)],
      [2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), 1 - 2 * (q1 * q1 + q2 * q2)]
    ];
  }

  /** Shadow of ellipsoid (semi-axes A,B,C) rotated by R on the x-y plane: {a, b, ang}. */
  function project(Rm, A, B, C) {
    const d = [A * A, B * B, C * C];
    // Q = R diag(d) R^T, take the 2x2 block
    let q00 = 0, q01 = 0, q11 = 0;
    for (let k = 0; k < 3; k++) { q00 += Rm[0][k] * Rm[0][k] * d[k]; q01 += Rm[0][k] * Rm[1][k] * d[k]; q11 += Rm[1][k] * Rm[1][k] * d[k]; }
    const tr = q00 + q11, det = q00 * q11 - q01 * q01;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 1e-12);
    const ang = 0.5 * Math.atan2(2 * q01, q00 - q11);
    return { a: Math.sqrt(l1), b: Math.sqrt(l2), ang };
  }

  /** Circles approximating an ellipse with semi-axes a >= b, major axis along x. */
  function clumpEllipse(a, b, irregular, r) {
    const ratio = a / b;
    if (ratio < 1.12) {
      const rr = Math.sqrt(a * b);
      return [[0, 0, rr]];
    }
    const k = Math.min(7, 1 + 2 * Math.ceil((ratio - 1) * 2));
    const c2 = a * a - b * b, xe = c2 / a;
    const subs = [];
    for (let i = 0; i < k; i++) {
      const x = -xe + 2 * xe * i / (k - 1);
      let rr = b * Math.sqrt(Math.max(0, 1 - x * x / c2));
      if (i === 0 || i === k - 1) rr = b * b / a;
      let y = 0;
      if (irregular > 0) {
        rr *= 1 + irregular * (2 * r() - 1);
        if (i > 0 && i < k - 1) y = irregular * b * 0.35 * (2 * r() - 1);
      }
      subs.push([x, y, Math.max(rr, 0.25 * b)]);
    }
    return subs;
  }

  /* ---------------- shape classes (Zingg) ---------------- */
  /**
   * Shape classes after Zingg (axis ratios B/L and T/B, threshold 2/3).
   * outline: 'block' = angular (rounded rectangle of circles, flat faces and
   * corners), 'round' = smooth ellipse. vf = volume / (L B T): cuboid 1,
   * ellipsoid 0.524; quarried blocks lie between (ASSUMPTION 0.6, editable).
   */
  const CLASSES = [
    { id: 'equant', name: 'Blocky / cubic (equant)', bl: [0.67, 1.0], tb: [0.67, 1.0], outline: 'block', vf: 0.6 },
    { id: 'prolate', name: 'Long and thin (elongated, prolate)', bl: [0.4, 0.67], tb: [0.67, 1.0], outline: 'block', vf: 0.6 },
    { id: 'oblate', name: 'Flat / tabular (slab, oblate)', bl: [0.67, 1.0], tb: [0.4, 0.67], outline: 'block', vf: 0.6 },
    { id: 'bladed', name: 'Flat and elongated (bladed)', bl: [0.4, 0.67], tb: [0.4, 0.67], outline: 'block', vf: 0.6 },
    { id: 'rounded', name: 'Rounded / near circular', bl: [0.75, 1.0], tb: [0.75, 1.0], outline: 'round', vf: Math.PI / 6 }
  ];
  /** ASSUMPTION: default class mix. Guidance: natural rock fragments are cube-like on
   * average (Domokos et al. 2020); pieces with L/T > 3 typically < 5 % (heavy) and
   * < 20 % (light) armourstone (Rock Manual 3.4.1.6). Replace with measured data. */
  const DEFAULT_MIX = { equant: 55, prolate: 15, oblate: 15, bladed: 10, rounded: 5 };

  /** Shadow of a box (half extents A >= B >= C) with rotation R: extents along the shadow's principal axes. */
  function projectBox(Rm, A, B, C) {
    const pts = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const v = [sx * A, sy * B, sz * C];
      pts.push([Rm[0][0] * v[0] + Rm[0][1] * v[1] + Rm[0][2] * v[2], Rm[1][0] * v[0] + Rm[1][1] * v[1] + Rm[1][2] * v[2]]);
    }
    let sxx = 0, syy = 0, sxy = 0;
    pts.forEach(p => { sxx += p[0] * p[0]; syy += p[1] * p[1]; sxy += p[0] * p[1]; });
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(ang), s = Math.sin(ang);
    let a = 0, b = 0;
    pts.forEach(p => { a = Math.max(a, Math.abs(c * p[0] + s * p[1])); b = Math.max(b, Math.abs(-s * p[0] + c * p[1])); });
    return { a, b, ang };
  }

  /** Angular block outline a x b (half extents): stadium core plus four corner circles. */
  function clumpBlock(a, b, corner, irregular, r) {
    const subs = [];
    if (a < b) { const t = a; a = b; b = t; }
    const rc = Math.max(0.12, Math.min(0.45, corner)) * b; // corner radius
    // core: circles of radius b along the long axis (fills the body)
    const span = Math.max(0, a - b), k = span < 0.05 * b ? 1 : Math.min(4, 1 + Math.ceil(span / b));
    for (let i = 0; i < k; i++) {
      const x = k === 1 ? 0 : -span + 2 * span * i / (k - 1);
      subs.push([x, 0, b * (1 - 0.04)]);
    }
    // corners: square off the ends and edges
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      let x = sx * (a - rc), y = sy * (b - rc);
      if (irregular > 0) { x += irregular * rc * (2 * r() - 1); y += irregular * rc * (2 * r() - 1); }
      subs.push([x, y, rc * (1 + (irregular > 0 ? irregular * (2 * r() - 1) * 0.5 : 0))]);
    }
    return subs.slice(0, 8);
  }

  function pickClass(mix, r) {
    let tot = 0; CLASSES.forEach(c => { tot += Math.max(0, mix[c.id] || 0); });
    if (tot <= 0) return CLASSES[0];
    let u = r() * tot;
    for (const c of CLASSES) { u -= Math.max(0, mix[c.id] || 0); if (u <= 0) return c; }
    return CLASSES[0];
  }

  /**
   * Build one stone.
   * m: mass [kg]; g: grade (rho, LmaxRatio, shape); S: shape settings from config
   *   S.mode: 'rock' | 'sphere' | 'clump2' | 'clump3'
   *   S.orient: 'random' | 'inplane'; S.capL: bool; S.useMeasured: bool
   */
  function makeStone(m, g, S, r, maxSubR) {
    const rho = g.rho, Dn = Math.cbrt(m / rho);
    const sh = g.shape || FP.grades.defaultShape();
    let subs, a, b, L, B, T, LT, rot = 0, capped = false, measured = false;
    if (S.mode === 'sphere') {
      const R = Math.cbrt(K6PI) * Dn / 2; // equal-volume sphere radius
      subs = [[0, 0, R]]; a = b = R; L = B = T = 2 * R; LT = 1;
    } else if (S.mode === 'clump2' || S.mode === 'clump3') {
      // legacy fixed clumps (V1), sized to the equal-volume ellipsoid L x d x d
      const e = Math.max(1, S.elong);
      const d = Math.cbrt(K6PI * Dn * Dn * Dn / e); L = e * d; B = T = d; LT = e;
      if (S.mode === 'clump2') { const off = (L - d) / 2; subs = [[-off, 0, d / 2], [off, 0, d / 2]]; }
      else { const off = (L - d) / 2 + 0.04 * d; subs = [[-off, -0.12 * d, 0.5 * d], [off, -0.12 * d, 0.42 * d], [0.15 * off, 0.22 * d, 0.45 * d]]; }
      a = L / 2; b = d / 2;
    } else if (S.shapeModel !== 'lt') {
      // ---- shape-class model ----
      const ms = sh.measuredSub;
      let cls, bl, tb;
      if (S.useMeasured && ms && r() < ms.frac) {
        // measured elongated records: L/T from data, split between B/L and T/B equally (assumption)
        LT = ms.LTlo + (ms.LThi - ms.LTlo) * r(); measured = true; cls = CLASSES[3];
        bl = tb = 1 / Math.sqrt(LT);
      } else {
        const mix = sh.mix || DEFAULT_MIX;
        const LTmaxCap = sh.classLTmax || 99;
        for (let k = 0; k < 30; k++) {
          cls = pickClass(mix, r);
          bl = cls.bl[0] + (cls.bl[1] - cls.bl[0]) * r();
          tb = cls.tb[0] + (cls.tb[1] - cls.tb[0]) * r();
          if (1 / (bl * tb) <= LTmaxCap) break;
        }
        LT = 1 / (bl * tb);
      }
      const vf = cls.outline === 'round' ? Math.PI / 6 : (sh.vfBlock || cls.vf);
      // vf L B T = Dn^3 with B = bl L, T = tb B
      L = Math.cbrt(Dn * Dn * Dn / (vf * bl * bl * tb)); B = bl * L; T = tb * B;
      if (S.capL && g.LmaxRatio && L > g.LmaxRatio * Dn) { L = g.LmaxRatio * Dn; B = Math.sqrt(Dn * Dn * Dn / (vf * L * tb)); T = tb * B; capped = true; LT = L / T; }
      const irr = sh.irregular * (S.irregularScale == null ? 1 : S.irregularScale);
      if (cls.outline === 'round') {
        if (S.orient === 'inplane') { a = L / 2; b = B / 2; } else { const p = project(randomRotation(r), L / 2, B / 2, T / 2); a = p.a; b = p.b; rot = p.ang; }
        subs = clumpEllipse(a, b, irr * 0.3, r);
      } else {
        if (S.orient === 'inplane') { a = L / 2; b = B / 2; } else { const p = projectBox(randomRotation(r), L / 2, B / 2, T / 2); a = Math.max(p.a, p.b); b = Math.min(p.a, p.b); rot = p.ang + (p.a < p.b ? Math.PI / 2 : 0); }
        subs = clumpBlock(a, b, sh.corner == null ? 0.3 : sh.corner, irr, r);
      }
      var shapeCls = cls.id, boxLike = cls.outline !== 'round', vfUsed = vf;
    } else {
      const ms = sh.measuredSub;
      if (S.useMeasured && ms && r() < ms.frac) { LT = ms.LTlo + (ms.LThi - ms.LTlo) * r(); measured = true; }
      else LT = truncNormal(r, sh.LTmean, sh.LTsd, Math.max(1, sh.LTmin), Math.max(sh.LTmin, sh.LTmax));
      const phi = sh.phi;
      // T^3 * LT^(1+phi) = 6/pi * Dn^3
      if (S.capL && g.LmaxRatio) {
        const LTcap = Math.pow(g.LmaxRatio / Math.cbrt(K6PI), 3 / (2 - phi));
        if (LT > LTcap) { LT = Math.max(1, LTcap); capped = true; }
      }
      T = Math.cbrt(K6PI * Dn * Dn * Dn / Math.pow(LT, 1 + phi));
      L = LT * T; B = Math.pow(LT, phi) * T;
      if (S.orient === 'inplane') { a = L / 2; b = B / 2; }
      else { const p = project(randomRotation(r), L / 2, B / 2, T / 2); a = p.a; b = p.b; rot = p.ang; }
      subs = clumpEllipse(a, b, sh.irregular * (S.irregularScale == null ? 1 : S.irregularScale), r);
    }
    // limit sub-sphere size to the neighbour grid (scales the whole stone if exceeded)
    let rmax = 0; subs.forEach(s => { rmax = Math.max(rmax, s[2]); });
    if (maxSubR && rmax > maxSubR) { const f = maxSubR / rmax; subs.forEach(s => { s[0] *= f; s[1] *= f; s[2] *= f; }); a *= f; b *= f; }
    // centroid of circle areas
    let wx = 0, wy = 0, ws = 0;
    subs.forEach(s => { const w = s[2] * s[2]; wx += w * s[0]; wy += w * s[1]; ws += w; });
    subs.forEach(s => { s[0] -= wx / ws; s[1] -= wy / ws; });
    let br = 0, rmin = Infinity;
    subs.forEach(s => { br = Math.max(br, Math.hypot(s[0], s[1]) + s[2]); rmin = Math.min(rmin, s[2]); });
    return {
      m, Dn, L, B, T, LT, a, b, rot, subs, br, rmin, capped, measured,
      cls: shapeCls || 'ellipsoid',
      I: boxLike ? m * (a * a + b * b) / 3 : m * (a * a + b * b) / 5,
      areaPlane: boxLike ? 4 * a * b * 0.92 : Math.PI * a * b,
      // mean projected area = surface / 4 (Cauchy); blocks slightly larger than the ellipsoid of the same axes
      dragArea: ellipsoidArea(L / 2, B / 2, T / 2) / 4 * (boxLike ? Math.pow((vfUsed || 0.6) / (Math.PI / 6), 2 / 3) : 1),
      vf: vfUsed || Math.PI / 6
    };
  }

  function describe(S, g) {
    if (S.mode === 'sphere') return 'Equal-volume spheres. Fastest; no shape interlocking.';
    if (S.mode === 'clump2') return 'Legacy rigid 2-sphere clumps, L/d = ' + S.elong + '.';
    if (S.mode === 'clump3') return 'Legacy rigid 3-sphere clumps, L/d ~ ' + S.elong + '.';
    const sh = g.shape;
    if (S.shapeModel !== 'lt') {
      const mix = sh.mix || DEFAULT_MIX; let tot = 0; CLASSES.forEach(c => { tot += Math.max(0, mix[c.id] || 0); });
      return 'Shape classes (Zingg): ' + CLASSES.map(c => c.name.split(' (')[0].toLowerCase() + ' ' + Math.round(100 * Math.max(0, mix[c.id] || 0) / (tot || 1)) + ' %').join(', ') +
        '. Angular classes drawn as blocks with corners (volume factor ' + (sh.vfBlock || 0.6) + ' L B T), rounded class as ellipsoid. ' +
        (S.orient === 'inplane' ? 'Long axis in plane (worst case).' : 'Random 3D orientation, shadow projected to the plane.') +
        (S.useMeasured && sh.measuredSub ? ' Measured sub-population ' + (sh.measuredSub.frac * 100).toFixed(1) + ' % at L/T ' + sh.measuredSub.LTlo + ' to ' + sh.measuredSub.LThi + '.' : '') +
        (sh.classLTmax ? ' L/T capped at ' + sh.classLTmax + ' (unrecorded stones).' : '') + ' Mix source: ' + (sh.mixSrc || 'assumption') + '.';
    }
    return 'Rock shape model: ellipsoid L x B x T with L/T ~ N(' + sh.LTmean + ', ' + sh.LTsd + ') in [' + sh.LTmin + ', ' + sh.LTmax + '], B = T (L/T)^' + sh.phi +
      (S.useMeasured && sh.measuredSub ? ', plus measured sub-population ' + (sh.measuredSub.frac * 100).toFixed(1) + ' % at L/T ' + sh.measuredSub.LTlo + ' to ' + sh.measuredSub.LThi : '') +
      ', ' + (S.orient === 'inplane' ? 'long axis in plane (worst case)' : 'random 3D orientation projected to the plane') +
      ', up to 7 circles, irregularity ' + sh.irregular + (S.capL && g.LmaxRatio ? ', L capped at ' + g.LmaxRatio + ' Dn' : '') + '. Shape source: ' + sh.src + '.';
  }

  FP.shapes = { makeStone, describe, project, projectBox, randomRotation, clumpEllipse, clumpBlock, ellipsoidArea, truncNormal, CLASSES, DEFAULT_MIX };
})(self.FP = self.FP || {});
