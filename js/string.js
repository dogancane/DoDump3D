/* ==========================================================================
 * string.js
 * Bucket fall-pipe string: stacks -> buckets, transitions, structural data.
 *
 * DATA STRUCTURE (cfg.pipe.string)
 *   nStacks            1..30
 *   bucketsPerStack    1..19 (default for every stack)
 *   stacks[i]          { n, type } optional per-stack override (n, bucket type)
 *   types[]            bucket types: { id, name, dTop, dBot, h, t, ins, mat }
 *                       dTop/dBot internal diameters [mm], h length [mm],
 *                       t wall thickness [mm], ins insertion into the next
 *                       bucket [mm], mat material id
 *   overrides          { "stack.bucket": { field: value } } per-bucket edits
 *   jointIns           insertion at stack-to-stack joints [mm] (null = bucket value)
 *   window             { auto, start, count } buckets simulated by the DEM
 *
 * GEOMETRY (rigid, coaxial; alignment offsets are reserved for the future
 * catenary module and are zero here)
 *   sTop(0) = 0;  sTop(i+1) = sBot(i) - ins(i)
 *   Upper bucket i sits inside bucket i+1 over the insertion length.
 *   Radial clearance at the upper lip:
 *       c = ( ID_{i+1}(z = ins) - OD_i(bottom) ) / 2
 *   Clear flow path through transition i = minimum internal diameter seen by
 *   rock over the overlap zone = min( ID_i(z), ID_{i+1}(z) ) for z in overlap.
 *   The annular pocket (width c, depth ins) is open towards the flow above
 *   the lower bucket's rim and is reported because rock can lodge there.
 *
 * STRUCTURE (per bucket, thin conical shell)
 *   V   = pi h/3 [ (Ro_t^2 + Ro_t Ro_b + Ro_b^2) - (Ri_t^2 + Ri_t Ri_b + Ri_b^2) ]
 *   M   = rho_mat V          Wsub = (rho_mat - rho_water) g V   (negative = buoyant)
 *   A   = pi (Ro_m^2 - Ri_m^2) at mid height      EA, EI = E pi/4 (Ro_m^4 - Ri_m^4)
 *   Nallow = sAllow * A (no safety factor applied)
 * ========================================================================== */
