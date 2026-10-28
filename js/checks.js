/* ==========================================================================
 * checks.js
 * Analytical checks and empirical correlations, kept separate from the DEM.
 * Each item is tagged:
 *   'analytical'  follows from geometry, continuity or basic mechanics
 *   'empirical'   published correlation fitted to experiments that differ
 *                 from this system; indicative only, never a prediction
 *   'assumption'  input value without a source
 * Sources are listed in the Method tab.
 * ========================================================================== */
(function (FP) {
  'use strict';

  function run(cfg, geom, fac, dv) {
    const out = [];
    const C = cfg.checks, P = cfg.physics, G = cfg.grade;
    const Dc = geom.minPassage;               // narrowest clear passage in the DEM window [m]
    const Dstr = geom.string ? geom.string.totals.minClear / 1000 : Dc; // whole string
    const smp = fac.stats.sample;
    const n = smp.length;
    const frac = (f) => smp.filter(f).length / n;
    const mFrac = (f) => smp.filter(f).reduce((a, s) => a + s.m, 0) / smp.reduce((a, s) => a + s.m, 0);
    const Dn50 = fac.stats.Dn50, Dn90 = fac.stats.Dn90;
    const LmaxS = Math.max.apply(null, smp.map(s => s.L)), BmaxS = Math.max.apply(null, smp.map(s => s.B));
    const fmt = (v, d) => (v == null || !isFinite(v)) ? 'n/a' : (+v).toFixed(d == null ? 2 : d);

    // ---- analytical: geometry vs generated stone dimensions ----
    out.push({ tag: 'analytical', name: 'Clear passage (narrowest, whole string / DEM window)', value: fmt(Dstr * 1000, 0) + ' / ' + fmt(Dc * 1000, 0) + ' mm' });
    out.push({ tag: 'analytical', name: 'Clear passage / Dn50 and / Dn90 (generated)', value: fmt(Dstr / Dn50) + ' and ' + fmt(Dstr / Dn90) });
    out.push({ tag: 'analytical', name: 'Largest generated L and B (sample of ' + n + ')', value: fmt(LmaxS * 1000, 0) + ' mm and ' + fmt(BmaxS * 1000, 0) + ' mm' });
    const fB = frac(s => s.B >= Dstr), fL = frac(s => s.L >= Dstr);
    out.push({ tag: 'analytical', name: 'Stones with intermediate axis B >= clear passage', value: fmt(fB * 100, 2) + ' % by number', level: fB > 0 ? 3 : 0,
      note: 'A stone whose intermediate axis exceeds a round opening cannot pass in any orientation (sieve principle). Any value above zero means single-stone obstruction is certain to occur eventually.' });
    out.push({ tag: 'analytical', name: 'Stones with length L >= clear passage', value: fmt(fL * 100, 2) + ' % by number, ' + fmt(mFrac(s => s.L >= Dstr) * 100, 2) + ' % by mass', level: fL > 0 ? 1 : 0,
      note: 'These stones can only pass when aligned with the flow; misaligned, they can span the opening and seed an arch.' });
    if (G.LmaxRatio) {
      const lims = (G.limits || []).filter(l => l.Lmax);
      if (lims.length) {
        const eul = lims[lims.length - 1];
        out.push({ tag: 'analytical', name: 'Grade-table maximum expected length at ' + eul.name + ' vs clear passage', value: eul.Lmax + ' mm vs ' + fmt(Dstr * 1000, 0) + ' mm (ratio ' + fmt(Dstr * 1000 / eul.Lmax) + ')', level: eul.Lmax >= Dstr * 1000 ? 1 : 0 });
      }
    }

    // ---- analytical: continuity with hindered settling ----
    if (P.fluid) {
      const vt = dv.vTerm50, beta = C.rzBeta;
      const cvOpt = 1 / (1 + beta);
      const fluxMax = G.rho * vt * cvOpt * Math.pow(1 - cvOpt, beta); // kg/s/m2
      const A = Math.PI * Dstr * Dstr / 4;
      const qMax = fluxMax * A * 3.6; // t/h
      const qReq = cfg.feed.mode === 'mass' ? cfg.feed.massFlow : dv.massRateSlice * dv.toTph;
      out.push({ tag: 'analytical', name: 'Terminal velocity of Dn50 in still water (Newton drag, Cd ' + P.cd + ')', value: fmt(vt) + ' m/s' });
      out.push({ tag: 'empirical', name: 'Max. free-settling solids flux through the narrowest passage (Richardson-Zaki, beta ' + beta + ')', value: fmt(qMax, 0) + ' t/h at Cv = ' + fmt(cvOpt, 3) + ' vs required ' + fmt(qReq, 0) + ' t/h', level: qReq > qMax ? 1 : 0,
        note: 'Continuity check without entrained water. Downward water flow induced by the rock raises the real capacity, so exceeding this value signals dense flow, not certain blockage.' });
    }

    // ---- analytical: dry part in the moonpool ----
    if (P.fluid && dv.dryV > 0) {
      out.push({ tag: 'analytical', name: 'Stone speed at the water surface (free fall in air from the pipe top)', value: fmt(dv.vEntry) + ' m/s after ' + fmt(dv.dryV, 1) + ' m (release ' + fmt(dv.v0) + ' m/s) vs terminal velocity of Dn50 in water ' + fmt(dv.vTerm50) + ' m/s',
        note: 'v = sqrt(v0^2 + 2 g H), air drag neglected (it removes under 1 % over a few metres for stones this size). Stones enter the water faster than their terminal velocity and are decelerated by drag below the surface.' });
    }
    // ---- analytical: pipe shape (tilt, current, ROV) ----
    const SH = geom.shape;
    if (SH && SH.mode !== 'vertical') {
      const lim = cfg.pipe.shape.topLimit;
      out.push({ tag: 'analytical', name: 'Pipe shape (' + ({ tilt: 'straight tilt', joints: 'top angle + change per joint', current: 'static chain in current' })[SH.mode] + ')',
        value: 'top ' + fmt(SH.topAngle, 1) + ' deg, bottom ' + fmt(SH.bottomAngle, 1) + ' deg, tip offset ' + fmt(SH.offset, 2) + ' m, max bow ' + fmt(SH.maxBow, 2) + ' m' +
          (SH.mode === 'current' && !SH.slack ? '; drag on string ' + fmt(SH.dragPipe / 1000, 1) + ' kN, on ROV ' + fmt(SH.Fd / 1000, 1) + ' kN' + (SH.rovOn ? ', ROV thrust needed ' + fmt(Math.abs(SH.thrust) / 1000, 1) + ' of ' + fmt(SH.thrustMax / 1000, 0) + ' kN' + (SH.held ? '' : ' (LIMIT, tip drifts)') : '') + ', top tension ' + fmt(SH.Ttop / 1000, 0) + ' kN' : ''),
        level: SH.slack ? 3 : (Math.abs(SH.topAngle) > lim || (SH.rovOn && !SH.held) ? 2 : 0),
        note: 'Articulated chain, one rigid link per bucket: tan theta = H / T, with T the weight below (ROV / bottom weight, buckets in water, chains) and H the horizontal force below (ROV force plus Morison drag 1/2 rho Cd D U_rel^2 per metre). With the ROV holding the tip, H at the bottom is set so the tip offset matches the target. Static: no vessel motion, no vortex-induced vibration.' + (SH.warnings.length ? ' ' + SH.warnings.join(' ') : '') });
      if (Math.abs(SH.topAngle) > lim) out.push({ tag: 'analytical', name: 'Pipe angle in the moonpool vs allowed', value: fmt(Math.abs(SH.topAngle), 1) + ' deg > ' + lim + ' deg', level: 2, note: 'Allowed angle is design dependent (7 deg while dumping for the design in patent US8628287).' });
      const jo = SH.joints.filter(j => j.over);
      if (jo.length) out.push({ tag: 'analytical', name: 'Joint angles above the geometric tilt limit', value: jo.length + ' joint(s), e.g. ' + jo[0].upper + '/' + jo[0].lower + ': ' + fmt(jo[0].angle, 2) + ' deg > ' + fmt(jo[0].limit, 1) + ' deg', level: 2, note: 'tan(limit) = 2 c / ins (radial clearance at the lip, insertion length). Above it the lip bears on the lower bucket.' });
      // lateral drift to the lower wall
      const thMax = SH.maxAngle * Math.PI / 180;
      if (thMax > 0.005 && P.fluid) {
        const vlat = dv.vTerm50 * Math.sqrt(Math.sin(thMax)), tCross = Dstr / vlat;
        out.push({ tag: 'analytical', name: 'Stones drifting to the lower wall at the largest angle (' + fmt(SH.maxAngle, 1) + ' deg)', value: 'lateral settling ' + fmt(vlat, 2) + ' m/s, crosses the ' + fmt(Dstr * 1000, 0) + ' mm passage in about ' + fmt(tCross, 1) + ' s; axial drive of a sliding stone reduced to ' + fmt((Math.cos(thMax) - P.muPW * Math.sin(thMax)) * 100, 1) + ' %',
          note: 'Lateral terminal velocity v_t sqrt(sin theta) (Newton drag) and a = g\' (cos theta - mu sin theta) for a stone sliding on the wall. Tilted pipes carry the rock as a dense layer on the lower wall; the DEM resolves this with the rotated gravity.' });
      }
    }
    // ---- analytical: steady entrained water flow (sealed pipe) ----
    if (P.fluid && cfg.water && cfg.water.model === 'coupled' && dv.dryV > 0) {
      // pipe top in air: no water enters from the top. A sealed string has no steady flow;
      // the inside level drops until the hydrostatic deficit carries the rock drag.
      let Ltot = geom.L, D = Dstr;
      if (geom.string) { const B = geom.string.buckets; Ltot = geom.string.totals.length; D = B.reduce((a, b) => a + b.dBot, 0) / B.length / 1000; }
      const Lw = Math.max(0, Ltot - dv.sDryG), A = Math.PI * D * D / 4, rho = P.rhoF, rs = G.rho;
      const mdot = cfg.feed.mode === 'mass' ? cfg.feed.massFlow / 3.6 : dv.massRateSlice / dv.sliceFactor;
      const sinA = Math.sin(geom.axisAngleH), vt = dv.vTerm50 * Math.sqrt(Math.max(sinA, 0.05)), beta = C.rzBeta;
      let Cv = 0, vr = vt;
      for (let i = 0; i < 100; i++) { vr = vt * Math.pow(Math.max(0.05, 1 - Cv), beta); Cv = Math.min(0.6, mdot / (rs * A * vr)); }
      const Fm = (rs - rho) / rs * P.g * sinA * mdot / vr;
      const z = Fm * Lw / (A * rho * P.g);
      out.push({ tag: 'analytical', name: 'Water level drawdown inside the pipe, sealed string (upper bound)', value: fmt(z, 2) + ' m below the moonpool water level' + (z > Lw * sinA ? ' (exceeds the wet pipe length: the pipe would empty in this idealisation)' : ''),
        note: 'Pipe top in air: no water can enter from the top. With sealed joints there is no steady through-flow, so the inside level drops until rho g z A equals the rock drag on the water column, F\' L_wet, with F\' = (rho_s - rho_w)/rho_s g mdot / v_s and v_s from Richardson-Zaki in still water. Joint leakage (' + (cfg.water.leakage ? 'on' : 'off') + ') feeds a through-flow and reduces the drawdown; the coupled value is shown live.' });
    }
    if (P.fluid && cfg.water && cfg.water.model === 'coupled' && !(dv.dryV > 0)) {
      let Ltot = geom.L, D = Dstr, Kx = 0, rough = 0;
      if (geom.string) {
        const B = geom.string.buckets;
        Ltot = geom.string.totals.length;
        geom.string.transitions.forEach(tr => { const a = Math.pow(B[tr.upper - 1].dBot / tr.idLowAtLip, 2); Kx += Math.pow(1 - a, 2); });
        D = B.reduce((a, b) => a + b.dBot, 0) / B.length / 1000;
        rough = (FP.materials.find(cfg.materials, B[0].mat).rough || 0) / 1000;
      } else rough = (FP.materials.find(cfg.materials, cfg.pipe.inclined.mat).rough || 0) / 1000;
      const est = FP.water.steadyEstimate(cfg, geom, dv, Ltot, D, rough, Kx);
      if (est) out.push({ tag: 'analytical', name: 'Steady entrained water velocity, sealed pipe (momentum balance)', value: fmt(est.u) + ' m/s at the bucket bottom ID, ' + fmt(est.Q) + ' m3/s; stone velocity ' + fmt(est.vr) + ' m/s, Cv ' + fmt(est.Cv, 3),
        note: 'Submerged rock weight per metre (all transferred to the water through drag) balanced by the entrance loss (' + cfg.water.Kin + '), wall friction and ' + (geom.string ? geom.string.transitions.length + ' bucket expansions (Borda-Carnot, sum K = ' + fmt(Kx) + ')' : 'no transitions') + ', over ' + fmt(Ltot, 1) + ' m. Slip from Richardson-Zaki. The DEM-coupled value (live view) also includes joint leakage, inertia and the actual stone acceleration in the window.' });
    }

    // ---- empirical: Thomas & Durian (2015) clogging fraction, 3D hopper ----
    {
      const bulk = G.bulkDensity || G.rho * C.packing;
      const A = Math.PI * Dstr * Dstr / 4;
      const tdOne = (d) => {
        const x = (Dstr / d) * (Dstr / d);                                   // A / A_grain
        const F = Math.exp(-C.tdC * (Math.pow(x, C.tdAlpha / 2) - 1));      // fraction of clogging configurations
        const mMean = bulk * A * C.tdEll * d / F;                            // mean mass before clog [kg]
        return { x, F, mMean };
      };
      const a = tdOne(Dn50), b = tdOne(Dn90);
      out.push({ tag: 'empirical', name: 'Thomas & Durian (2015): mean mass before clog, d = Dn50 / Dn90', value: fmtMass(a.mMean) + ' / ' + fmtMass(b.mMean),
        note: 'Fit to dry, monodisperse spheres in 3D hoppers (F = exp[-C (x^(alpha/2) - 1)], C ' + C.tdC + ', alpha ' + C.tdAlpha + ', sampling length ' + C.tdEll + ' d). Not validated for submerged, polydisperse, angular rock in a fall pipe. Bulk density ' + (G.bulkDensity ? 'from grade' : 'assumed from packing ' + C.packing) + '.' });
    }
    // ---- empirical: 3D narrow vertical pipes (Janda et al. 2015) vs this 2D model ----
    {
      const d95 = (() => { const it = smp.map(s => ({ d: s.Dn, m: s.m })); return FP.particles.massPercentile(it, 0.95); })();
      const r50 = Dstr / Dn50, r95 = Dstr / d95;
      const prone = r50 < 6.8 || r95 < 4.7;
      out.push({ tag: 'empirical', name: '3D pipe clogging range (Janda et al. 2015): D/d50 < 6.8 or D/d95 < 4.7', value: 'D/Dn50 = ' + fmt(r50) + ', D/Dn95 = ' + fmt(r95) + (prone ? ': inside the clogging-prone range for dense flow' : ': outside'), level: prone ? 3 : 0,
        note: 'Dense granular flow in narrow vertical pipes, discharged at constant velocity; faster discharge reduced clogging. A 2D section model only forms three-particle arches (2D pipes clog at D/d about 2.45 to 3, Zhou et al. 2025), so in this range the DEM under-predicts blockage in a round pipe. Use the DEM result for mechanisms and relative comparisons, not as a probability.' });
    }
    // ---- empirical: generated shape vs Rock Manual guidance ----
    if (cfg.shape.mode === 'rock' && fac.stats.lt3M != null) {
      const heavy = /^HM/.test(G.name || '') || (G.kind === 'mass' && G.nominal && G.nominal.lower >= 300);
      const lim = heavy ? 0.05 : 0.20, v = fac.stats.lt3M;
      const cn = fac.stats.clsN || {};
      out.push({ tag: 'empirical', name: 'Share of stones with L/T > 3 (Rock Manual 2007, 3.4.1.6)', value: fmt(v * 100) + ' % by mass (guidance: typically below ' + (lim * 100) + ' % for ' + (heavy ? 'heavier' : 'lighter') + ' gradings)' +
          (Object.keys(cn).length ? '. Number shares: ' + Object.keys(cn).map(k => k + ' ' + Math.round(cn[k] * 100) + ' %').join(', ') : ''), level: v > lim ? 1 : 0,
        note: 'CIRIA/CUR/CETMEF Rock Manual (2007) section 3.4.1.6 and EN 13383-1 (LT > 3 limit). Shape class mix is an input; replace the default with measured L/B/T of the actual rock when available. Fragment shapes on average are cube-like (Domokos et al. 2020).' });
    }
    // ---- empirical: critical size statements ----
    out.push({ tag: 'empirical', name: 'Opening / Dn50 vs reported clogging thresholds', value: fmt(Dstr / Dn50) + ' (spheres: no jams observed above about 4.9; rice-shaped grains: about 6.2)', level: Dstr / Dn50 < 6.2 ? 1 : 0,
      note: 'Zuriguel et al. 2005 (3D silo, monodisperse). Janda et al. 2008 found no true critical size in 2D: jamming probability decays but never reaches zero. Elongated, angular stones need larger openings.' });
    // ---- empirical: Beverloo (dry discharge) ----
    {
      const bulk = G.bulkDensity || G.rho * C.packing;
      const Dk = Dstr - C.bevK * Dn50;
      const W = Dk > 0 ? C.bevC * bulk * Math.sqrt(P.g) * Math.pow(Dk, 2.5) * 3.6 : 0;
      out.push({ tag: 'empirical', name: 'Beverloo dry discharge capacity of the narrowest passage', value: fmt(W, 0) + ' t/h (C ' + C.bevC + ', k ' + C.bevK + ')',
        note: 'For dry granular discharge from a silo. In water the rate is governed by drag; shown only as an order-of-magnitude reference.' });
    }
    // ---- assumptions in force ----
    out.push({ tag: 'assumption', name: 'Bulk packing (used when no bulk density is given)', value: C.packing });
    out.push({ tag: 'assumption', name: 'Beverloo k', value: C.bevK });
    return out;
  }

  function fmtMass(kg) {
    if (!isFinite(kg)) return 'unbounded';
    if (kg > 1e9) return '> 1e6 t';
    return kg >= 1000 ? (kg / 1000).toPrecision(3) + ' t' : kg.toFixed(0) + ' kg';
  }

  FP.checks = { run };
})(self.FP = self.FP || {});
