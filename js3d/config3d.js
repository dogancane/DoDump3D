/* ==========================================================================
 * js3d/config3d.js
 * 3D defaults and derived quantities.
 *
 * The input set is the same as the 2D page (shared config.js), so a 2D
 * configuration loads unchanged. Differences in the derived values:
 *   - no slice: the full mass flow is released (slice factor = 1)
 *   - body capacity from the domain volume, not the section area
 *   - solid fraction thresholds are VOLUME fractions (2D uses in-plane area)
 * Contact stiffness and time step use the same rules as 2D.
 * ========================================================================== */
(function (FP) {
  'use strict';

  function defaultConfig() {
    const c = FP.config.defaultConfig();
    c.dim = 3;
    c.detect.phiJam = 0.35;   // ASSUMPTION: volume fraction for a dense stalled zone (2D default 0.5 is in-plane area)
    c.run.duration = 20;
    // feed source: 'drop' (released at rest in the feed zone, moving down at v0) or 'conveyor'
    c.feed.source = 'drop';
    c.feed.belt = {
      speed: 3.0,      // m/s, belt speed = horizontal speed of the rock leaving the head pulley
      dir: 0,          // deg, azimuth of the belt direction in the pipe cross-section (0 = +x, the tilt plane)
      drop: 1.0,       // m, height from the head pulley to the release level in the feed zone (adds vertical speed)
      width: 600,      // mm, width of the rock stream across the belt direction
      scatter: 0.15,   // relative scatter of the release velocity
      spin: 0.5        // forward spin as a share of v / r (rolling off the pulley = 1)
    };
    // vessel motion: regular roll, pitch and heave, applied as apparent gravity in the pipe frame
    c.vessel = { on: false, rollAmp: 2, rollT: 9, pitchAmp: 1, pitchT: 7, heaveAmp: 0.5, heaveT: 8, zRC: 8 };
    c.physics.precision = 'high';
    return c;
  }

  /** Bring a 2D configuration into the 3D page (same inputs, 3D-specific thresholds). */
  function from2D(c2) {
    const c = FP.config.clone(c2);
    c.dim = 3;
    if (c.detect && c.detect.phiJam === 0.5) c.detect.phiJam = 0.35;
    return c;
  }

  /**
   * Numerical precision presets (contact stiffness and time step):
   *   standard   inputs as entered (2D defaults: overlap 2 % Dn50 at vChar, dt = 0.15 t_c)
   *   high       overlap <= 1 %, dt <= 0.10 t_c, vChar >= terminal velocity of Dn90
   *   very high  overlap <= 0.5 %, dt <= 0.07 t_c, vChar >= water entry speed of the dry fall
   * Stiffer contacts and smaller steps reduce artificial overlap and softness, at a run time cost
   * that grows with (vChar / overlap) and 1 / tcFactor.
   */
  function presetPhysics(cfg, fac) {
    const P = FP.config.clone(cfg.physics), pr = P.precision || 'standard';
    const st = fac.stats, G = cfg.grade;
    const vT90 = P.fluid ? Math.sqrt(4 / 3 * P.g * st.Dn90 * (G.rho - P.rhoF) / (P.rhoF * P.cd)) : 3;
    const v0 = cfg.feed.v0Mode === 'terminal' ? vT90 : cfg.feed.v0;
    const dry = P.fluid ? Math.max(0, (cfg.pipe.dryLen || 0) / 1000) : 0;
    const vEntry = Math.sqrt(v0 * v0 + 2 * P.g * dry);
    if (pr === 'high') { P.tcFactor = Math.min(P.tcFactor, 0.10); P.overlapPct = Math.min(P.overlapPct, 1.0); P.vChar = Math.max(P.vChar, vT90); }
    if (pr === 'veryhigh') { P.tcFactor = Math.min(P.tcFactor, 0.07); P.overlapPct = Math.min(P.overlapPct, 0.5); P.vChar = Math.max(P.vChar, vEntry, vT90); }
    return { P, vT90, vEntry, pr };
  }

  function derive(cfg, geom, fac) {
    const pp = presetPhysics(cfg, fac);
    const cfgD = Object.assign({}, cfg, { physics: pp.P });
    const dv = FP.config.derive(cfgD, geom, fac);   // shared: stiffness, time step, terminal velocity, dry fall, transit
    dv.precision = { name: pp.pr, tcFactor: pp.P.tcFactor, overlapPct: pp.P.overlapPct, vChar: pp.P.vChar, vEntry: pp.vEntry };
    cfg = cfgD;
    const st = fac.stats, F = cfg.feed;
    dv.sliceFactor = 1;
    dv.massRateSlice = F.mode === 'count' ? F.partRate * st.meanMass : F.massFlow / 3.6;
    dv.partRate = dv.massRateSlice / st.meanMass;
    dv.nominalSliceMassRate = dv.massRateSlice;
    dv.toTph = 3.6;
    dv.warmupAuto = 2 * dv.tTransit + Math.max(cfg.detect.window, 10 / Math.max(dv.partRate, 1e-6));
    dv.warmup = cfg.detect.warmupMode === 'auto' ? dv.warmupAuto : cfg.detect.warmup;
    dv.cap = Math.max(80, Math.min(4000, Math.ceil((geom.volume * 0.65 / st.meanVol + 40) * cfg.physics.capFactor)));
    // Time step: in 3D a clump contact also drives rotation, so the effective mass at the contact
    // is m_rot = 1 / (1/m + d^2/I) (d = distance of the contact from the body axis). The shortest
    // contact time uses the smallest m_rot / (Dn/2) of the stone sample (2D used m / (Dn/2)).
    const P = cfg.physics, rr = st.minRatioRot || st.minRatio;
    dv.tcPP = Math.PI * Math.sqrt(rr * dv.d50 / (4 * dv.kn));
    dv.tcPW = Math.PI * Math.sqrt(rr * dv.d50 / (2 * dv.kn * dv.kRatioMax));
    dv.tc = Math.min(dv.tcPP, dv.tcPW);
    dv.dtAuto = P.tcFactor * dv.tc;
    dv.dt = P.dtMode === 'auto' ? dv.dtAuto : P.dt;
    dv.dtOverTc = dv.dt / dv.tc; dv.stepsPerSecond = 1 / dv.dt;
    dv.dim = 3;
    return dv;
  }

  FP.config3d = { defaultConfig, from2D, derive };
})(self.FP = self.FP || {});
