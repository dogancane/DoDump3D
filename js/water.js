/* ==========================================================================
 * water.js
 * Water inside the fall pipe, coupled two-way with the rock DEM.
 *
 * WHAT IS MODELLED
 *  1. Entrained water flow. Falling rock transfers its submerged weight to
 *     the water through drag, so the water column inside the pipe is pulled
 *     downward (the induced flow described for fall pipes by Chen et al.
 *     2015). The flow is 1D along the pipe axis.
 *  2. Hydraulic network along the full string (not only the DEM window):
 *       - moonpool / top inlet: entrance loss K_in plus the velocity head
 *       - each bucket: Darcy wall friction f L/D (Haaland), area change
 *         along the cone (Bernoulli, lossless)
 *       - each bucket transition: the annular gap is an orifice to the sea,
 *         q = Cd_g A_g sqrt(2 |p'| / rho), inflow where the inside pressure
 *         is below ambient (leaky bucket string). Can be switched off.
 *       - outlet: free jet, static pressure equal to ambient
 *     p' is the pressure relative to the outside hydrostatic pressure.
 *     Sudden expansion where a bucket lip discharges into the wider bucket
 *     below: Borda-Carnot loss rho (u1 - u2)^2 / 2.
 *  3. Water inertia. Buckets between open gaps form reaches with one flow
 *     each:  (rho sum L/A) dQ_r/dt = p_(r-1) - p_r + driving - losses,
 *     integrated semi-implicitly. Water starts at rest, so the start-up
 *     transient is part of the result.
 *  4. Rock loading of the water. The DEM drag reaction on the water in the
 *     window (slice) is scaled to 3D by the slice factor and smoothed in
 *     time. ASSUMPTION: the same loading per metre acts along the whole
 *     string (steady-state rock column).
 *  5. Effects on stones (used by physics.js):
 *       - drag on the slip velocity v - u_f, with u_f the interstitial water
 *         velocity Q / (A eps)
 *       - Di Felice (1994) voidage function eps^(2 - chi),
 *         chi = 3.7 - 0.65 exp(-(1.5 - log10 Re)^2 / 2)
 *       - pressure-gradient force -V dp'/ds along the axis
 *       - added mass Ca rho_w V (translation)
 *     Local voidage from the stones in the slice: 3D solid fraction taken as
 *     2/3 of the in-plane area fraction (spheres in a slab one diameter
 *     thick). ASSUMPTION.
 *
 *  6. Dry part in the moonpool (pipe top above water): the string above the
 *     outside water level carries air. The inside water surface is free:
 *     p' = -rho g z at the surface, z = drawdown below the outside level,
 *     dz/dt = Q_top / A (vertical). Through-flow is fed by the joint gaps.
 *     Stones above the inside surface see no water forces (physics.js).
 *
 * NOT MODELLED: radial velocity profile, turbulence, wakes and clustering,
 * air entrainment at the moonpool, the seabed jet, current outside the pipe,
 * vessel motion. Full CFD-DEM (level 3) is needed for those.
 * ========================================================================== */
