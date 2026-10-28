/* ==========================================================================
 * units.js
 * Input validation: unit and magnitude checks, grade consistency, bucket
 * nesting feasibility, materials, numerical settings.
 * Returns { errors: [], warnings: [] }. Errors block the run.
 * ========================================================================== */
(function (FP) {
  'use strict';

  function validate(cfg) {
    const E = [], W = [];
    const num = (v) => typeof v === 'number' && isFinite(v);
    const pos = (v, name) => { if (!num(v) || v <= 0) E.push(name + ' must be a positive number.'); };
    const mmRange = (v, name, lo, hi) => {
      if (num(v) && v > 0 && (v < lo || v > hi)) W.push(name + ' = ' + v + ' mm looks unusual (expected ' + lo + ' to ' + hi + ' mm). Check the value is in millimetres, not metres.');
    };
    const mats = cfg.materials || [];
    mats.forEach(m => {
      ['rho', 'E', 'sAllow'].forEach(k => { if (!num(m[k]) || m[k] <= 0) E.push('Material ' + m.name + ': ' + k + ' must be positive.'); });
      if (!(m.nu >= 0 && m.nu < 0.5)) E.push('Material ' + m.name + ': Poisson ratio must be in [0, 0.5).');
      if (!(m.mu >= 0) || !(m.e > 0 && m.e <= 1)) E.push('Material ' + m.name + ': friction must be >= 0 and restitution in (0, 1].');
      if (num(m.E) && (m.E < 1e7 || m.E > 1e12)) W.push('Material ' + m.name + ': E = ' + m.E + ' Pa. Check the unit is Pa (1 GPa = 1e9 Pa).');
    });
    const hasMat = (id) => mats.some(m => m.id === id);

    let minPass = Infinity, inletW = 0;
    if (cfg.pipe.type === 'bucket') {
      const S = cfg.pipe.string;
      if (!(Number.isInteger(S.nStacks) && S.nStacks >= 1 && S.nStacks <= 30)) E.push('Number of stacks must be an integer from 1 to 30.');
      if (!(Number.isInteger(S.bucketsPerStack) && S.bucketsPerStack >= 1 && S.bucketsPerStack <= 19)) E.push('Buckets per stack must be an integer from 1 to 19.');
      (S.stacks || []).forEach((so, i) => { if (so && so.n != null && so.n !== '' && !(so.n >= 1 && so.n <= 19)) E.push('Stack ' + (i + 1) + ': buckets must be 1 to 19.'); });
      if (E.length) return { errors: E, warnings: W };
      const list = FP.string.expand(cfg);
      list.forEach((b, i) => {
        const tag = 'Stack ' + b.stack + ' bucket ' + b.idx + ': ';
        pos(b.dTop, tag + 'top ID'); pos(b.dBot, tag + 'bottom ID'); pos(b.h, tag + 'length');
        mmRange(b.dTop, tag + 'top ID', 200, 5000); mmRange(b.dBot, tag + 'bottom ID', 100, 5000); mmRange(b.h, tag + 'length', 200, 20000);
        if (!num(b.t) || b.t <= 0) E.push(tag + 'wall thickness must be positive.');
        if (!num(b.ins) || b.ins < 0) E.push(tag + 'insertion must be zero or positive.');
        if (b.ins >= b.h) E.push(tag + 'insertion must be less than the bucket length.');
        if (b.dBot > b.dTop) W.push(tag + 'bottom ID is larger than top ID (diverging section).');
        if (!hasMat(b.mat)) E.push(tag + 'material "' + b.mat + '" is not in the material library.');
        minPass = Math.min(minPass, b.dBot);
        if (i === 0) inletW = b.dTop;
      });
      if (!E.length) {
        const str = FP.string.build(cfg, mats, 1025, 9.81);
        str.transitions.forEach(tr => {
          const lab = 'Buckets ' + tr.upper + '/' + tr.lower + (tr.joint ? ' (stack joint)' : '');
          if (tr.clearance <= 0) E.push(lab + ' clash: outer diameter at the upper lip (' + tr.odLip.toFixed(0) + ' mm) does not fit inside the lower bucket at the insertion depth (ID ' + tr.idLowAtLip.toFixed(0) + ' mm).');
          else if (tr.clearance < 5) W.push(lab + ': radial clearance is only ' + tr.clearance.toFixed(1) + ' mm.');
          if (tr.ins === 0) W.push(lab + ': zero insertion, the buckets only touch end to end.');
        });
        const w = FP.string.windowOf(cfg, str);
        if (w.count > 12) W.push('DEM window of ' + w.count + ' buckets is long; runs will be slow.');
        // first window bucket defines the inlet
        inletW = str.buckets[w.start - 1].dTop;
      }
    } else {
      const I = cfg.pipe.inclined;
      pos(I.d, 'Pipe ID'); pos(I.L, 'Pipe length');
      mmRange(I.d, 'Pipe ID', 100, 5000); mmRange(I.L, 'Pipe length', 500, 100000);
      if (!num(I.angle) || I.angle <= 0 || I.angle > 90) E.push('Inclination must be greater than 0 and at most 90 degrees.');
      const thH = I.angleRef === 'horizontal' ? I.angle : 90 - I.angle;
      if (num(thH) && thH < 15) W.push('Pipe is within ' + thH.toFixed(0) + ' deg of horizontal: gravity-driven flow is slow and very sensitive to wall friction.');
      if (!num(I.t) || I.t <= 0) E.push('Wall thickness must be positive.');
      if (!hasMat(I.mat)) E.push('Pipe material "' + I.mat + '" is not in the material library.');
      minPass = I.d; inletW = I.d;
    }
    pos(cfg.pipe.feedLen, 'Feed chute length');
    if (!(cfg.pipe.dryLen >= 0)) E.push('Pipe top above water must be zero or positive.');
    if (cfg.pipe.type === 'bucket' && cfg.pipe.shape && cfg.pipe.shape.mode !== 'vertical') {
      const sh = cfg.pipe.shape, R = sh.rov || {};
      if (sh.mode === 'tilt' || sh.mode === 'joints') {
        if (!(Math.abs(sh.tilt) <= 30)) E.push('Pipe angle must be between -30 and 30 deg.');
        if (sh.mode === 'joints' && !(Math.abs(sh.dJoint) <= 10)) E.push('Angle change per joint must be between -10 and 10 deg.');
      }
      if (sh.mode === 'current') {
        if (!(sh.U0 >= 0 && sh.U0 <= 5)) E.push('Current speed must be between 0 and 5 m/s.');
        if (sh.profile === 'power' && !(sh.depth > 0)) E.push('Water depth must be positive for the power-law current profile.');
        if (!(Math.abs(sh.vVessel) <= 5)) E.push('Vessel speed must be between -5 and 5 m/s.');
        if (!(sh.Cd > 0 && sh.Cd <= 3)) E.push('String drag coefficient must be in (0, 3].');
        if (!(sh.chainW >= 0)) E.push('Chain weight must be zero or positive.');
        if (!(R.W >= 0) || !(R.A >= 0) || !(R.Cd >= 0)) E.push('ROV / bottom weight, area and drag coefficient must be zero or positive.');
        if (R.on && !(R.thrust >= 0)) E.push('ROV maximum thrust must be zero or positive.');
      }
      if (!(sh.topLimit > 0)) E.push('Allowed angle in the moonpool must be positive.');
    }
    if (cfg.physics.fluid && cfg.pipe.dryLen > 0) {
      if (cfg.pipe.dryLen > 20000) W.push('Pipe top more than 20 m above the water: check the input.');
      if (cfg.pipe.type === 'inclined') {
        const I = cfg.pipe.inclined, aH = (I.angleRef === 'horizontal' ? I.angle : 90 - I.angle) * Math.PI / 180;
        const dryAx = cfg.pipe.dryLen / Math.max(0.05, Math.sin(aH));
        if (dryAx >= I.L) E.push('Pipe top above water (' + (cfg.pipe.dryLen / 1000) + ' m vertical = ' + (dryAx / 1000).toFixed(1) + ' m along the pipe) leaves no part of the ' + (I.L / 1000) + ' m side pipe under water.');
        else if (dryAx > 0.5 * I.L) W.push('More than half of the side pipe is above water (' + (dryAx / 1000).toFixed(1) + ' of ' + (I.L / 1000) + ' m along the pipe).');
      }
    }

    // Grade
    const G = cfg.grade;
    if (!G) { E.push('No rock grade selected.'); return { errors: E, warnings: W }; }
    pos(G.rho, 'Rock density');
    if (num(G.rho) && (G.rho < 1500 || G.rho > 4500)) W.push('Rock density ' + G.rho + ' kg/m3 is outside the usual 1500 to 4500 kg/m3 range.');
    if (G.dist.mode === 'empirical' && !(G.measured && G.measured.masses && G.measured.masses.length >= 10)) E.push('Grade "' + G.name + '" uses the measured distribution but has fewer than 10 measured masses.');
    if (G.dist.mode === 'dvalues') {
      const D = G.dvals || {};
      const pts = [['Dmin', D.dMin], ['D10', D.d10], ['D50', D.d50], ['D90', D.d90], ['Dmax', D.dMax]];
      pts.forEach(p => { pos(p[1], p[0]); mmRange(p[1], p[0], 2, 2000); });
      for (let i = 0; i < 4; i++) if (num(pts[i][1]) && num(pts[i + 1][1]) && pts[i][1] > pts[i + 1][1]) E.push('D-values must satisfy Dmin <= D10 <= D50 <= D90 <= Dmax.');
    }
    if (G.kind === 'sieve' && G.dist.mode === 'envelope' && !FP.grades.dnPerD(G)) {
      if (!(cfg.shape.dnPerD > 0.5 && cfg.shape.dnPerD < 1)) E.push('Grade ' + G.name + ' has no class-table D50/Dn50; enter a sieve-to-nominal ratio Dn/D between 0.5 and 1.');
      else W.push('Grade ' + G.name + ': sieve sizes converted to Dn with the class-table average Dn/D = ' + cfg.shape.dnPerD + ' (no grade-specific value given).');
    }
    const sh = G.shape || {};
    if (cfg.shape.mode === 'rock') {
      if (!(sh.LTmin >= 1 && sh.LTmax >= sh.LTmin && sh.LTmax <= 6)) E.push('Shape: L/T limits must satisfy 1 <= min <= max <= 6.');
      if (!(sh.LTsd >= 0) || !(sh.LTmean >= 1)) E.push('Shape: L/T mean must be >= 1 and SD >= 0.');
      if (!(sh.phi >= 0 && sh.phi <= 1)) E.push('Shape: intermediate-axis exponent must be in [0, 1].');
      if (!(sh.irregular >= 0 && sh.irregular <= 0.4)) E.push('Shape: irregularity must be in [0, 0.4].');
      if (cfg.shape.shapeModel !== 'lt') {
        const mx = sh.mix || {}; const ks = ['equant', 'prolate', 'oblate', 'bladed', 'rounded'];
        if (ks.some(k => mx[k] != null && !(mx[k] >= 0))) E.push('Shape classes: shares must be zero or positive.');
        const tot = ks.reduce((a, k) => a + (+mx[k] || 0), 0);
        if (!(tot > 0)) E.push('Shape classes: at least one class share must be above zero.');
        else if (Math.abs(tot - 100) > 0.5) W.push('Shape classes: shares add up to ' + tot.toFixed(1) + ' %, they are normalised to 100 %.');
        if (sh.vfBlock != null && !(sh.vfBlock >= 0.4 && sh.vfBlock <= 1)) E.push('Shape classes: block volume factor must be in [0.4, 1].');
        if (sh.corner != null && !(sh.corner >= 0.15 && sh.corner <= 1)) E.push('Shape classes: corner roundness must be in [0.15, 1].');
      }
    }
    if (cfg.shape.mode === 'clump2' || cfg.shape.mode === 'clump3') { if (!(cfg.shape.elong >= 1 && cfg.shape.elong <= 3)) E.push('Legacy clump elongation L/d must be between 1 and 3.'); }

    // Feed
    const F = cfg.feed;
    if (F.mode === 'count') pos(F.partRate, 'Stone rate'); else pos(F.massFlow, 'Mass flow');
    if (!(F.fillZone > 0 && F.fillZone <= 1)) E.push('Release zone must be between 0 and 1 of the feed length.');
    if (F.prefill && !(F.settle > 0)) E.push('Settling time must be positive.');
    if (cfg.pipe.funnel && cfg.pipe.funnel.on && !(cfg.pipe.funnel.topWidth > inletW)) E.push('Funnel top width must be larger than the pipe top ID (' + inletW + ' mm).');
    if (!(Number.isInteger(F.maxStones) && F.maxStones >= 0)) E.push('Stone limit must be a whole number (0 = continuous).');
    if (F.v0Mode === 'input' && (!num(F.v0) || F.v0 < 0)) E.push('Initial velocity must be zero or positive.');
    pos(F.opening, 'Feed opening');
    if (num(F.opening) && F.opening > inletW) W.push('Feed opening (' + F.opening + ' mm) exceeds the inlet ID (' + inletW + ' mm); it is limited to the inlet.');
    if (num(F.offset) && Math.abs(F.offset) > inletW / 2) E.push('Feed offset places the opening outside the inlet.');

    // Physics
    const P = cfg.physics;
    pos(P.g, 'Gravity');
    ['muPP', 'muPW', 'muRollPP', 'muRollPW'].forEach(k => { if (!num(P[k]) || P[k] < 0) E.push(k + ' must be zero or positive.'); });
    ['ePP', 'ePW'].forEach(k => { if (!num(P[k]) || P[k] <= 0 || P[k] > 1) E.push(k + ' (restitution) must be in (0, 1].'); });
    if (P.fluid) {
      pos(P.rhoF, 'Fluid density'); pos(P.cd, 'Drag coefficient');
      if (num(P.rhoF) && num(G.rho) && P.rhoF >= G.rho) E.push('Fluid density must be lower than rock density.');
    }
    const Wt = cfg.water || {};
    if (P.fluid) {
      if (!(Wt.Ca >= 0 && Wt.Ca <= 2)) E.push('Added-mass coefficient must be between 0 and 2.');
      pos(Wt.mu, 'Water viscosity');
      if (!(Wt.Kin >= 0)) E.push('Entrance loss must be zero or positive.');
      if (!(Wt.CdGap > 0 && Wt.CdGap <= 1)) E.push('Gap discharge coefficient must be in (0, 1].');
      if (Wt.frictionMode === 'fixed') pos(Wt.fDarcy, 'Darcy friction factor');
      pos(Wt.tSmooth, 'Water loading smoothing time');
    }
    pos(P.Erock, 'Rock elastic modulus');
    if (!(P.nuRock >= 0 && P.nuRock < 0.5)) E.push('Rock Poisson ratio must be in [0, 0.5).');
    if (!(P.kRatioMin > 0 && P.kRatioMax >= P.kRatioMin)) E.push('Wall stiffness ratio limits must satisfy 0 < min <= max.');
    if (!(P.ktRatio > 0 && P.ktRatio <= 1)) E.push('kt/kn must be in (0, 1].');
    if (P.kMode === 'auto') { pos(P.overlapPct, 'Target overlap'); pos(P.vChar, 'Characteristic velocity'); if (P.overlapPct > 10) W.push('Target overlap above 10 % of Dn50 makes stones very soft.'); }
    else pos(P.kn, 'Normal stiffness');
    if (P.dtMode === 'auto') { if (!(P.tcFactor > 0 && P.tcFactor <= 0.3)) E.push('dt / t_contact factor must be in (0, 0.3].'); }
    else pos(P.dt, 'Time step');
    if (!(P.capFactor >= 0.3 && P.capFactor <= 4)) E.push('Capacity factor must be between 0.3 and 4.');

    pos(cfg.run.duration, 'Duration');
    if (cfg.run.duration > 86400) E.push('Duration is limited to 24 hours.');
    else if (cfg.run.duration > 600) W.push('Long run (' + (cfg.run.duration / 60).toFixed(0) + ' min of dumping). At 1x it takes the same time in real life; use "As fast as possible" and the Finish button to stop early.');
    const D = cfg.detect;
    pos(D.sampleDt, 'Sampling interval'); pos(D.window, 'Rate window'); pos(D.vStall, 'Stall speed'); pos(D.tPersist, 'Persistence time'); pos(D.binLen, 'Bin length');
    if (num(D.window) && num(D.sampleDt) && D.window < 2 * D.sampleDt) E.push('Rate window must be at least two sampling intervals.');
    if (!(D.rBlock > 0 && D.rBlock < D.rRestrict && D.rRestrict <= 1)) E.push('Thresholds must satisfy 0 < blocked ratio < restricted ratio <= 1.');
    if (!(D.tMinBridge >= 0)) E.push('Minimum bridge duration must be zero or positive.');
    if (!(D.phiJam > 0 && D.phiJam < 0.91)) E.push('Dense solid fraction must be between 0 and 0.91 (2D hexagonal packing limit).');
    void minPass;
    return { errors: E, warnings: W };
  }

  /** Warnings that need derived quantities (time step, stiffness, stones). */
  function numericalChecks(cfg, dv, geom, fac) {
    const W = [];
    if (dv.dtOverTc > 0.2) W.push('Time step is ' + dv.dtOverTc.toFixed(2) + ' of the shortest contact duration. Above about 0.2, contacts are poorly resolved and stones can pass through walls.');
    if (dv.stepsPerSecond * cfg.run.duration > 4e6) W.push('This run needs ' + (dv.stepsPerSecond * cfg.run.duration / 1e6).toFixed(1) + ' million steps and will be slow. Consider a larger overlap target, a shorter window or a shorter duration.');
    if (cfg.detect.binLen / 1000 < fac.stats.Dn50) W.push('Bin length is smaller than Dn50: solid fraction per bin will be noisy.');
    if (dv.warmup > cfg.run.duration) W.push('Detection warm-up upper bound (' + dv.warmup.toFixed(1) + ' s) is longer than the run; detection starts earlier only if stones reach the outlet.');
    if (dv.kRatioMax > 1.5 && cfg.physics.dtMode === 'manual') W.push('A wall material is stiffer than rock in the contact model; check the time step.');
    const raw = dv.wallProps.map(w => w.kRatioRaw);
    if (cfg.physics.wallStiffMode === 'material' && raw.some(r => r < cfg.physics.kRatioMin)) W.push('A wall material is softer than the minimum stiffness ratio (' + cfg.physics.kRatioMin + '); its contact stiffness is clipped. Raw ratio ' + Math.min.apply(null, raw).toFixed(3) + '.');
    if (fac.stats.cappedFrac > 0) W.push((fac.stats.cappedFrac * 100).toFixed(1) + ' % of generated stones were shortened by the Lmax cap.');
    if (fac.sampler.warnings) fac.sampler.warnings.forEach(w => W.push(w));
    if (geom.L < 3 * fac.maxBoundR * 2) W.push('The DEM window is short compared with the largest stone.');
    return W;
  }

  FP.units = { validate, numericalChecks };
})(self.FP = self.FP || {});