(function (FP) {
  'use strict';

  function typeOf(S, id) { return S.types.find(t => t.id === id) || S.types[0]; }

  /** Expand the string into a flat bucket list (mm inputs kept, SI added). */
  function expand(cfg) {
    const S = cfg.pipe.string, list = [];
    const nS = Math.max(1, Math.min(30, Math.round(S.nStacks)));
    for (let si = 0; si < nS; si++) {
      const so = (S.stacks && S.stacks[si]) || {};
      const n = Math.max(1, Math.min(19, Math.round(so.n || S.bucketsPerStack)));
      const T = typeOf(S, so.type || S.defaultType);
      for (let bi = 0; bi < n; bi++) {
        const ov = (S.overrides && S.overrides[(si + 1) + '.' + (bi + 1)]) || {};
        const b = { stack: si + 1, idx: bi + 1, type: T.id, dTop: T.dTop, dBot: T.dBot, h: T.h, t: T.t, ins: T.ins, mat: T.mat };
        Object.keys(ov).forEach(k => { if (ov[k] !== '' && ov[k] != null) b[k] = ov[k]; });
        b.overridden = Object.keys(ov).length > 0;
        list.push(b);
      }
    }
    // stack joint insertion
    if (S.jointIns != null && S.jointIns !== '') {
      for (let i = 0; i < list.length - 1; i++) if (list[i].stack !== list[i + 1].stack) list[i].ins = S.jointIns;
    }
    list[list.length - 1].insLast = list[list.length - 1].ins;
    return list;
  }

  /** ID at depth z below the top of bucket b (mm in, mm out). */
  const idAt = (b, z) => b.dTop - (b.dTop - b.dBot) * Math.max(0, Math.min(b.h, z)) / b.h;

  function build(cfg, materials, rhoW, g) {
    const list = expand(cfg);
    g = g || 9.81;
    let sTop = 0;
    const out = list.map((b, i) => {
      const rec = Object.assign({}, b, { gi: i + 1 });
      rec.sTop = sTop; rec.sBot = sTop + b.h;
      const slope = (b.dTop - b.dBot) / 2 / b.h;
      rec.th = b.t * Math.sqrt(1 + slope * slope); // horizontal wall thickness [mm]
      const isLast = i === list.length - 1;
      if (!isLast) sTop = rec.sBot - b.ins;
      // structural (SI)
      const m = FP.materials.find(materials, b.mat);
      const Rit = b.dTop / 2000, Rib = b.dBot / 2000, th = rec.th / 1000, h = b.h / 1000;
      const Rot = Rit + th, Rob = Rib + th;
      const V = Math.PI * h / 3 * ((Rot * Rot + Rot * Rob + Rob * Rob) - (Rit * Rit + Rit * Rib + Rib * Rib));
      const Rim = (Rit + Rib) / 2, Rom = Rim + b.t / 1000;
      rec.matName = m.name;
      rec.V = V; rec.mass = m.rho * V; rec.Wsub = (m.rho - rhoW) * g * V;
      rec.A = Math.PI * (Rom * Rom - Rim * Rim);
      rec.EA = m.E * rec.A; rec.EI = m.E * Math.PI / 4 * (Math.pow(Rom, 4) - Math.pow(Rim, 4));
      rec.Nallow = m.sAllow * rec.A;
      rec.innerVol = Math.PI * h / 3 * (Rit * Rit + Rit * Rib + Rib * Rib);
      return rec;
    });
    // transitions
    const trans = [];
    for (let i = 0; i < out.length - 1; i++) {
      const up = out[i], lo = out[i + 1];
      const ins = up.ins;
      const odLip = up.dBot + 2 * up.th;
      const idLowAtLip = idAt(lo, ins);
      const clearance = (idLowAtLip - odLip) / 2;
      // clear path over the overlap zone
      let clear = Infinity;
      for (let k = 0; k <= 20; k++) {
        const s = lo.sTop + ins * k / 20; // global position (mm)
        clear = Math.min(clear, idAt(up, s - up.sTop), idAt(lo, s - lo.sTop));
      }
      const tr = {
        i: i + 1, upper: up.gi, lower: lo.gi, joint: up.stack !== lo.stack,
        s: up.sBot, sOverlapTop: lo.sTop, ins, overlap: ins,
        clearPath: clear, clearance, odLip, idLowAtLip,
        ledge: idLowAtLip / 2 - up.dBot / 2, // radial step from upper lip ID to lower ID at lip depth
        pocketDepth: ins, ok: clearance > 0
      };
      up.clearance = clearance; up.clearPath = clear;
      trans.push(tr);
    }
    const last = out[out.length - 1];
    last.clearance = null; last.clearPath = last.dBot;
    const totals = {
      nBuckets: out.length, nStacks: new Set(out.map(b => b.stack)).size,
      length: last.sBot / 1000,
      mass: out.reduce((a, b) => a + b.mass, 0),
      Wsub: out.reduce((a, b) => a + b.Wsub, 0),
      innerVol: out.reduce((a, b) => a + b.innerVol, 0),
      minClear: Math.min.apply(null, out.map(b => b.clearPath)),
      minClearAt: null
    };
    let best = Infinity;
    out.forEach(b => { if (b.clearPath < best) { best = b.clearPath; totals.minClearAt = b.gi; } });
    return { buckets: out, transitions: trans, totals };
  }

  /** Bucket window simulated by the DEM (1-based global indices). */
  function windowOf(cfg, str) {
    const W = cfg.pipe.string.window, n = str.buckets.length;
    const count = Math.max(1, Math.min(n, Math.round(W.count)));
    let start;
    if (W.auto) {
      // centre on the narrowest clear path (first occurrence), keep one bucket above it
      const c = str.totals.minClearAt || 1;
      start = Math.max(1, Math.min(n - count + 1, c - 1));
    } else start = Math.max(1, Math.min(n - count + 1, Math.round(W.start)));
    return { start, count, end: start + count - 1 };
  }

  FP.string = { expand, build, windowOf, idAt };
})(self.FP = self.FP || {});
