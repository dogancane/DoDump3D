/* ==========================================================================
 * js3d/physics3d.js
 * 3D soft-particle DEM engine: rigid sphere clumps in a round fall pipe.
 *
 * MODEL LEVEL: simplified engineering model, level 2 of 3, in full 3D.
 *   - Rigid stones (sphere clumps, js3d/shapes3d.js), 6 degrees of freedom:
 *     3 translations, 3 rotations (unit quaternion, Euler's equations with
 *     the gyroscopic term, diagonal body-frame inertia).
 *   - Contacts stone-stone and stone-wall, same laws as the 2D engine:
 *       normal:     linear spring-dashpot Fn = k delta + c vn, Fn >= 0,
 *                   c from the restitution coefficient
 *       tangential: incremental 3D spring, kept in the tangent plane
 *                   (projected and rescaled every step), Coulomb limit
 *                   |Ft| <= mu Fn
 *       rolling:    constant torque muR Reff Fn opposing the relative spin
 *       stiffness:  k = kn Reff / Reff(Dn50), walls scaled by E* of the
 *                   bucket material (clipped)
 *   - Walls: revolved meridian segments (js3d/geometry3d.js): cones, wall
 *     thickness, lips, insertion ledges, feed chute or funnel, restart gate.
 *   - Water: same 1D coupled water column as 2D (water.js) along the whole
 *     string: buoyancy, drag on the slip velocity with Di Felice hindrance,
 *     pressure-gradient force, added mass on translation, dry fall above the
 *     water surface. The local voidage comes from the 3D stone VOLUME in the
 *     pipe cross-section (2D used 2/3 of the in-plane area fraction).
 *   - No slice: the full mass flow is released, so masses are real tonnes.
 *   - Integration: semi-implicit (symplectic) Euler, fixed time step.
 *
 * The engine knows nothing about blockage or drawing; the detector and the
 * renderer read its typed arrays.
 * ========================================================================== */
