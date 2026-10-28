/* ==========================================================================
 * coupled/catenary.js
 * Static shape of the bucket string in current (V2.7).
 *
 * MODEL: articulated chain. Each bucket is a rigid link from the previous
 * lip to its own lip; the string bends only at the joints. Bending stiffness
 * of the links is not needed (a bucket string has no moment continuity at
 * the joints). Equilibrium of everything below a point gives the link angle:
 *
 *   tan theta(s) = H(s) / T(s)
 *   T(s) = W_b + sum (w_i L_i)          vertical force (bottom weight + string + chains)
 *   H(s) = H_b + sum (f_i L_i)          horizontal force (bottom force + current drag)
 *   f    = 1/2 rho Cd D_out U_rel |U_rel|     Morison drag per metre (normal flow)
 *   U_rel(z) = U(z) - V_vessel          current relative to the vessel
 *   U(z) = U0 (uniform) or U0 ((d - z)/d)^(1/7) (power law, d = water depth)
 *
 * Bottom end:
 *   free     H_b = F_rov (drag of the bottom weight / ROV only)
 *   ROV hold H_b chosen so the tip offset equals the target; ROV thrust
 *            = H_b - F_rov, capped at the ROV's maximum thrust.
 * Links above the water level (moonpool) carry their weight in air and no
 * current drag.
 *
 * Simplifications (stated in the Method tab): static (no vessel motion,
 * no VIV, no dynamic amplification), drag normal to the link from the full
 * current (cross-flow principle not applied: conservative for small angles),
 * current and pipe deflection in one vertical plane, rock inside the pipe
 * neither loads nor stiffens the string.
 *
 * Manual modes: 'tilt' (straight string at one angle), 'joints' (top angle
 * plus a constant change at every joint), 'vertical' (no tilt).
 * ========================================================================== */