(function (FP) {
  'use strict';

  /** Darcy friction factor, Haaland (1983) explicit approximation of Colebrook. */
  function haaland(Re, eD) {
    if (!(Re > 0)) return 0;
    if (Re < 2300) return 64 / Re;
    const x = -1.8 * Math.log10(Math.pow(eD / 3.7, 1.11) + 6.9 / Re);
    return 1 / (x * x);
  }

  function Water(cfg, geom, dv) {
    const P = cfg.physics, W = cfg.water;
    this.cfg = cfg; this.geom = geom; this.dv = dv;
    this.on = !!P.fluid && W.model === 'coupled';
    this.rho = P.rhoF; this.mu = W.mu; this.Ca = P.fluid ? W.Ca : 0;
    this.hindered = !!P.fluid && W.hindered;
    this.Q0 = 0; this.forcePerM = 0; this.impulse = 0; this.impTime = 0;
    this.t = 0; this.qGapTotal = 0; this.pTop = 0; this.uWinMean = 0;

    // ---- hydraulic segments along the full string (SI) ----
    const segs = [];
    const mats = cfg.materials;
    if (cfg.pipe.type === 'bucket' && geom.string) {
      const B = geom.string.buckets, T = geom.string.transitions;
      let sPrev = 0;
      B.forEach((b, i) => {
        const sEnd = b.sBot / 1000;
        const m = FP.materials.find(mats, b.mat);
        const seg = { s0: sPrev, s1: sEnd, L: Math.max(1e-3, sEnd - sPrev), D0: b.dTop / 1000, D1: b.dBot / 1000, rough: (m.rough || 0) / 1000, gapA: 0 };
        // diameters at the segment ends (segment starts at the previous lip level)
        seg.D0 = (b.dTop - (b.dTop - b.dBot) * Math.max(0, (sPrev * 1000 - b.sTop)) / b.h) / 1000;
        if (i < T.length && W.leakage) {
          const tr = T[i];
          if (tr.clearance > 0) seg.gapA = Math.PI * ((tr.idLowAtLip + tr.odLip) / 2000) * (tr.clearance / 1000);
        }
        segs.push(seg); sPrev = sEnd;
      });
    } else {
      const I = cfg.pipe.inclined, m = FP.materials.find(mats, I.mat);
      segs.push({ s0: 0, s1: I.L / 1000, L: I.L / 1000, D0: I.d / 1000, D1: I.d / 1000, rough: (m.rough || 0) / 1000, gapA: 0 });
    }
    // vertical drop of the string axis (inclined pipe uses the axis angle)
    this.sinA = Math.sin(geom.axisAngleH);
    this.LtotFull = segs[segs.length - 1].s1;
    // ---- dry part in the moonpool: water surface below the pipe top ----
    // sW = axial position of the outside water surface (sea level in the moonpool).
    // Segments above it carry air and are removed; their joint gaps exchange air, not water.
    const dryV = P.fluid ? Math.max(0, (cfg.pipe.dryLen || 0) / 1000) : 0;
    const shp = geom.shape && geom.shape.active ? geom.shape : null;
    this.cosTop = shp ? Math.cos(shp.thetaAt(0)) : 1;               // tilt of the top link (moonpool)
    this.sW = Math.min(this.LtotFull, dryV / Math.max(0.05, this.sinA * this.cosTop));
    this.freeSurface = this.sW > 0;
    if (this.freeSurface) {
      while (segs.length > 1 && segs[0].s1 <= this.sW + 1e-6) segs.shift();
      const s = segs[0];
      if (this.sW > s.s0) { const f = (this.sW - s.s0) / s.L; s.D0 = s.D0 + (s.D1 - s.D0) * f; s.s0 = this.sW; s.L = Math.max(1e-3, s.s1 - s.s0); }
    }
    segs.forEach(s => { s.A0 = Math.PI * s.D0 * s.D0 / 4; s.A1 = Math.PI * s.D1 * s.D1 / 4; s.Am = (s.A0 + s.A1) / 2; s.Dm = (s.D0 + s.D1) / 2; });
    this.segs = segs;
    this.Ltot = segs[segs.length - 1].s1;
    this.Lwet = this.Ltot - (this.freeSurface ? this.sW : 0);
    // mean cos of the tilt over the wet string (axial share of the settling load)
    this.cosMean = 1;
    if (shp) { let sc = 0, sl = 0; segs.forEach(sg => { const c = Math.cos(shp.thetaAt((sg.s0 + sg.s1) / 2)); sc += c * sg.L; sl += sg.L; }); this.cosMean = sl > 0 ? sc / sl : 1; }
    // drawdown z [m, vertical] of the free surface inside the pipe below the outside water level
    this.z = 0;
    this.surfS = this.sW;   // axial position of the inside free surface (global)

    // ---- per-bin arrays over the DEM window (and feed chute) for physics.js ----
    this.h = 0.1;
    this.s0w = -geom.feedLen;
    this.nb = Math.max(1, Math.ceil((geom.exitS - this.s0w) / this.h));
    this.uf = new Float64Array(this.nb);      // interstitial water velocity along the axis [m/s]
    this.gradP = new Float64Array(this.nb);   // dp'/ds [Pa/m]
    this.hinder = new Float64Array(this.nb).fill(1); // eps^(2-chi) multiplier (chi from a reference Re)
    this.eps = new Float64Array(this.nb).fill(1);
    this.area = new Float64Array(this.nb);
    this.Qs = new Float64Array(this.nb);      // volume flow at each bin [m3/s]
    this.ps = new Float64Array(this.nb);
    // reference Reynolds number for chi: Dn50 at its terminal velocity
    const Re = this.rho * Math.max(dv.vTerm50 || 1, 0.1) * dv.d50 / this.mu;
    this.chi = 3.7 - 0.65 * Math.exp(-Math.pow(1.5 - Math.log10(Re), 2) / 2);
    this.Re50 = Re;
    this.profile = null;
    this.buildReaches();
    this.stepFlows(0); this.storeProfile();
  }

  /** Global axial position of a window coordinate. */
  Water.prototype.sg = function (s) { return Math.max(0, s + (this.geom.s0Global || 0)); };
  /** Unclamped global position (feed chute above the pipe top is negative). */
  Water.prototype.sgRaw = function (s) { return s + (this.geom.s0Global || 0); };
  /** True when a window position is below the water surface inside the pipe. */
  Water.prototype.wetAt = function (s) {
    if (!this.cfg.physics.fluid) return false;
    if (!this.freeSurface) return true;
    return this.sgRaw(s) >= (this.on ? this.surfS : this.sW);
  };

  /**
   * Build reaches: consecutive segments with no gap between them share one
   * flow. Nodes between reaches are the open transition gaps.
   */
  Water.prototype.buildReaches = function () {
    const segs = this.segs, R = [];
    let cur = null;
    segs.forEach((sg, k) => {
      if (!cur) cur = { segs: [], inertia: 0, Q: 0, gapA: 0 };
      cur.segs.push(k);
      cur.inertia += this.rho * sg.L / sg.Am;
      if (sg.gapA > 0 || k === segs.length - 1) { cur.gapA = k === segs.length - 1 ? 0 : sg.gapA; R.push(cur); cur = null; }
    });
    this.reaches = R;
    this.inertia = R.reduce((a, r) => a + r.inertia, 0);
  };

  /**
   * Pressure change along one reach for flow Q (excluding inertia):
   * rock driving + Bernoulli area changes - wall friction - sudden-expansion
   * (Borda-Carnot) losses where a bucket lip discharges into the wider
   * bucket below. Returns { dp, dLoss } with dLoss = d(losses)/dQ >= 0.
   */
  Water.prototype.reachDp = function (r, Q, prof) {
    const rho = this.rho, W = this.cfg.water, segs = this.segs, fpm = this.forcePerM;
    let dp = 0, dLoss = 0;
    for (let i = 0; i < r.segs.length; i++) {
      const k = r.segs[i], s = segs[k];
      const uA = Q / s.A0, uB = Q / s.A1, um = Q / s.Am;
      if (prof) prof.push({ s: s.s0, rel: dp });
      const Re = rho * Math.abs(um) * s.Dm / this.mu;
      const f = W.frictionMode === 'haaland' ? haaland(Re, s.rough / s.Dm) : W.fDarcy;
      dp += fpm * s.L / s.Am + 0.5 * rho * (uA * Math.abs(uA) - uB * Math.abs(uB)) - f * s.L / s.Dm * 0.5 * rho * um * Math.abs(um);
      dLoss += f * s.L / s.Dm * rho * Math.abs(um) / s.Am;
      if (prof) prof.push({ s: s.s1, rel: dp });
      // transition into the next segment (sudden expansion / contraction of the flow area)
      if (k < segs.length - 1) {
        const n = segs[k + 1], u1 = uB, u2 = Q / n.A0;
        dp += 0.5 * rho * (u1 * Math.abs(u1) - u2 * Math.abs(u2));
        if (Math.abs(u1) > Math.abs(u2)) { const d = u1 - u2; dp -= 0.5 * rho * d * Math.abs(d); dLoss += rho * Math.abs(d) * Math.abs(1 / s.A1 - 1 / n.A0); }
      }
    }
    return { dp, dLoss };
  };

  /** Gap node pressure for gap inflow q (orifice law, inflow when p' < 0). */
  Water.prototype.gapP = function (A, q) {
    if (!(A > 0)) return 0;
    const v = q / (this.cfg.water.CdGap * A);
    return -0.5 * this.rho * v * Math.abs(v);
  };

  /**
   * Advance the reach flows by h (semi-implicit in each reach's own losses).
   *   I_r dQ_r/dt = p_(r-1) - p_r + dp_r(Q_r)
   * Submerged top: p_top = -(1 + Kin) rho u0|u0| / 2.
   * Pipe top above water (moonpool): free surface inside the pipe at
   * atmospheric pressure, p_top = -rho g z with z the drawdown below the
   * outside water level; dz/dt = Q_top / A_surface (vertical). No water enters
   * from the top, so a steady downward flow needs inflow through joint gaps.
   * p_bottom = 0 (free jet), p_r = gapP(A_gap, Q_(r+1) - Q_r).
   */
  Water.prototype.stepFlows = function (h) {
    const R = this.reaches, rho = this.rho, W = this.cfg.water, A0 = this.segs[0].A0, n = R.length;
    const P = new Float64Array(n + 1);
    const Q = R.map(r => r.Q);
    const u0 = Q[0] / A0;
    if (this.freeSurface) {
      P[0] = -rho * this.cfg.physics.g * this.z;
    } else P[0] = -(1 + W.Kin) * 0.5 * rho * u0 * Math.abs(u0);
    for (let r = 0; r < n - 1; r++) P[r + 1] = this.gapP(R[r].gapA, Q[r + 1] - Q[r]);
    // outlet: free jet for outflow (velocity head lost downstream); for reverse flow the
    // sea enters through the outlet with an entrance loss (1 + Kin) rho u^2 / 2
    const Aout = this.segs[this.segs.length - 1].A1, uOut = Q[n - 1] / Aout;
    P[n] = uOut < 0 ? -(1 + W.Kin) * 0.5 * rho * uOut * uOut : 0;
    for (let r = 0; r < n; r++) {
      const d = this.reachDp(R[r], Q[r], null);
      let damp = d.dLoss;
      if (r === 0 && !this.freeSurface) damp += (1 + W.Kin) * rho * Math.abs(u0) / A0;
      if (r === 0 && this.freeSurface) damp += h * rho * this.cfg.physics.g * this.sinA * this.cosTop / A0; // implicit surface stiffness
      // node stiffness of the adjacent gaps (dp/dq of the orifice) also damps
      const kg = (A, q) => A > 0 ? rho * Math.abs(q) / Math.pow(W.CdGap * A, 2) + 1e-9 : 0;
      if (r > 0) damp += kg(R[r - 1].gapA, Q[r] - Q[r - 1]);
      if (r < n - 1) damp += kg(R[r].gapA, Q[r + 1] - Q[r]);
      if (r === n - 1 && uOut < 0) damp += (1 + W.Kin) * rho * Math.abs(uOut) / Aout;
      const F = P[r] - P[r + 1] + d.dp;
      R[r].Q = Q[r] + h * F / (R[r].inertia + h * damp);
    }
    if (this.freeSurface) {
      // implicit update of the free surface with the new top flow
      const zMin = -this.sW * this.sinA, zMax = 0.98 * this.Lwet * this.sinA;
      this.z = Math.max(zMin, Math.min(zMax, this.z + h * R[0].Q / A0 * this.sinA * this.cosTop));
      this.surfS = this.sW + this.z / Math.max(0.05, this.sinA * this.cosTop);
      P[0] = -rho * this.cfg.physics.g * this.z;
    }
    this.nodeP = P;
  };

  /** Store the pressure / flow profile along the string for interpolation. */
  Water.prototype.storeProfile = function () {
    const R = this.reaches, prof = [];
    let qGap = 0;
    R.forEach((r, i) => {
      const loc = [];
      const d = this.reachDp(r, r.Q, loc);
      const pStart = this.nodeP[i], pEnd = this.nodeP[i + 1];
      // distribute the unbalance (inertial term) linearly along the reach
      const L0 = this.segs[r.segs[0]].s0, L1 = this.segs[r.segs[r.segs.length - 1]].s1, span = L1 - L0 || 1;
      const unb = pEnd - (pStart + d.dp);
      loc.forEach(pt => { const sk = this.segs.find(sg => pt.s >= sg.s0 - 1e-9 && pt.s <= sg.s1 + 1e-9) || this.segs[0]; const A = Math.abs(pt.s - sk.s0) < 1e-9 ? sk.A0 : sk.A1;
        prof.push({ s: pt.s, Q: r.Q, p: pStart + pt.rel + unb * (pt.s - L0) / span, A }); });
      if (i < R.length - 1) qGap += R[i + 1].Q - r.Q;
    });
    this.profile = prof; this.qGapTotal = qGap;
    this.Q0 = R[0].Q; this.Qout = R[R.length - 1].Q; this.pTop = this.nodeP[0];
  };

  /** Feed the drag reaction impulse (slice, N s, axial, positive downstream). */
  Water.prototype.addImpulse = function (J, dt) { this.impulse += J; this.impTime += dt; };

  /**
   * Update the water state; call at the detector sampling interval.
   * eng gives stone positions for the local voidage.
   */
  Water.prototype.update = function (eng, dtUpd) {
    if (!this.on && !this.hindered) return;
    const W = this.cfg.water, g = this.geom;
    // 1. rock loading of the water column (3D), smoothed
    //    - wet part of the DEM window: drag reaction measured in the DEM (slice -> 3D)
    //    - wet string outside the window: steady settling loading, F' = (rho_s - rho_w)/rho_s g sin(a) mdot / v_s,
    //      v_s = u + v_t (1 - Cv)^beta (Richardson-Zaki), mdot = measured rock inflow
    //    - water entry above the window (surface not in the window): momentum flux mdot (v_entry - v_s)
    if (this.on && this.impTime > 0) {
      const P = this.cfg.physics, s0g = g.s0Global || 0, sf = this.dv.sliceFactor;
      const Fdem = this.impulse / this.impTime / sf;                                   // N, 3D
      const surfLoc = this.freeSurface ? this.surfS - s0g : -Infinity;
      const wetWin = Math.max(0, g.L - Math.max(0, Math.min(g.L, surfLoc)));          // wet window length [m]
      const LwetTot = Math.max(0.5, this.Ltot - (this.freeSurface ? this.surfS : 0));  // wet string length [m]
      const Lout = Math.max(0, LwetTot - wetWin);
      // measured rock inflow into the pipe (3D), smoothed
      if (this.inMassPrev == null) this.inMassPrev = eng.inMass;
      const mdotNow = Math.max(0, eng.inMass - this.inMassPrev) / dtUpd / sf; this.inMassPrev = eng.inMass;
      const aM = Math.min(1, dtUpd / 2);
      this.mdot = (this.mdot || 0) + aM * (mdotNow - (this.mdot || 0));
      let Fout = 0, Fimp = 0;
      if (this.mdot > 0 && (Lout > 0 || this.freeSurface)) {
        const rs = this.cfg.grade.rho, rho = this.rho, sinA = Math.max(0.05, this.sinA * (this.cosMean || 1));
        const Am = this.segs.reduce((a, s) => a + s.Am * s.L, 0) / this.segs.reduce((a, s) => a + s.L, 0);
        const u = (this.Qout != null ? this.Qout : this.Q0) / Am, vt = (this.dv.vTerm50 || 1) * Math.sqrt(sinA), beta = this.cfg.checks.rzBeta || 2.39;
        let Cv = 0, vs = Math.max(0.2, u + vt);
        for (let i = 0; i < 20; i++) { vs = Math.max(0.2, u + vt * Math.pow(Math.max(0.05, 1 - Cv), beta)); Cv = Math.min(0.6, this.mdot / (rs * Am * vs)); }
        Fout = (rs - rho) / rs * P.g * sinA * this.mdot / vs * Lout;
        const surfInWin = this.freeSurface && surfLoc >= 0 && surfLoc <= g.L;
        if (this.freeSurface && !surfInWin) {
          const vEntry = Math.sqrt(Math.pow(this.dv.v0 || 0, 2) + 2 * P.g * sinA * Math.max(0, this.surfS));
          Fimp = this.mdot * Math.max(0, vEntry - vs);
        }
      }
      const f3 = (Fdem + Fout + Fimp) / LwetTot; // N/m, 3D, spread over the wet string
      const a = Math.min(1, dtUpd / Math.max(W.tSmooth, 1e-3));
      this.forcePerM += a * (f3 - this.forcePerM);
      this.loadParts = { Fdem, Fout, Fimp, LwetTot, wetWin };
      this.impulse = 0; this.impTime = 0;
    }
    // 2. integrate the water column (sub-steps for stability)
    if (this.on) {
      const n = Math.max(1, Math.ceil(dtUpd / 0.002)), h = dtUpd / n;
      for (let i = 0; i < n; i++) this.stepFlows(h);
      this.storeProfile();
    }
    this.t += dtUpd;
    // 3. local voidage in the window from stone positions
    const A = g.axis, nb = this.nb, hb = this.h;
    const areaS = new Float64Array(nb);
    if (this.hindered && eng) {
      for (let k = 0; k < eng.nActive; k++) {
        const b = eng.active[k];
        const s = (eng.x[b] - A.ox) * A.ux + (eng.y[b] - A.oy) * A.uy;
        const r = eng.br[b], a0 = s - r, a1 = s + r, ar = eng.aPlane[b] / (a1 - a0);
        const j0 = Math.max(0, Math.floor((a0 - this.s0w) / hb)), j1 = Math.min(nb - 1, Math.floor((a1 - this.s0w) / hb));
        for (let j = j0; j <= j1; j++) {
          const lo = Math.max(a0, this.s0w + j * hb), hi = Math.min(a1, this.s0w + (j + 1) * hb);
          if (hi > lo) areaS[j] += ar * (hi - lo);
        }
      }
    }
    // 4. per-bin water velocity, pressure gradient, hindrance
    let uSum = 0, uN = 0;
    for (let j = 0; j < nb; j++) {
      const sl = this.s0w + (j + 0.5) * hb;
      const w = g.widthAt(Math.max(0, Math.min(g.L, sl)));
      const phi2 = Math.min(0.85, areaS[j] / (w * hb));
      const eps = Math.max(0.4, 1 - (2 / 3) * phi2);
      this.eps[j] = eps;
      this.hinder[j] = this.hindered ? Math.pow(eps, 2 - this.chi) : 1;
      if (this.freeSurface && this.sgRaw(sl) < this.surfS) { this.uf[j] = 0; this.Qs[j] = 0; this.ps[j] = 0; this.hinder[j] = 1; continue; } // dry
      if (this.on && this.profile) {
        const st = this.interp(this.sg(sl));
        this.Qs[j] = st.Q; this.ps[j] = st.p; this.area[j] = st.A;
        const uSup = st.Q / st.A;
        this.uf[j] = sl > g.L ? uSup * 0.5 : uSup / eps;   // jet spreading below the outlet: halved (assumption)
        if (sl >= 0 && sl <= g.L) { uSum += uSup; uN++; }
      } else { this.uf[j] = 0; }
    }
    for (let j = 0; j < nb; j++) {
      const a = Math.max(0, j - 1), b = Math.min(nb - 1, j + 1);
      this.gradP[j] = this.on && this.wetAt(this.s0w + (j + 0.5) * hb) ? (this.ps[b] - this.ps[a]) / ((b - a) * hb || 1) : 0;
    }
    this.uWinMean = uN ? uSum / uN : 0;
  };

  /** Linear interpolation of the stored profile at global position s. */
  Water.prototype.interp = function (s) {
    const pr = this.profile;
    if (!pr || !pr.length) return { Q: 0, p: 0, A: 1 };
    if (s <= pr[0].s) return pr[0];
    for (let i = 1; i < pr.length; i++) {
      if (s <= pr[i].s) {
        const a = pr[i - 1], b = pr[i], t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 1;
        return { Q: a.Q + t * (b.Q - a.Q), p: a.p + t * (b.p - a.p), A: a.A + t * (b.A - a.A) };
      }
    }
    return pr[pr.length - 1];
  };

  /** Bin index for a window coordinate. */
  Water.prototype.bin = function (s) {
    const j = Math.floor((s - this.s0w) / this.h);
    return j < 0 ? 0 : (j >= this.nb ? this.nb - 1 : j);
  };

  /** Snapshot for charts and reports. */
  Water.prototype.state = function () {
    const segs = this.segs;
    return {
      Q0: this.Q0, Qout: this.Qout != null ? this.Qout : this.Q0,
      uTop: this.Q0 / segs[0].A0, uOut: (this.Qout != null ? this.Qout : this.Q0) / segs[segs.length - 1].A1,
      uWin: this.uWinMean, qGap: this.qGapTotal, pTop: this.pTop, forcePerM: this.forcePerM,
      Ltot: this.Ltot, chi: this.chi, Re50: this.Re50, nGaps: this.reaches.length - 1,
      dryLen: this.sW, drawdown: this.freeSurface ? this.z : 0, surfS: this.freeSurface ? this.surfS : 0, freeSurface: this.freeSurface,
      gapArea: segs.reduce((a, s) => a + s.gapA, 0)
    };
  };

  /**
   * Analytical estimate (sealed pipe, steady state) used as a check:
   * submerged rock weight per metre transferred to water balances the losses.
   *   F' = (rho_s - rho_w)/rho_s * g * sin(a) * mdot / v_r,  v_r = u + v_slip
   *   F' L / A = (1 + Kin + f L/D) rho u^2 / 2
   * with v_slip = vt (1 - Cv)^beta (Richardson-Zaki) and Cv = mdot / (rho_s A v_r).
   */
  function steadyEstimate(cfg, geom, dv, Ltot, D, rough, Kextra) {
    Kextra = Kextra || 0;
    const P = cfg.physics, W = cfg.water, G = cfg.grade;
    if (!P.fluid) return null;
    const rho = P.rhoF, rs = G.rho, A = Math.PI * D * D / 4;
    const mdot = cfg.feed.mode === 'mass' ? cfg.feed.massFlow / 3.6 : dv.massRateSlice / dv.sliceFactor;
    const sinA = Math.sin(geom.axisAngleH), beta = cfg.checks.rzBeta, vt = dv.vTerm50 * Math.sqrt(Math.max(sinA, 0.05));
    let u = 0.5, Cv = 0, vr = vt;
    for (let i = 0; i < 200; i++) {
      vr = u + vt * Math.pow(Math.max(0.05, 1 - Cv), beta);
      Cv = Math.min(0.6, mdot / (rs * A * vr));
      const Fm = (rs - rho) / rs * P.g * sinA * mdot / vr; // N/m
      const Re = rho * u * D / W.mu, f = W.frictionMode === 'haaland' ? haaland(Re, rough / D) : W.fDarcy;
      const un = Math.sqrt(Math.max(0, Fm * Ltot / A / ((1 + W.Kin + Kextra + f * Ltot / D) * 0.5 * rho)));
      if (Math.abs(un - u) < 1e-6) { u = un; break; }
      u = 0.5 * (u + un);
    }
    return { u, vr, Cv, Q: u * A };
  }

  FP.water = { Water, haaland, steadyEstimate };
})(self.FP = self.FP || {});