(function (FP) {
  'use strict';

  const MAXS = FP.shapes3d.MAXS;
  const NSECT = 12;   // azimuthal wall sectors for the arch test

  function gammaFromE(e) {
    e = Math.min(Math.max(e, 1e-4), 1);
    if (e >= 1) return 0;
    const l = Math.log(e);
    return -l / Math.sqrt(Math.PI * Math.PI + l * l);
  }
  function qmul(a, b) {
    return [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
  }
  function qmat(q) {
    const w = q[0], x = q[1], y = q[2], z = q[3];
    return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  }

  function Engine(cfg, geom, fac, dv, seed) {
    this.cfg = cfg; this.geom = geom; this.fac = fac; this.dv = dv;
    this.rng = FP.particles.rng(seed == null ? cfg.run.seed : seed);
    this.seedUsed = seed == null ? cfg.run.seed : seed;
    const N = this.cap = this.N = dv.cap;
    const SC = this.subCap = N * MAXS;
    const F = (n) => new Float64Array(n);

    // bodies
    this.px = F(N); this.py = F(N); this.pz = F(N);
    this.vx = F(N); this.vy = F(N); this.vz = F(N);
    this.qw = F(N); this.qx = F(N); this.qy = F(N); this.qz = F(N);
    this.wx = F(N); this.wy = F(N); this.wz = F(N);
    this.R = F(9 * N); this.Ib = F(3 * N); this.half = F(3 * N);
    this.m = F(N); this.invM = F(N);
    this.d = F(N); this.rn = F(N); this.L = F(N); this.Bd = F(N); this.Td = F(N); this.br = F(N); this.vol = F(N); this.aDrag = F(N);
    this.fx = F(N); this.fy = F(N); this.fz = F(N);
    this.tx = F(N); this.ty = F(N); this.tz = F(N);
    this.rx = F(N); this.ry = F(N); this.rz = F(N);
    this.tSpawn = F(N); this.tEnter = F(N); this.tExit = F(N);
    this.alive = new Uint8Array(N); this.entered = new Uint8Array(N); this.exited = new Uint8Array(N);
    this.wallMask = new Uint16Array(N); this.cls = new Uint8Array(N); this.wet = new Uint8Array(N); this.boxLike = new Uint8Array(N);
    this.subCount = new Uint8Array(N);
    this.serial = new Int32Array(N); this.nextSerial = 1;
    this.active = new Int32Array(N); this.nActive = 0; this.dirty = false;
    this.free = []; for (let b = N - 1; b >= 0; b--) this.free.push(b);
    this.quarantine = [];

    // sub-spheres
    this.sox = F(SC); this.soy = F(SC); this.soz = F(SC); this.sr = F(SC);
    this.sx = F(SC); this.sy = F(SC); this.sz = F(SC);
    this.sb = new Int32Array(SC); this.cellOf = new Int32Array(SC); this.next = new Int32Array(SC);
    for (let q = 0; q < SC; q++) this.sb[q] = (q / MAXS) | 0;

    // contact record (body pairs) for the detector
    this.cCap = N * 30;
    this.cA = new Int32Array(this.cCap); this.cB = new Int32Array(this.cCap); this.cF = F(this.cCap);
    this.cN = 0;

    // parameters
    const P = cfg.physics;
    this.dt = dv.dt; this.kn = dv.kn; this.kt = dv.kt;
    const gpp = gammaFromE(P.ePP);
    this.cnPP = 2 * gpp * Math.sqrt(this.kn); this.ctPP = 2 * gpp * Math.sqrt(this.kt);
    this.muPP = P.muPP; this.mrPP = P.muRollPP;
    this.gEff = P.g * dv.buoy;
    this.dragK = P.fluid ? 0.5 * P.rhoF * P.cd : 0;
    this.gAir = P.g; this.dragKair = P.fluid ? 0.5 * 1.2 * P.cd : 0;
    this.rhoS = cfg.grade.rho;

    // walls (revolved segments)
    const S = geom.wsegs, NS = this.nSeg = S.length;
    this.ws1 = F(NS); this.wr1 = F(NS); this.wes = F(NS); this.wer = F(NS); this.wl2 = F(NS);
    this.wrMin = F(NS); this.wrMax = F(NS);
    this.wGate = new Uint8Array(NS); this.gateOpen = !cfg.feed.prefill; this.settleTime = cfg.feed.prefill ? (cfg.feed.settle || 3) : 0;
    this.wMu = F(NS); this.wCn = F(NS); this.wCt = F(NS); this.wK = F(NS); this.wMr = F(NS);
    S.forEach((s, k) => {
      this.ws1[k] = s.s1; this.wr1[k] = s.r1; this.wes[k] = s.s2 - s.s1; this.wer[k] = s.r2 - s.r1;
      this.wl2[k] = Math.max(1e-12, this.wes[k] * this.wes[k] + this.wer[k] * this.wer[k]);
      this.wrMin[k] = Math.min(s.r1, s.r2); this.wrMax[k] = Math.max(s.r1, s.r2);
      this.wGate[k] = s.gate ? 1 : 0;
      const wp = dv.wallProps[s.mat] || { mu: P.muPW, e: P.ePW, muRoll: P.muRollPW, kRatio: 1 };
      const gw = gammaFromE(wp.e);
      this.wMu[k] = wp.mu; this.wK[k] = wp.kRatio; this.wMr[k] = wp.muRoll;
      this.wCn[k] = 2 * gw * Math.sqrt(this.kn); this.wCt[k] = 2 * gw * Math.sqrt(this.kt);
    });

    // axial layers (wall lists); stone pairs use an axial sweep
    const bx = geom.box;
    this.h = Math.max(2 * fac.maxSubR * 1.02, 0.02);
    this.gz0 = bx.z0;
    this.nz = Math.max(1, Math.ceil((bx.z1 - bx.z0) / this.h));
    this.ord = new Int32Array(N);
    // wall segments per z layer
    const zl = [];
    for (let k = 0; k < this.nz; k++) {
      const z0 = this.gz0 + k * this.h - this.h, z1 = this.gz0 + (k + 1) * this.h + this.h;
      const list = [];
      S.forEach((s, q) => { if (Math.max(s.s1, s.s2) >= z0 && Math.min(s.s1, s.s2) <= z1) list.push(q); });
      zl.push(Int32Array.from(list));
    }
    this.zSegs = zl;

    // tangential spring history: K slots per sub-sphere, 3 components, double buffered
    this.K = 12;
    this.hIdO = new Int32Array(SC * this.K); this.hValO = F(SC * this.K * 3); this.hCntO = new Uint8Array(SC);
    this.hIdN = new Int32Array(SC * this.K); this.hValN = F(SC * this.K * 3); this.hCntN = new Uint8Array(SC);
    this.histOverflow = 0;

    // feed
    this.pending = null; this.feedBlocked = false; this.feedBlockedTime = 0; this.capacityWait = 0;
    const Wi = geom.inletWidth;
    this.feedHalf = Math.min(cfg.feed.opening / 1000, Wi) / 2;
    this.feedOffset = cfg.feed.offset / 1000;
    this.maxStones = cfg.feed.maxStones > 0 ? cfg.feed.maxStones : Infinity;
    this.massRate = dv.massRateSlice;
    this.feedZone = cfg.feed.fillZone != null ? cfg.feed.fillZone : 0.7;
    this.hopper = cfg.feed.mode === 'hopper';
    this.prefillPending = !!cfg.feed.prefill;
    this.conveyor = cfg.feed.source === 'conveyor' ? Object.assign({ speed: 3, dir: 0, drop: 1, width: 600, scatter: 0.15, spin: 0.5 }, cfg.feed.belt || {}) : null;

    // vessel motion (regular roll / pitch / heave). Random phases per run (seeded).
    const V = cfg.vessel || {};
    this.vessel = V.on ? {
      ar: (V.rollAmp || 0) * Math.PI / 180, wr: 2 * Math.PI / Math.max(1, V.rollT || 9), pr: 2 * Math.PI * this.rng(),
      ap: (V.pitchAmp || 0) * Math.PI / 180, wp: 2 * Math.PI / Math.max(1, V.pitchT || 7), pp: 2 * Math.PI * this.rng(),
      ah: V.heaveAmp || 0, wh: 2 * Math.PI / Math.max(1, V.heaveT || 8), ph: 2 * Math.PI * this.rng(),
      zRC: V.zRC || 0
    } : null;
    this.vm = { gx: 0, gy: 0, ax: 0, ay: 0, hz: 1, roll: 0, pitch: 0, heave: 0 };

    // water column (shared 1D model) and gravity direction per water bin
    this.water = new FP.water.Water(cfg, geom, dv);
    this.waterDt = cfg.detect.sampleDt; this.nextWater = 0;
    this.Ca = this.water.Ca; this.rhoRatio = P.fluid ? P.rhoF / cfg.grade.rho : 0;
    {
      const WT = this.water, nb = WT.nb;
      this.gX = new Float64Array(nb); this.gZ = new Float64Array(nb);
      for (let j = 0; j < nb; j++) { const g = geom.gAt(WT.s0w + (j + 0.5) * WT.h); this.gX[j] = g[0]; this.gZ[j] = g[1]; }
      this.volBin = new Float64Array(nb);
    }

    // counters and diagnostics
    this.t = 0; this.steps = 0;
    this.spawned = 0; this.spawnedMass = 0; this.feedMass = 0; this.cappedStones = 0;
    this.inCount = 0; this.inMass = 0; this.outCount = 0; this.outMass = 0;
    this.lostCount = 0; this.lostMass = 0; this.lostLog = [];
    this.resSum = 0; this.resMax = 0;
    this.maxOverlapStep = 0; this.maxOverlapRun = 0; this.overlapOver5 = 0; this.maxWallOverlapRun = 0; this.maxSubOverlapRun = 0;
    this.tLastOut = -1; this.tFirstOut = -1; this.tFirstIn = -1;
    this.contactOverflow = false; this.peakBodies = 0;
    this.maxSpin = 0;
    // wall impact log per wall group (bucket index, feed chute = -1, gate = -2) and waterline entry statistics
    this.segGroup = Int32Array.from(S.map(sg => sg.bucket == null ? -1 : sg.bucket));
    this.hits = new Map();          // group -> { n, E, vMax }
    this.hitV = 0.3;                // m/s, minimum normal approach speed counted as an impact
    this.entry = { n: 0, v: [], ang: [] };
  }

  /** Impact log summary: [{ group, n, E (J), vMax (m/s) }]. */
  Engine.prototype.hitSummary = function () {
    const out = []; this.hits.forEach((h, k) => out.push({ group: k, n: h.n, E: h.E, vMax: h.vMax })); return out.sort((a, b) => a.group - b.group);
  };

  Engine.MAXS = MAXS; Engine.NSECT = NSECT;

  Engine.prototype.rebuildActive = function () {
    let n = 0;
    for (let b = 0; b < this.cap; b++) if (this.alive[b]) this.active[n++] = b;
    this.nActive = n; this.dirty = false; this.ordDirty = true;
  };
  Engine.prototype.feeding = function () { return this.spawned - (this.prefilled || 0) < this.maxStones; };

  /** World offsets of a stone's spheres for orientation q: [[x, y, z, r]...] relative to the centre. */
  function worldSubs(p, q) {
    const R = qmat(q);
    return p.subs.map(s => [R[0] * s[0] + R[1] * s[1] + R[2] * s[2], R[3] * s[0] + R[4] * s[1] + R[5] * s[2], R[6] * s[0] + R[7] * s[1] + R[8] * s[2], s[3]]);
  }
  function radialExtent(ws) { let e = 0; for (const s of ws) e = Math.max(e, Math.hypot(s[0], s[1]) + s[3]); return e; }

  /** Overlap test of a new stone (world sphere offsets ws at centre c) against stones and walls. */
  Engine.prototype.fits = function (ws, br, c) {
    for (let k = 0; k < this.nActive; k++) {
      const b = this.active[k];
      const dx = this.px[b] - c[0], dy = this.py[b] - c[1], dz = this.pz[b] - c[2], Rb = this.br[b] + br;
      if (dx * dx + dy * dy + dz * dz >= Rb * Rb) continue;
      const o = b * MAXS, Rm = this.R, r9 = 9 * b;
      for (const s of ws) {
        const qx = c[0] + s[0], qy = c[1] + s[1], qz = c[2] + s[2];
        for (let i = 0; i < this.subCount[b]; i++) {
          const ox = this.sox[o + i], oy = this.soy[o + i], oz = this.soz[o + i];
          const bx = this.px[b] + Rm[r9] * ox + Rm[r9 + 1] * oy + Rm[r9 + 2] * oz;
          const by = this.py[b] + Rm[r9 + 3] * ox + Rm[r9 + 4] * oy + Rm[r9 + 5] * oz;
          const bz = this.pz[b] + Rm[r9 + 6] * ox + Rm[r9 + 7] * oy + Rm[r9 + 8] * oz;
          const rr = s[3] + this.sr[o + i];
          if ((qx - bx) * (qx - bx) + (qy - by) * (qy - by) + (qz - bz) * (qz - bz) < rr * rr) return false;
        }
      }
    }
    for (const s of ws) {
      const qx = c[0] + s[0], qy = c[1] + s[1], qz = c[2] + s[2], rho = Math.hypot(qx, qy);
      for (let k = 0; k < this.nSeg; k++) {
        if (this.wGate[k] && this.gateOpen) continue;
        const ps = qz - this.ws1[k], pr = rho - this.wr1[k];
        let tt = (ps * this.wes[k] + pr * this.wer[k]) / this.wl2[k]; tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const ds = this.ws1[k] + tt * this.wes[k] - qz, dr = this.wr1[k] + tt * this.wer[k] - rho;
        if (ds * ds + dr * dr < s[3] * s[3]) return false;
      }
    }
    return true;
  };

  /** Restart case: fill the DEM window with stones at rest. */
  Engine.prototype.prefill = function () {
    const g = this.geom;
    let fails = 0, placed = 0;
    while (fails < 400 && this.free.length) {
      const p = this.fac.make(this.rng);
      const s0 = p.br + this.rng() * Math.max(0, g.L - 2 * p.br);
      const ws = worldSubs(p, p.q), e = radialExtent(ws);
      const lim = g.rAt(s0) * 0.98 - e;
      if (lim <= 0) { fails++; continue; }
      const rr = lim * Math.sqrt(this.rng()), ph = this.rng() * 2 * Math.PI;
      const c = [rr * Math.cos(ph), rr * Math.sin(ph), s0];
      if (!this.fits(ws, p.br, c)) { fails++; continue; }
      this.addBody(p, c, p.q, 0);
      const nb = this.active[this.nActive - 1];
      this.feedMass -= p.m;
      this.entered[nb] = 1; this.tEnter[nb] = 0; this.inCount++; this.inMass += p.m;
      this.prefilled = (this.prefilled || 0) + 1; this.prefillMass = (this.prefillMass || 0) + p.m;
      fails = 0; placed++;
    }
    return placed;
  };

  /**
   * Continuous feed: stones released anywhere in the upper part of the feed
   * chute at a random position in the feed opening and random orientation;
   * a stone too wide for the chute is turned with its long axis along the
   * pipe. Released mass follows Q t; a full chute is recorded as choke.
   */
  Engine.prototype.spawn = function () {
    while (this.quarantine.length && this.quarantine[0][1] <= this.steps) this.free.push(this.quarantine.shift()[0]);
    if (!this.feeding()) { this.feedBlocked = false; return; }
    const target = this.hopper ? Infinity : this.massRate * (this.t + this.dt);
    let tries = 0, blocked = false;
    const g = this.geom;
    const bandTop = -g.feedLen, bandLen = Math.max(0.05, this.feedZone * g.feedLen);
    const align = [Math.SQRT1_2, 0, -Math.SQRT1_2, 0];  // body x -> pipe axis
    while (this.feedMass < target && this.feeding() && tries < 30) {
      if (!this.free.length) { this.capacityWait++; blocked = true; break; }
      const p = this.pending || this.fac.make(this.rng);
      tries++;
      const s0 = bandTop + p.br + this.rng() * Math.max(0, bandLen - 2 * p.br);
      const R2 = g.rAt(s0);
      let q = tries > 1 ? FP.shapes3d.randomQuat(this.rng) : p.q;
      let ws = worldSubs(p, q), e = radialExtent(ws);
      if (e > R2 * 0.98) {
        const ph = this.rng() * 2 * Math.PI;
        q = qmul([Math.cos(ph / 2), 0, 0, Math.sin(ph / 2)], align);
        ws = worldSubs(p, q); e = radialExtent(ws);
      }
      let cx, cy, vel = null, spin = null;
      if (this.conveyor) {
        // conveyor discharge: stream centred on the feed offset, spread across the belt direction,
        // horizontal belt speed with scatter, vertical speed from the drop below the head pulley, forward spin
        const B = this.conveyor, a = B.dir * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
        const u = (this.rng() - 0.5) * B.width / 1000, w = (this.rng() - 0.5) * 0.1;
        cx = this.feedOffset + u * -dy + w * dx; cy = u * dx + w * dy;
        const gauss = () => Math.sqrt(-2 * Math.log(1 - this.rng())) * Math.cos(2 * Math.PI * this.rng());
        const vh = Math.max(0, B.speed * (1 + B.scatter * gauss())), da = B.scatter * gauss();
        const hx = Math.cos(a + da), hy = Math.sin(a + da);
        vel = [vh * hx, vh * hy, Math.sqrt(2 * this.cfg.physics.g * Math.max(0, B.drop))];
        const om = B.spin * vh / Math.max(0.05, p.Dn / 2) * (1 + 0.3 * gauss());
        spin = [om * hy, -om * hx, 0];   // -(z x d): top of the stone moving forward, as off the head pulley
      } else {
        const open = Math.min(this.feedHalf * R2 / (g.inletWidth / 2), R2 * 0.98);
        const lim = open - e;
        if (lim < 0) { this.pending = p; blocked = true; continue; }
        const rr = lim * Math.sqrt(this.rng()), ph = this.rng() * 2 * Math.PI;
        cx = this.feedOffset + rr * Math.cos(ph); cy = rr * Math.sin(ph);
      }
      const rc = Math.hypot(cx, cy), rMax = R2 * 0.98 - e;
      if (rMax < 0) { this.pending = p; blocked = true; continue; }
      if (rc > rMax && rc > 0) { cx *= rMax / rc; cy *= rMax / rc; }
      const c = [cx, cy, s0];
      if (!this.fits(ws, p.br, c)) { this.pending = p; blocked = true; continue; }
      this.addBody(p, c, q, null, vel, spin);
      this.pending = null;
    }
    this.feedBlocked = blocked && (this.hopper || this.feedMass < target);
    if (this.feedBlocked) this.feedBlockedTime += this.dt;
  };

  const CLS = ['equant', 'prolate', 'oblate', 'bladed', 'rounded', 'ellipsoid'];
  Engine.CLS = CLS;

  Engine.prototype.addBody = function (p, c, q, vIn, vel, spin) {
    const b = this.free.pop();
    const v0 = vIn != null ? vIn : this.dv.v0;
    this.px[b] = c[0]; this.py[b] = c[1]; this.pz[b] = c[2];
    if (vel) { this.vx[b] = vel[0]; this.vy[b] = vel[1]; this.vz[b] = vel[2]; } else { this.vx[b] = 0; this.vy[b] = 0; this.vz[b] = v0; }
    this.qw[b] = q[0]; this.qx[b] = q[1]; this.qy[b] = q[2]; this.qz[b] = q[3];
    this.R.set(qmat(q), 9 * b);
    if (spin) { this.wx[b] = spin[0]; this.wy[b] = spin[1]; this.wz[b] = spin[2]; } else { this.wx[b] = 0; this.wy[b] = 0; this.wz[b] = 0; }
    this.m[b] = p.m; this.invM[b] = 1 / (p.m * (1 + this.Ca * this.rhoRatio));
    this.Ib[3 * b] = p.I[0]; this.Ib[3 * b + 1] = p.I[1]; this.Ib[3 * b + 2] = p.I[2];
    this.half[3 * b] = p.half[0]; this.half[3 * b + 1] = p.half[1]; this.half[3 * b + 2] = p.half[2];
    this.wet[b] = 2;
    this.cls[b] = Math.max(0, CLS.indexOf(p.cls)); this.boxLike[b] = p.boxLike ? 1 : 0;
    this.d[b] = p.Dn; this.rn[b] = p.Dn / 2; this.L[b] = p.L; this.Bd[b] = p.B; this.Td[b] = p.T;
    this.br[b] = p.br; this.vol[b] = p.vol; this.aDrag[b] = p.dragArea;
    this.tSpawn[b] = this.t; this.alive[b] = 1; this.entered[b] = 0; this.exited[b] = 0;
    this.serial[b] = this.nextSerial++;
    const n = Math.min(MAXS, p.subs.length), o = b * MAXS;
    this.subCount[b] = n;
    for (let i = 0; i < n; i++) {
      const s = p.subs[i];
      this.sox[o + i] = s[0]; this.soy[o + i] = s[1]; this.soz[o + i] = s[2]; this.sr[o + i] = s[3];
      this.hCntO[o + i] = 0;
    }
    if (p.capped) this.cappedStones++;
    this.spawned++; this.spawnedMass += p.m; this.feedMass += p.m;
    this.active[this.nActive++] = b; this.ordDirty = true;
    if (this.nActive > this.peakBodies) this.peakBodies = this.nActive;
  };

  Engine.prototype.kill = function (b) {
    this.alive[b] = 0; this.dirty = true;
    this.quarantine.push([b, this.steps + 2]);
  };

  Engine.prototype.step = function () {
    const dt = this.dt;
    if (this.prefillPending) { this.prefillPending = false; this.prefill(); }
    if (!this.gateOpen && this.t >= this.settleTime) this.gateOpen = true;
    if (this.gateOpen) this.spawn();
    if (this.dirty) this.rebuildActive();
    if (this.ordDirty) { this.ord.set(this.active.subarray(0, this.nActive)); this.ordDirty = false; }

    const px = this.px, py = this.py, pz = this.pz, vx = this.vx, vy = this.vy, vz = this.vz;
    const wx = this.wx, wy = this.wy, wz = this.wz, Rm = this.R;
    const m = this.m, fx = this.fx, fy = this.fy, fz = this.fz, tx = this.tx, ty = this.ty, tz = this.tz, rx = this.rx, ry = this.ry, rz = this.rz;
    const sox = this.sox, soy = this.soy, soz = this.soz, sr = this.sr, sx = this.sx, sy = this.sy, sz = this.sz, sb = this.sb;
    const cellOf = this.cellOf, subCount = this.subCount;
    const nz = this.nz, inv = 1 / this.h, gz0 = this.gz0;
    const act = this.active, nAct = this.nActive;
    const gEff = this.gEff, dragK = this.dragK;
    const WT = this.water, wUf = WT.uf, wHin = WT.hinder, wGP = WT.gradP, Lpipe = this.geom.L, gX = this.gX, gZ = this.gZ;
    let Jw = 0;
    // vessel motion: apparent gravity in the pipe frame (rotation by roll / pitch, frame acceleration at depth, heave)
    const VM = this.vm, VS = this.vessel, s0g = this.geom.s0Global || 0;
    if (VS) {
      const t = this.t, gg = this.cfg.physics.g;
      const thr = VS.ar * Math.sin(VS.wr * t + VS.pr), thp = VS.ap * Math.sin(VS.wp * t + VS.pp);
      VM.roll = thr; VM.pitch = thp; VM.heave = VS.ah * Math.sin(VS.wh * t + VS.ph);
      VM.gx = -Math.sin(thr); VM.gy = -Math.sin(thp);                        // gravity turned with the pipe
      VM.ax = VS.wr * VS.wr * thr / gg; VM.ay = VS.wp * VS.wp * thp / gg;    // -theta''/g per metre of depth (theta'' = -w^2 theta)
      VM.hz = 1 - VS.wh * VS.wh * VM.heave / gg;                             // (g + h'') / g, heave up positive
    }

    // 1. orientation, sphere positions, grid, body forces
    for (let k = 0; k < nAct; k++) {
      const b = act[k], r9 = 9 * b;
      const qw = this.qw[b], qx = this.qx[b], qy = this.qy[b], qz = this.qz[b];
      Rm[r9] = 1 - 2 * (qy * qy + qz * qz); Rm[r9 + 1] = 2 * (qx * qy - qw * qz); Rm[r9 + 2] = 2 * (qx * qz + qw * qy);
      Rm[r9 + 3] = 2 * (qx * qy + qw * qz); Rm[r9 + 4] = 1 - 2 * (qx * qx + qz * qz); Rm[r9 + 5] = 2 * (qy * qz - qw * qx);
      Rm[r9 + 6] = 2 * (qx * qz - qw * qy); Rm[r9 + 7] = 2 * (qy * qz + qw * qx); Rm[r9 + 8] = 1 - 2 * (qx * qx + qy * qy);
      const s0 = b * MAXS, s1 = s0 + subCount[b];
      for (let q = s0; q < s1; q++) {
        const ox = sox[q], oy = soy[q], oz = soz[q];
        const X = px[b] + Rm[r9] * ox + Rm[r9 + 1] * oy + Rm[r9 + 2] * oz;
        const Y = py[b] + Rm[r9 + 3] * ox + Rm[r9 + 4] * oy + Rm[r9 + 5] * oz;
        const Z = pz[b] + Rm[r9 + 6] * ox + Rm[r9 + 7] * oy + Rm[r9 + 8] * oz;
        sx[q] = X; sy[q] = Y; sz[q] = Z;
        const ck = Math.floor((Z - gz0) * inv);
        cellOf[q] = ck < 0 || ck >= nz ? -1 : ck;    // axial layer, for the wall list
      }
      const sAx = pz[b];
      const isWet = dragK > 0 && WT.wetAt(sAx) ? 1 : 0;
      const jw = WT.bin(sAx);
      let gx = gX[jw], gy = 0, gz = gZ[jw];
      if (VS) {
        const zeta = VS.zRC + Math.max(0, sAx + s0g);                       // depth below the roll / pitch centre
        gx = (gx + VM.gx + zeta * VM.ax) * VM.hz; gy = (VM.gy + zeta * VM.ay) * VM.hz; gz *= VM.hz;   // inertial term -zeta theta'' = +zeta w^2 theta
      }
      if (isWet !== this.wet[b]) {
        if (isWet && this.wet[b] === 0 && this.entry.v.length < 20000) {   // crossing the water surface: speed and long-axis angle to the pipe axis
          this.entry.n++; this.entry.v.push(Math.sqrt(vx[b] * vx[b] + vy[b] * vy[b] + vz[b] * vz[b]));
          this.entry.ang.push(Math.acos(Math.min(1, Math.abs(Rm[9 * b + 6]))) * 180 / Math.PI);
        }
        this.wet[b] = isWet; this.invM[b] = 1 / (m[b] * (1 + (isWet ? this.Ca * this.rhoRatio : 0)));
      }
      if (isWet) {
        const uw = wUf[jw];
        const ux = vx[b], uy = vy[b], uz = vz[b] - uw;
        const sp = Math.sqrt(ux * ux + uy * uy + uz * uz);
        const dk = dragK * this.aDrag[b] * sp * wHin[jw];
        const fpg = -(m[b] / this.rhoS) * wGP[jw];
        fx[b] = -dk * ux + m[b] * gEff * gx;
        fy[b] = -dk * uy + m[b] * gEff * gy;
        fz[b] = -dk * uz + fpg + m[b] * gEff * gz;
        if (sAx >= 0 && sAx <= Lpipe) Jw += dk * uz;
      } else {
        const sp = Math.sqrt(vx[b] * vx[b] + vy[b] * vy[b] + vz[b] * vz[b]);
        const dk = this.dragKair * this.aDrag[b] * sp;
        const gg = dragK > 0 ? this.gAir : gEff;
        fx[b] = -dk * vx[b] + m[b] * gg * gx;
        fy[b] = -dk * vy[b] + m[b] * gg * gy;
        fz[b] = -dk * vz[b] + m[b] * gg * gz;
      }
      tx[b] = 0; ty[b] = 0; tz[b] = 0; rx[b] = 0; ry[b] = 0; rz[b] = 0; this.wallMask[b] = 0;
    }

    const kn = this.kn, kt = this.kt, K = this.K, rn = this.rn;
    const kScaleInv = 4 / this.dv.d50;
    const hIdO = this.hIdO, hValO = this.hValO, hCntO = this.hCntO, hIdN = this.hIdN, hValN = this.hValN, hCntN = this.hCntN;
    for (let k = 0; k < nAct; k++) { const b = act[k]; const s0 = b * MAXS, s1 = s0 + subCount[b]; for (let q = s0; q < s1; q++) hCntN[q] = 0; }
    let maxOv = 0, maxOvW = 0, maxOvSub = 0, cN = 0;
    const cA = this.cA, cB = this.cB, cF = this.cF, cCap = this.cCap;
    let hx = 0, hy = 0, hz = 0, hFound = false;
    const histGet = (a, id) => {
      const o = a * K, n = hCntO[a];
      for (let z = 0; z < n; z++) if (hIdO[o + z] === id) { const v = (o + z) * 3; hx = hValO[v]; hy = hValO[v + 1]; hz = hValO[v + 2]; hFound = true; return; }
      hx = 0; hy = 0; hz = 0; hFound = false;
    };
    const histSet = (a, id, X, Y, Z) => {
      const n = hCntN[a];
      if (n < K) { const s = a * K + n; hIdN[s] = id; hValN[3 * s] = X; hValN[3 * s + 1] = Y; hValN[3 * s + 2] = Z; hCntN[a] = n + 1; } else this.histOverflow++;
    };

    // 2. stone-stone contacts: axial sweep over bodies (pipe is long and narrow), bounding spheres,
    //    then sphere pairs. Body A always has the lower slot index, so sphere a < sphere b and the
    //    friction history of the pair is stored once, at sphere a.
    {
      const cn0 = this.cnPP, ct0 = this.ctPP, mu = this.muPP, mr = this.mrPP, br = this.br, ord = this.ord;
      let maxBr = 0;
      for (let k = 0; k < nAct; k++) if (br[act[k]] > maxBr) maxBr = br[act[k]];
      // insertion sort by axial position (nearly sorted from the previous step)
      for (let i = 1; i < nAct; i++) {
        const v = ord[i], z = pz[v]; let j = i - 1;
        while (j >= 0 && pz[ord[j]] > z) { ord[j + 1] = ord[j]; j--; }
        ord[j + 1] = v;
      }
      for (let i = 0; i < nAct; i++) {
        const P0 = ord[i], zP = pz[P0], lim = br[P0] + maxBr;
        for (let j = i + 1; j < nAct; j++) {
          const Q0 = ord[j];
          if (pz[Q0] - zP > lim) break;
          const A = P0 < Q0 ? P0 : Q0, B = P0 < Q0 ? Q0 : P0;
          const ex = px[B] - px[A], ey = py[B] - py[A], ez = pz[B] - pz[A], RR = br[A] + br[B];
          if (ex * ex + ey * ey + ez * ez >= RR * RR) continue;
          const sA0 = A * MAXS, sA1 = sA0 + subCount[A], sB0 = B * MAXS, sB1 = sB0 + subCount[B], brB = br[B];
          for (let a = sA0; a < sA1; a++) {
            const qx0 = px[B] - sx[a], qy0 = py[B] - sy[a], qz0 = pz[B] - sz[a], rq = sr[a] + brB;
            if (qx0 * qx0 + qy0 * qy0 + qz0 * qz0 >= rq * rq) continue;
            for (let b = sB0; b < sB1; b++) {
              const dx = sx[b] - sx[a], dy = sy[b] - sy[a], dz = sz[b] - sz[a], Rs = sr[a] + sr[b];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 >= Rs * Rs || d2 === 0) continue;
              const dist = Math.sqrt(d2), nX = dx / dist, nY = dy / dist, nZ = dz / dist, delta = Rs - dist;
              const off = sr[a] - 0.5 * delta;
              const cx = sx[a] + nX * off, cy = sy[a] + nY * off, cz = sz[a] + nZ * off;
              const rax = cx - px[A], ray = cy - py[A], raz = cz - pz[A];
              const rbx = cx - px[B], rby = cy - py[B], rbz = cz - pz[B];
              const rvx = (vx[A] + wy[A] * raz - wz[A] * ray) - (vx[B] + wy[B] * rbz - wz[B] * rby);
              const rvy = (vy[A] + wz[A] * rax - wx[A] * raz) - (vy[B] + wz[B] * rbx - wx[B] * rbz);
              const rvz = (vz[A] + wx[A] * ray - wy[A] * rax) - (vz[B] + wx[B] * rby - wy[B] * rbx);
              const vn = rvx * nX + rvy * nY + rvz * nZ;
              const meff = m[A] * m[B] / (m[A] + m[B]);
              const ks = (rn[A] * rn[B] / (rn[A] + rn[B])) * kScaleInv;
              const sq = Math.sqrt(meff * ks);
              let Fn = kn * ks * delta + cn0 * sq * vn; if (Fn < 0) Fn = 0;
              const vtx = rvx - vn * nX, vty = rvy - vn * nY, vtz = rvz - vn * nZ;
              histGet(a, b);
              // keep the stored spring in the current tangent plane
              const hn = hx * nX + hy * nY + hz * nZ;
              let px_ = hx - hn * nX, py_ = hy - hn * nY, pz_ = hz - hn * nZ;
              const m0 = hx * hx + hy * hy + hz * hz, m1 = px_ * px_ + py_ * py_ + pz_ * pz_;
              if (m1 > 1e-30) { const f = Math.sqrt(m0 / m1); px_ *= f; py_ *= f; pz_ *= f; }
              let stx = px_ + vtx * dt, sty = py_ + vty * dt, stz = pz_ + vtz * dt;
              const kts = kt * ks;
              let Ftx = -kts * stx - ct0 * sq * vtx, Fty = -kts * sty - ct0 * sq * vty, Ftz = -kts * stz - ct0 * sq * vtz;
              const Ftm = Math.sqrt(Ftx * Ftx + Fty * Fty + Ftz * Ftz), Fm = mu * Fn;
              if (Ftm > Fm) {
                const f = Ftm > 0 ? Fm / Ftm : 0; Ftx *= f; Fty *= f; Ftz *= f;
                stx = -Ftx / kts; sty = -Fty / kts; stz = -Ftz / kts;
              }
              histSet(a, b, stx, sty, stz);
              const FAx = -Fn * nX + Ftx, FAy = -Fn * nY + Fty, FAz = -Fn * nZ + Ftz;
              fx[A] += FAx; fy[A] += FAy; fz[A] += FAz; fx[B] -= FAx; fy[B] -= FAy; fz[B] -= FAz;
              tx[A] += ray * FAz - raz * FAy; ty[A] += raz * FAx - rax * FAz; tz[A] += rax * FAy - ray * FAx;
              tx[B] -= rby * FAz - rbz * FAy; ty[B] -= rbz * FAx - rbx * FAz; tz[B] -= rbx * FAy - rby * FAx;
              if (mr > 0) {
                const wrx = wx[A] - wx[B], wry = wy[A] - wy[B], wrz = wz[A] - wz[B];
                const wm = Math.sqrt(wrx * wrx + wry * wry + wrz * wrz);
                if (wm > 1e-12) {
                  const Mr = mr * (sr[a] * sr[b] / Rs) * Fn / wm;
                  rx[A] -= Mr * wrx; ry[A] -= Mr * wry; rz[A] -= Mr * wrz;
                  rx[B] += Mr * wrx; ry[B] += Mr * wry; rz[B] += Mr * wrz;
                }
              }
              const ov = delta / Math.min(rn[A], rn[B]); if (ov > maxOv) maxOv = ov;
              const ovs = delta / Math.min(sr[a], sr[b]); if (ovs > maxOvSub) maxOvSub = ovs;
              if (cN < cCap) { cA[cN] = A; cB[cN] = B; cF[cN] = Fn; cN++; } else this.contactOverflow = true;
            }
          }
        }
      }
    }

    // 3. stone-wall contacts (revolved segments, per-segment material)
    {
      const ws1 = this.ws1, wr1 = this.wr1, wes = this.wes, wer = this.wer, wl2 = this.wl2, wrMin = this.wrMin, wrMax = this.wrMax;
      const wMu = this.wMu, wCn = this.wCn, wCt = this.wCt, wK = this.wK, wMr = this.wMr, zSegs = this.zSegs, wGate = this.wGate, gateOpen = this.gateOpen;
      const sect = NSECT / (2 * Math.PI);
      for (let k = 0; k < nAct; k++) {
        const A = act[k];
        const s0 = A * MAXS, s1 = s0 + subCount[A];
        for (let a = s0; a < s1; a++) {
          const cell = cellOf[a];
          if (cell < 0) continue;
          const list = zSegs[cell];
          const r = sr[a], X = sx[a], Y = sy[a], Z = sz[a];
          const rho = Math.sqrt(X * X + Y * Y);
          const erx = rho > 1e-9 ? X / rho : 1, ery = rho > 1e-9 ? Y / rho : 0;
          for (let z = 0; z < list.length; z++) {
            const q = list[z];
            if (wGate[q] && gateOpen) continue;
            if (rho + r < wrMin[q] || rho - r > wrMax[q]) continue;
            const ps = Z - ws1[q], pr = rho - wr1[q];
            let tt = (ps * wes[q] + pr * wer[q]) / wl2[q];
            if (tt >= 1) continue;
            if (tt < 0) tt = 0;
            const ds = ws1[q] + tt * wes[q] - Z, dr = wr1[q] + tt * wer[q] - rho;
            const d2 = ds * ds + dr * dr;
            if (d2 >= r * r || d2 === 0) continue;
            const dist = Math.sqrt(d2), delta = r - dist;
            const nX = dr / dist * erx, nY = dr / dist * ery, nZ = ds / dist;
            const cx = X + nX * dist, cy = Y + nY * dist, cz = Z + nZ * dist;
            const rax = cx - px[A], ray = cy - py[A], raz = cz - pz[A];
            const rvx = vx[A] + wy[A] * raz - wz[A] * ray;
            const rvy = vy[A] + wz[A] * rax - wx[A] * raz;
            const rvz = vz[A] + wx[A] * ray - wy[A] * rax;
            const vn = rvx * nX + rvy * nY + rvz * nZ;
            const ks = 0.5 * rn[A] * kScaleInv * wK[q];
            const sq = Math.sqrt(m[A] * ks);
            let Fn = kn * ks * delta + wCn[q] * sq * vn; if (Fn < 0) Fn = 0;
            const vtx = rvx - vn * nX, vty = rvy - vn * nY, vtz = rvz - vn * nZ;
            histGet(a, -(q + 1));
            if (!hFound && vn > this.hitV) {   // a new wall contact: an impact
              const gk = this.segGroup[q]; let h = this.hits.get(gk);
              if (!h) { h = { n: 0, E: 0, vMax: 0 }; this.hits.set(gk, h); }
              h.n++; h.E += 0.5 * m[A] * vn * vn; if (vn > h.vMax) h.vMax = vn;
            }
            const hn = hx * nX + hy * nY + hz * nZ;
            let px_ = hx - hn * nX, py_ = hy - hn * nY, pz_ = hz - hn * nZ;
            const m0 = hx * hx + hy * hy + hz * hz, m1 = px_ * px_ + py_ * py_ + pz_ * pz_;
            if (m1 > 1e-30) { const f = Math.sqrt(m0 / m1); px_ *= f; py_ *= f; pz_ *= f; }
            let stx = px_ + vtx * dt, sty = py_ + vty * dt, stz = pz_ + vtz * dt;
            const kts = kt * ks;
            let Ftx = -kts * stx - wCt[q] * sq * vtx, Fty = -kts * sty - wCt[q] * sq * vty, Ftz = -kts * stz - wCt[q] * sq * vtz;
            const Ftm = Math.sqrt(Ftx * Ftx + Fty * Fty + Ftz * Ftz), Fm = wMu[q] * Fn;
            if (Ftm > Fm) {
              const f = Ftm > 0 ? Fm / Ftm : 0; Ftx *= f; Fty *= f; Ftz *= f;
              stx = -Ftx / kts; sty = -Fty / kts; stz = -Ftz / kts;
            }
            histSet(a, -(q + 1), stx, sty, stz);
            const FAx = -Fn * nX + Ftx, FAy = -Fn * nY + Fty, FAz = -Fn * nZ + Ftz;
            fx[A] += FAx; fy[A] += FAy; fz[A] += FAz;
            tx[A] += ray * FAz - raz * FAy; ty[A] += raz * FAx - rax * FAz; tz[A] += rax * FAy - ray * FAx;
            if (wMr[q] > 0) {
              const wm = Math.sqrt(wx[A] * wx[A] + wy[A] * wy[A] + wz[A] * wz[A]);
              if (wm > 1e-12) { const Mr = wMr[q] * r * Fn / wm; rx[A] -= Mr * wx[A]; ry[A] -= Mr * wy[A]; rz[A] -= Mr * wz[A]; }
            }
            const ov = delta / rn[A]; if (ov > maxOvW) maxOvW = ov;
            const ovs = delta / r; if (ovs > maxOvSub) maxOvSub = ovs;
            let sc = Math.floor((Math.atan2(cy, cx) + Math.PI) * sect); if (sc >= NSECT) sc = NSECT - 1;
            this.wallMask[A] |= 1 << sc;
          }
        }
      }
    }
    this.cN = cN;
    const mo = Math.max(maxOv, maxOvW);
    this.maxOverlapStep = mo;
    if (mo > this.maxOverlapRun) this.maxOverlapRun = mo;
    if (maxOvW > this.maxWallOverlapRun) this.maxWallOverlapRun = maxOvW;
    if (maxOvSub > this.maxSubOverlapRun) this.maxSubOverlapRun = maxOvSub;
    if (mo > 0.05) this.overlapOver5++;

    // 4. integrate: translation, rotation (Euler's equations in the body frame), bookkeeping
    const invM = this.invM, Ib = this.Ib, g = this.geom, bx = g.box, r2box = bx.r * bx.r;
    const L = g.L, exitS = g.exitS, t1 = this.t + dt;
    let spin = 0;
    for (let k = 0; k < nAct; k++) {
      const b = act[k], r9 = 9 * b, i3 = 3 * b;
      vx[b] += fx[b] * invM[b] * dt; vy[b] += fy[b] * invM[b] * dt; vz[b] += fz[b] * invM[b] * dt;
      px[b] += vx[b] * dt; py[b] += vy[b] * dt; pz[b] += vz[b] * dt;
      // body-frame spin and torque
      const R0 = Rm[r9], R1 = Rm[r9 + 1], R2 = Rm[r9 + 2], R3 = Rm[r9 + 3], R4 = Rm[r9 + 4], R5 = Rm[r9 + 5], R6 = Rm[r9 + 6], R7 = Rm[r9 + 7], R8 = Rm[r9 + 8];
      const I1 = Ib[i3], I2 = Ib[i3 + 1], I3 = Ib[i3 + 2];
      let w1 = R0 * wx[b] + R3 * wy[b] + R6 * wz[b], w2 = R1 * wx[b] + R4 * wy[b] + R7 * wz[b], w3 = R2 * wx[b] + R5 * wy[b] + R8 * wz[b];
      const T1 = R0 * tx[b] + R3 * ty[b] + R6 * tz[b], T2 = R1 * tx[b] + R4 * ty[b] + R7 * tz[b], T3 = R2 * tx[b] + R5 * ty[b] + R8 * tz[b];
      w1 += (T1 - (I3 - I2) * w2 * w3) / I1 * dt;
      w2 += (T2 - (I1 - I3) * w3 * w1) / I2 * dt;
      w3 += (T3 - (I2 - I1) * w1 * w2) / I3 * dt;
      // rolling resistance: may stop the spin but never reverse it
      if (rx[b] !== 0 || ry[b] !== 0 || rz[b] !== 0) {
        const M1 = R0 * rx[b] + R3 * ry[b] + R6 * rz[b], M2 = R1 * rx[b] + R4 * ry[b] + R7 * rz[b], M3 = R2 * rx[b] + R5 * ry[b] + R8 * rz[b];
        const n1 = w1 + M1 / I1 * dt, n2 = w2 + M2 / I2 * dt, n3 = w3 + M3 / I3 * dt;
        if (n1 * w1 + n2 * w2 + n3 * w3 <= 0) { w1 = 0; w2 = 0; w3 = 0; } else { w1 = n1; w2 = n2; w3 = n3; }
      }
      const Wx = R0 * w1 + R1 * w2 + R2 * w3, Wy = R3 * w1 + R4 * w2 + R5 * w3, Wz = R6 * w1 + R7 * w2 + R8 * w3;
      wx[b] = Wx; wy[b] = Wy; wz[b] = Wz;
      const sp2 = Wx * Wx + Wy * Wy + Wz * Wz; if (sp2 > spin) spin = sp2;
      // quaternion update q += 0.5 dt (0, w) q
      const qw = this.qw[b], qx = this.qx[b], qy = this.qy[b], qz = this.qz[b], hd = 0.5 * dt;
      let nw = qw + hd * (-Wx * qx - Wy * qy - Wz * qz);
      let nx1 = qx + hd * (Wx * qw + Wy * qz - Wz * qy);
      let ny1 = qy + hd * (Wy * qw + Wz * qx - Wx * qz);
      let nz1 = qz + hd * (Wz * qw + Wx * qy - Wy * qx);
      const qn = 1 / Math.sqrt(nw * nw + nx1 * nx1 + ny1 * ny1 + nz1 * nz1);
      this.qw[b] = nw * qn; this.qx[b] = nx1 * qn; this.qy[b] = ny1 * qn; this.qz[b] = nz1 * qn;

      const s = pz[b];
      if (!this.entered[b] && s >= 0) {
        this.entered[b] = 1; this.tEnter[b] = t1; this.inCount++; this.inMass += m[b];
        if (this.tFirstIn < 0) this.tFirstIn = t1;
      }
      if (this.entered[b] && !this.exited[b] && s >= L) {
        this.exited[b] = 1; this.tExit[b] = t1; this.outCount++; this.outMass += m[b];
        const res = t1 - this.tEnter[b]; this.resSum += res; if (res > this.resMax) this.resMax = res;
        this.tLastOut = t1; if (this.tFirstOut < 0) this.tFirstOut = t1;
      }
      if (s > exitS) { this.kill(b); continue; }
      if (s < bx.z0 || s > bx.z1 || px[b] * px[b] + py[b] * py[b] > r2box) {
        if (!this.exited[b]) {
          this.lostCount++; this.lostMass += m[b];
          if (this.lostLog.length < 50) this.lostLog.push({ t: t1, s, n: Math.hypot(px[b], py[b]), d: this.d[b] });
        }
        this.kill(b);
      }
    }
    this.maxSpin = Math.sqrt(spin);

    this.hIdO = hIdN; this.hValO = hValN; this.hCntO = hCntN;
    this.hIdN = hIdO; this.hValN = hValO; this.hCntN = hCntO;
    this.t = t1; this.steps++;
    this.water.addImpulse(Jw * dt, dt);
    if (this.t >= this.nextWater) { this.updateWater(this.waterDt); this.nextWater += this.waterDt; }
  };

  /**
   * Water update with the 3D voidage: the shared water column is advanced
   * (no stones passed, so its own in-plane voidage stays 1), then the
   * interstitial velocity and Di Felice hindrance are set per bin from the
   * stone volume in the bin over the pipe cross-section.
   */
  Engine.prototype.updateWater = function (dtUpd) {
    const WT = this.water;
    WT.update({ inMass: this.inMass, nActive: 0, active: this.active }, dtUpd);
    if (!WT.hindered && !WT.on) return;
    if (this.dirty) this.rebuildActive();
    const nb = WT.nb, hb = WT.h, s0 = WT.s0w, vb = this.volBin, g = this.geom;
    vb.fill(0);
    for (let k = 0; k < this.nActive; k++) {
      const b = this.active[k], s = this.pz[b], r = this.br[b], a0 = s - r, a1 = s + r, dens = this.vol[b] / (a1 - a0);
      const j0 = Math.max(0, Math.floor((a0 - s0) / hb)), j1 = Math.min(nb - 1, Math.floor((a1 - s0) / hb));
      for (let j = j0; j <= j1; j++) {
        const lo = Math.max(a0, s0 + j * hb), hi = Math.min(a1, s0 + (j + 1) * hb);
        if (hi > lo) vb[j] += dens * (hi - lo);
      }
    }
    for (let j = 0; j < nb; j++) {
      const sl = s0 + (j + 0.5) * hb;
      const rr = g.widthAt(Math.max(-g.feedLen, Math.min(g.L, sl))) / 2;
      const phi = Math.min(0.7, vb[j] / (Math.PI * rr * rr * hb));
      const eps = Math.max(0.3, 1 - phi);
      WT.eps[j] = eps;
      if (WT.freeSurface && WT.sgRaw(sl) < WT.surfS) { WT.hinder[j] = 1; continue; }
      WT.hinder[j] = WT.hindered ? Math.pow(eps, 2 - WT.chi) : 1;
      if (WT.on && sl <= g.L) WT.uf[j] = WT.uf[j] / eps;
    }
  };

  Engine.prototype.insideCount = function () {
    if (this.dirty) this.rebuildActive();
    let n = 0, mass = 0;
    for (let k = 0; k < this.nActive; k++) { const b = this.active[k]; if (this.entered[b] && !this.exited[b]) { n++; mass += this.m[b]; } }
    return { n, mass };
  };
  Engine.prototype.aliveMass = function () {
    if (this.dirty) this.rebuildActive();
    let n = 0, mass = 0, nEx = 0, mEx = 0;
    for (let k = 0; k < this.nActive; k++) { const b = this.active[k]; n++; mass += this.m[b]; if (this.exited[b]) { nEx++; mEx += this.m[b]; } }
    return { n, mass, nExitedAlive: nEx, mExitedAlive: mEx };
  };
  Engine.prototype.subTotal = function () {
    let n = 0; for (let k = 0; k < this.nActive; k++) n += this.subCount[this.active[k]]; return n;
  };

  FP.physics3d = { Engine, gammaFromE, MAXS, NSECT, qmat, qmul };
})(self.FP = self.FP || {});