(function (FP) {
  'use strict';

  const deg = Math.PI / 180;

  function currentAt(S, z) {
    const U0 = S.U0 || 0;
    if (S.profile === 'power' && S.depth > 0) {
      const zz = Math.max(0, Math.min(S.depth, z));
      return U0 * Math.pow(Math.max(0, (S.depth - zz) / S.depth), 1 / 7);
    }
    return U0;
  }

  /** Links from the string (global axial positions, m). */
  function links(cfg, str) {
    const B = str.buckets, out = [];
    let sPrev = 0;
    B.forEach((b, i) => {
      const s1 = b.sBot / 1000, L = Math.max(1e-3, s1 - sPrev);
      const od = ((b.dTop + b.dBot) / 2 + 2 * b.t) / 1000;
      out.push({ i, gi: b.gi, s0: sPrev, s1, L, od, mass: b.mass, Wsub: b.Wsub == null ? 0 : b.Wsub });
      sPrev = s1;
    });
    return out;
  }

  /**
   * Solve the shape. Returns { mode, links[], thetaAt(sGlobal), ... }.
   * Angles are positive when the string leans downstream going down.
   */
  function solve(cfg, str) {
    const S = cfg.pipe.shape || { mode: 'vertical' };
    const P = cfg.physics, g = P.g, rho = P.fluid ? P.rhoF : 1025;
    const Lk = links(cfg, str);
    const n = Lk.length;
    const res = { mode: S.mode || 'vertical', links: Lk, warnings: [], joints: [] };
    const dryV = P.fluid ? Math.max(0, (cfg.pipe.dryLen || 0) / 1000) : 0;

    if (res.mode === 'vertical' || !n) {
      Lk.forEach(l => { l.theta = 0; });
    } else if (res.mode === 'tilt') {
      Lk.forEach(l => { l.theta = (S.tilt || 0) * deg; });
    } else if (res.mode === 'joints') {
      Lk.forEach((l, i) => { l.theta = ((S.tilt || 0) + i * (S.dJoint || 0)) * deg; });
    } else {
      // ---- current-driven shape ----
      const chainW = (S.chainW || 0) * 1000;         // N/m submerged
      const chainAir = chainW * 7850 / (7850 - rho);   // steel chain weight in air
      const R = S.rov || {};
      const Wb = (R.W || 0) * 1000;                    // N, bottom weight in water
      const Cd = S.Cd || 1.0, Vv = S.vVessel || 0;
      // initial vertical depths (straight string)
      Lk.forEach(l => { l.ym = (l.s0 + l.s1) / 2; });
      let Fd = 0, Hb = 0, thrust = 0, held = false;
      const integrate = (H0) => {
        // bottom-up forces, then top-down positions
        let H = H0, T = Wb;
        for (let k = n - 1; k >= 0; k--) {
          const l = Lk[k];
          const z = l.ym - dryV;                       // depth of link centre below the water surface
          const wet = z > 0;
          const w = wet ? l.Wsub / l.L + chainW : l.mass * g / l.L + chainAir;
          const U = wet ? currentAt(S, z) - Vv : 0;
          const f = wet ? 0.5 * rho * Cd * l.od * U * Math.abs(U) : 0;
          l.f = f; l.w = w;
          const Hm = H + f * l.L / 2, Tm = T + w * l.L / 2;
          l.T = Tm; l.H = Hm;
          l.theta = Math.atan2(Hm, Math.max(Tm, 1e-6));
          if (Tm <= 0) l.slack = true; else l.slack = false;
          H += f * l.L; T += w * l.L;
        }
        let x = 0, y = 0;
        Lk.forEach(l => { l.x0 = x; l.y0 = y; x += l.L * Math.sin(l.theta); y += l.L * Math.cos(l.theta); l.x1 = x; l.y1 = y; l.ym = (l.y0 + l.y1) / 2; });
        return { x, y, Htop: H, Ttop: T };
      };
      // tension check on the straight string: the chain model needs T > 0 in every wet link
      {
        let T = Wb, slack = false;
        for (let k = n - 1; k >= 0; k--) {
          const l = Lk[k], wet = l.ym - dryV > 0;
          const w = wet ? l.Wsub / l.L + chainW : l.mass * g / l.L + chainAir;
          if (T + w * l.L / 2 <= 0) slack = true;
          T += w * l.L;
        }
        if (slack) {
          Lk.forEach(l => { l.theta = 0; l.f = 0; l.T = 0; l.H = 0; });
          res.slack = true; res.Fd = 0; res.Hb = 0; res.thrust = 0; res.held = false; res.rovOn = !!R.on; res.dragPipe = 0; res.Ttop = T; res.Htop = 0;
          res.warnings.push('The string is not in tension: the buckets are buoyant and the bottom weight plus chain weight cannot keep it hanging. Shape not computed (pipe treated as vertical). Increase the ROV / bottom weight or the chain weight.');
        }
      }
      // two passes so the current uses the deflected depths
      for (let pass = 0; pass < 2 && !res.slack; pass++) {
        const zBot = (Lk[n - 1].y1 != null ? Lk[n - 1].y1 : Lk[n - 1].s1) - dryV;
        const Ub = zBot > 0 ? currentAt(S, zBot) - Vv : 0;
        Fd = 0.5 * rho * (R.Cd || 1.0) * (R.A || 0) * Ub * Math.abs(Ub);
        if (R.on) {
          const target = R.target || 0;
          let lo = -5e6, hi = 5e6;
          for (let it = 0; it < 80; it++) { const m = (lo + hi) / 2; if (integrate(m).x > target) hi = m; else lo = m; }
          Hb = (lo + hi) / 2; thrust = Hb - Fd;
          const tMax = (R.thrust || 0) * 1000;
          held = Math.abs(thrust) <= tMax + 1e-6;
          if (!held) { thrust = Math.sign(thrust) * tMax; Hb = Fd + thrust; }
        } else { Hb = Fd; thrust = 0; held = false; }
      }
      if (!res.slack) {
      const r = integrate(Hb);
      res.Fd = Fd; res.Hb = Hb; res.thrust = thrust; res.held = held; res.rovOn = !!R.on;
      res.thrustMax = (R.thrust || 0) * 1000; res.Ttop = r.Ttop; res.Htop = r.Htop;
      res.dragPipe = Lk.reduce((a, l) => a + l.f * l.L, 0);
      if (Lk.some(l => l.slack)) res.warnings.push('Part of the string is not in tension (buoyant buckets without enough bottom or chain weight). The chain model does not apply there; increase the bottom weight or chain weight.');
      if (R.on && !held) res.warnings.push('ROV thrust limit reached: it cannot hold the tip at the target; the tip drifts.');
      }
    }
    // positions for the manual modes
    if (res.mode !== 'current' || res.slack) {
      let x = 0, y = 0;
      Lk.forEach(l => { l.x0 = x; l.y0 = y; x += l.L * Math.sin(l.theta); y += l.L * Math.cos(l.theta); l.x1 = x; l.y1 = y; });
    }
    const last = Lk[n - 1] || { x1: 0, y1: 0, theta: 0 };
    res.offset = last.x1; res.depth = last.y1;
    res.topAngle = Lk.length ? Lk[0].theta / deg : 0;
    res.bottomAngle = last.theta / deg;
    res.maxAngle = Math.max.apply(null, Lk.map(l => Math.abs(l.theta / deg)).concat([0]));
    // bow: largest distance from the straight line top to tip
    const cx = last.x1, cy = last.y1, cl = Math.hypot(cx, cy) || 1;
    res.maxBow = Math.max.apply(null, Lk.map(l => Math.abs(l.x1 * cy - l.y1 * cx) / cl).concat([0]));
    // joint angles vs geometric tilt limit atan(2c / ins)
    (str.transitions || []).forEach((tr, i) => {
      if (i >= n - 1) return;
      const d = Math.abs(Lk[i + 1].theta - Lk[i].theta) / deg;
      const lim = tr.clearance > 0 && tr.ins > 0 ? Math.atan(2 * tr.clearance / tr.ins) / deg : 0;
      res.joints.push({ upper: tr.upper, lower: tr.lower, angle: d, limit: lim, over: d > lim + 1e-9 });
    });
    res.active = Lk.some(l => Math.abs(l.theta) > 1e-6);
    /** Link angle [rad] at a global axial position (m); above the pipe top: top link. */
    res.thetaAt = function (s) {
      if (!Lk.length) return 0;
      if (s <= Lk[0].s0) return Lk[0].theta;
      for (let k = 0; k < Lk.length; k++) if (s <= Lk[k].s1) return Lk[k].theta;
      return Lk[Lk.length - 1].theta;
    };
    return res;
  }

  FP.catenary = { solve, currentAt };
  if (FP.coupled && FP.coupled.register) FP.coupled.register('catenary', {
    info: { name: 'Fall-pipe shape in current (static chain)', status: 'static model in use (V2.7); dynamics not implemented', module: 'coupled/catenary.js' },
    defaults: () => ({ loadPath: 'chains', analysis: 'static' }),
    step() { throw new Error('Dynamic catenary not implemented; the static shape is solved in FP.catenary.solve'); }
  });
})(self.FP = self.FP || {});
