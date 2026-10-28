/* ==========================================================================
 * geometry.js
 * Builds the 2D section geometry (vertical plane through the pipe axis)
 * for the DEM window.
 *
 * World frame: x horizontal, y vertical UP, metres. Window inlet centre at
 * (0,0). Local axial coordinate s runs downstream from the window inlet
 * (s = 0) to the window outlet (s = L). geo.s0Global gives the depth of the
 * window inlet along the full string, so reports can show global positions.
 * The feed chute occupies -feedLen < s < 0.
 * Lateral coordinate n along w = (-uy, ux):
 *   n < 0 -> side A (bucket: left wall,  inclined: LOWER wall)
 *   n > 0 -> side B (bucket: right wall, inclined: UPPER wall)
 *
 * Every wall is a closed convex quadrilateral (inner face, lip, outer face,
 * top) so wall thickness, lips and overlap ledges are real collision faces.
 * Each segment carries a material index for contact properties.
 * ========================================================================== */
(function (FP) {
  'use strict';

  const SIDE_A = 1, SIDE_B = 2;

  function addPoly(geo, pts, side, tags, meta) {
    geo.polys.push(Object.assign({ pts, side }, meta));
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      geo.segments.push({ x1: p[0], y1: p[1], x2: q[0], y2: q[1], side, tag: tags[i], feed: !!meta.feed, bucket: meta.bucket, mat: meta.mat || 0 });
    }
  }

  function matIndex(geo, id) {
    let k = geo.mats.indexOf(id);
    if (k < 0) { geo.mats.push(id); k = geo.mats.length - 1; }
    return k;
  }

  function buildBucket(cfg, geo, materials) {
    const rhoW = cfg.physics.fluid ? cfg.physics.rhoF : 1025;
    const str = FP.string.build(cfg, materials, rhoW, cfg.physics.g);
    const win = FP.string.windowOf(cfg, str);
    geo.string = str; geo.window = win;
    // pipe shape (angles per bucket) from the shape module
    geo.shape = FP.catenary ? FP.catenary.solve(cfg, str) : null;
    const list = str.buckets.slice(win.start - 1, win.end);
    const s0g = list[0].sTop / 1000;
    geo.s0Global = s0g;
    geo.axis = { ox: 0, oy: 0, ux: 0, uy: -1, wx: 1, wy: 0 };
    geo.axisAngleH = Math.PI / 2;
    geo.sideNames = { A: 'left wall', B: 'right wall' };
    geo.buckets = [];
    list.forEach((b, i) => {
      const rT = b.dTop / 2000, rB = b.dBot / 2000, h = b.h / 1000, th = b.th / 1000;
      const sTop = b.sTop / 1000 - s0g, sBot = b.sBot / 1000 - s0g;
      const yT = -sTop, yB = -sBot;
      const mk = matIndex(geo, b.mat);
      const rec = { i, gi: b.gi, stack: b.stack, idx: b.idx, sTop, sBot, rT, rB, h, t: b.t / 1000, th, ins: b.ins / 1000, mat: b.mat };
      geo.buckets.push(rec);
      addPoly(geo, [[rT, yT], [rB, yB], [rB + th, yB], [rT + th, yT]], SIDE_B, ['inner', 'lip', 'outer', 'top'], { bucket: i, mat: mk });
      addPoly(geo, [[-rT - th, yT], [-rB - th, yB], [-rB, yB], [-rT, yT]], SIDE_A, ['outer', 'lip', 'inner', 'top'], { bucket: i, mat: mk });
    });
    const last = geo.buckets[geo.buckets.length - 1];
    geo.L = last.sBot;
    geo.inletWidth = list[0].dTop / 1000;
    geo.widthAt = function (s) {
      if (s < 0) return geo.inletWidth;
      let w = Infinity;
      for (const bk of geo.buckets) {
        if (s >= bk.sTop && s <= bk.sBot) w = Math.min(w, 2 * (bk.rT - (bk.rT - bk.rB) * (s - bk.sTop) / bk.h));
      }
      return isFinite(w) ? w : 2 * last.rB;
    };
    geo.buckets.forEach((bk, i) => {
      const lab = 'S' + bk.stack + '.B' + bk.idx;
      geo.features.push({ s: bk.sBot, kind: 'opening', label: lab + ' bottom opening', width: 2 * bk.rB });
      if (i < geo.buckets.length - 1) {
        const nx = geo.buckets[i + 1];
        const lowR = nx.rT - (nx.rT - nx.rB) * (bk.sBot - nx.sTop) / nx.h;
        geo.features.push({ s: nx.sTop, kind: 'overlap', s2: bk.sBot, label: 'Overlap ' + lab + '/S' + nx.stack + '.B' + nx.idx, width: 2 * lowR });
        geo.features.push({ s: bk.sBot, kind: 'ledge', label: 'Lip step ' + lab, gap: lowR - (bk.rB + bk.th) });
      }
    });
    geo.feedMat = geo.buckets[0].mat;
  }

  function buildInclined(cfg, geo) {
    const I = cfg.pipe.inclined;
    const D = I.d / 1000, L = I.L / 1000, t = I.t / 1000;
    const thH = (I.angleRef === 'horizontal' ? I.angle : 90 - I.angle) * Math.PI / 180;
    const ux = Math.cos(thH), uy = -Math.sin(thH);
    const wx = -uy, wy = ux;
    geo.axis = { ox: 0, oy: 0, ux, uy, wx, wy };
    geo.axisAngleH = thH;
    geo.sideNames = { A: 'lower wall', B: 'upper wall' };
    geo.L = L; geo.inletWidth = D; geo.s0Global = 0;
    geo.incline = { D, L, t, thH };
    const P = (s, n) => [s * ux + n * wx, s * uy + n * wy];
    const mk = matIndex(geo, I.mat);
    addPoly(geo, [P(0, -D / 2), P(L, -D / 2), P(L, -D / 2 - t), P(0, -D / 2 - t)], SIDE_A, ['inner', 'lip', 'outer', 'top'], { bucket: 0, mat: mk });
    addPoly(geo, [P(0, D / 2 + t), P(L, D / 2 + t), P(L, D / 2), P(0, D / 2)], SIDE_B, ['outer', 'lip', 'inner', 'top'], { bucket: 0, mat: mk });
    geo.widthAt = () => D;
    geo.features.push({ s: L, kind: 'opening', label: 'Pipe outlet', width: D });
    geo.feedMat = I.mat;
  }

  /**
   * Feed zone above the window inlet. Straight chute, or (funnel on) a
   * converging hopper / funnel from the funnel top width down to the pipe
   * top ID, as at the moonpool feed point.
   */
  function buildFeed(cfg, geo) {
    const A = geo.axis, fl = geo.feedLen, W = geo.inletWidth;
    const F = cfg.pipe.funnel || {};
    const Wt = F.on ? Math.max(W, F.topWidth / 1000) : W;
    geo.feedTopWidth = Wt;
    const inner = geo.widthAt;
    geo.widthAt = (s) => s < 0 ? W + (Wt - W) * Math.min(1, -s / fl) : inner(s);
    const t = 0.02;
    const mk = matIndex(geo, geo.feedMat);
    const P = (s, n) => [A.ox + s * A.ux + n * A.wx, A.oy + s * A.uy + n * A.wy];
    addPoly(geo, [P(-fl, -Wt / 2), P(0, -W / 2), P(0, -W / 2 - t), P(-fl, -Wt / 2 - t)], SIDE_A, ['inner', 'lip', 'outer', 'top'], { feed: true, bucket: -1, mat: mk });
    addPoly(geo, [P(-fl, Wt / 2 + t), P(0, W / 2 + t), P(0, W / 2), P(-fl, Wt / 2)], SIDE_B, ['outer', 'lip', 'inner', 'top'], { feed: true, bucket: -1, mat: mk });
    if (F.on) geo.features.push({ s: 0, kind: 'opening', label: 'Funnel outlet / pipe inlet', width: W });
  }

  function build(cfg, materials) {
    materials = materials || cfg.materials;
    const geo = { type: cfg.pipe.type, segments: [], polys: [], features: [], mats: [], feedLen: cfg.pipe.feedLen / 1000 };
    if (cfg.pipe.type === 'bucket') buildBucket(cfg, geo, materials); else buildInclined(cfg, geo);
    buildFeed(cfg, geo);
    const A = geo.axis;
    geo.sOf = (x, y) => (x - A.ox) * A.ux + (y - A.oy) * A.uy;
    geo.nOf = (x, y) => (x - A.ox) * A.wx + (y - A.oy) * A.wy;
    geo.toWorld = (s, n) => [A.ox + s * A.ux + n * A.wx, A.oy + s * A.uy + n * A.wy];
    // temporary gate across the window outlet (restart case: the column settles on it, then it opens)
    if (cfg.feed && cfg.feed.prefill) {
      const w2 = geo.widthAt(geo.L) / 2 + 0.05, gt = 0.03;
      const P = (s, n) => [A.ox + s * A.ux + n * A.wx, A.oy + s * A.uy + n * A.wy];
      addPoly(geo, [P(geo.L, -w2), P(geo.L + gt, -w2), P(geo.L + gt, w2), P(geo.L, w2)], 0, ['gate', 'gate', 'gate', 'gate'], { bucket: -2, mat: 0, gate: true });
    }
    geo.minPassage = Infinity;
    const N = 400;
    for (let k = 0; k <= N; k++) geo.minPassage = Math.min(geo.minPassage, geo.widthAt(geo.L * k / N));
    geo.exitS = geo.L + Math.max(0.4, 0.3 * geo.inletWidth);
    // in-pipe area of the section (for capacity sizing)
    let area = geo.feedLen * (geo.inletWidth + geo.feedTopWidth) / 2;
    for (let k = 0; k < N; k++) area += geo.widthAt(geo.L * (k + 0.5) / N) * geo.L / N;
    geo.area = area + (geo.exitS - geo.L) * geo.widthAt(geo.L);
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    const grow = (p) => { xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]); ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); };
    geo.polys.forEach(pl => pl.pts.forEach(grow));
    const wOut = geo.widthAt(geo.L);
    grow(geo.toWorld(geo.exitS, -wOut)); grow(geo.toWorld(geo.exitS, wOut));
    const m = 0.25;
    geo.bbox = { xmin: xmin - m, xmax: xmax + m, ymin: ymin - m, ymax: ymax + m };
    return geo;
  }

  FP.geometry = { build, SIDE_A, SIDE_B };
})(self.FP = self.FP || {});
