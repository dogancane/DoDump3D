/* ==========================================================================
 * config.js
 * Default inputs and derived (computed) quantities.
 *
 * Unit convention for STORED INPUTS (what the UI edits):
 *   geometry .......... mm          rock sizes .... mm (Dn) / kg (mass)
 *   density ........... kg/m3       mass flow ..... t/h (3D nominal, full pipe)
 *   velocity .......... m/s         angles ........ degrees
 *   time .............. s           moduli/stress . Pa
 * Everything is converted to SI base units before it reaches the geometry
 * builder or the physics engine.
 * ========================================================================== */
(function (FP) {
  'use strict';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Mean Dn/D ratio back-calculated from the class table (T2). */
  function classTableDnPerD() {
    const r = FP.grades.LIBRARY.map(FP.grades.dnPerD).filter(v => v);
    return r.length ? +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(3) : null;
  }

  function defaultConfig() {
    const lib = FP.grades.fullLibrary();
    return {
      version: 2,
      pipe: {
        type: 'bucket', // 'bucket' | 'inclined'
        string: {
          nStacks: 2, bucketsPerStack: 4, stacks: [],
          types: [{ id: 'T1', name: 'Bucket type 1', dTop: 1300, dBot: 1000, h: 2000, t: 20, ins: 300, mat: 'HDPE' }],
          defaultType: 'T1', overrides: {}, jointIns: null,
          window: { auto: true, start: 1, count: 4 }
        },
        inclined: { d: 900, L: 8000, angle: 35, angleRef: 'vertical', t: 20, mat: 'S355' },
        feedLen: 1500,
        dryLen: 6000,
        // pipe shape (bucket string): angles from vertical; current-driven shape from coupled/catenary.js
        shape: {
          mode: 'vertical',     // 'vertical' | 'tilt' (straight) | 'joints' (top angle + change per joint) | 'current'
          tilt: 3,              // deg, string angle (tilt) or top angle (joints)
          dJoint: 0,            // deg change at every joint (joints mode)
          U0: 1.0,              // m/s, current speed at the surface
          profile: 'power',     // 'uniform' | 'power' (1/7 power law)
          depth: 40,            // m, water depth for the current profile
          vVessel: 0,           // m/s, vessel speed in the current direction (relative current = U - V)
          Cd: 1.0,              // drag coefficient of the bucket string (ASSUMPTION; rough cylinder with lips)
          chainW: 0.5,          // kN/m, submerged weight of chains/wires carrying the string (ASSUMPTION)
          topLimit: 7,          // deg, allowed fall-pipe angle in the moonpool while dumping (design dependent)
          rov: { on: true, W: 200, A: 10, Cd: 1.0, thrust: 30, target: 0 } // kN in water, m2, -, kN, m (ASSUMPTIONS)
        },   // mm, vertical height of the pipe top above the water surface in the moonpool (dry part)
        funnel: { on: false, topWidth: 3000 } // hopper / funnel above the pipe top at the moonpool
      },
      materials: clone(FP.materials.DEFAULT_MATERIALS),
      gradeId: 'batch-lma40-200',
      grade: clone(lib.find(g => g.id === 'batch-lma40-200')),
      shape: {
        mode: 'rock',        // 'rock' | 'sphere' | 'clump2' | 'clump3'
        shapeModel: 'classes', // 'classes' (Zingg mix, angular blocks) | 'lt' (L/T distribution, ellipsoids)
        orient: 'random',    // 'random' | 'inplane'
        capL: false,         // cap L at the grade's Lmax/Dn
        useMeasured: true,   // use measured shape sub-population if the grade has one
        irregularScale: 1,
        elong: 1.6,          // legacy clumps only
        uniform: false,      // deliberate identical-stone simplification
        dnPerD: classTableDnPerD() // sieve size -> Dn for sieve grades without class data
      },
      feed: {
        mode: 'mass',        // 'mass' (t/h, 3D nominal) | 'count' (stones/s in the slice)
        massFlow: 1000, partRate: 20,
        maxStones: 0,        // 0 = continuous for the whole run
        v0Mode: 'input', v0: 1.5,
        opening: 1000, offset: 0,
        fillZone: 0.7,       // upper share of the feed chute where stones are released
        prefill: false,      // restart case: DEM window full of rock, settled on a closed outlet gate
        settle: 3            // s, settling time before the gate opens and the feed starts
      },
      physics: {
        g: 9.81,
        fluid: true, rhoF: 1025, cd: 1.0,
        muPP: 0.6, muPW: 0.4, ePP: 0.3, ePW: 0.3, muRollPP: 0.05, muRollPW: 0.05,
        wallContactFrom: 'material', // 'material' | 'global'
        wallStiffMode: 'material',   // 'material' (E* ratio) | 'same'
        Erock: 50e9, nuRock: 0.25, kRatioMin: 0.5, kRatioMax: 5,
        ktRatio: 0.5,
        kMode: 'auto', overlapPct: 2.0, vChar: 2.5, kMassRef: 'M90', kn: 5e6,
        dtMode: 'auto', tcFactor: 0.15, dt: 2e-5,
        capFactor: 1.0
      },
      run: { duration: 30, durUnit: 's', timeScale: 1, seedMode: 'random', seed: 1 }, // 'random': new stone sequence every run
      detect: {
        sampleDt: 0.05, window: 2.0, warmupMode: 'auto', warmup: 6,
        rRestrict: 0.7, rBlock: 0.1, vStall: 0.05, phiJam: 0.5,
        tPersist: 2.0, breakTol: 0.25, tMinBridge: 0.2, binLen: 400, restrictedFrac: 0.2
      },
      water: {
        model: 'coupled',   // 'coupled' (entrained flow) | 'still' (V2: still water)
        hindered: true,     // Di Felice (1994) voidage correction of drag
        Ca: 0.5,            // added-mass coefficient (sphere, potential flow)
        mu: 1.08e-3,        // seawater dynamic viscosity [Pa s] (typical, ~15 degC)
        Kin: 0.5,           // entrance loss at the top inlet (sharp-edged, typical handbook value)
        frictionMode: 'haaland', fDarcy: 0.015,
        leakage: true,      // water exchange through the annular gaps at bucket transitions
        CdGap: 0.61,        // gap discharge coefficient (sharp-edged orifice, typical)
        tSmooth: 1.0        // s, smoothing of the rock loading fed to the water column
      },
      checks: {
        packing: 0.6,      // ASSUMPTION: bulk solid fraction when the grade has no bulk density
        bevC: 0.58,        // Beverloo C (Madrid et al. 2017: ~0.58 for most materials)
        bevK: 1.5,         // ASSUMPTION: Beverloo k (varies up to x2 between materials)
        rzBeta: 2.39,      // Richardson-Zaki exponent, Re_p > ~200-400 (Miedema)
        tdC: 0.14, tdAlpha: 3.0, tdEll: 0.75 // Thomas & Durian 2015 fit (3D hopper, monodisperse)
      },
      system: FP.coupled ? FP.coupled.defaults() : {}
    };
  }

  /* Computed quantities shown read-only in the UI and fed to the engine. */
  function derive(cfg, geom, fac) {
    const P = cfg.physics, G = cfg.grade, F = cfg.feed, st = fac.stats;
    const d50 = st.Dn50;
    const fluid = !!P.fluid;
    const buoy = fluid ? 1 - P.rhoF / G.rho : 1;
    const vTerm = (d) => fluid ? Math.sqrt(4 / 3 * P.g * d * (G.rho - P.rhoF) / (P.rhoF * P.cd)) : Infinity;

    // Slice scaling: the simulated plane is a strip of thickness Dn50 through the axis.
    const Win = geom.inletWidth;
    const sliceFactor = Math.min(1, (Win * d50) / (Math.PI * Win * Win / 4));
    const meanMass = st.meanMass;
    const massRateSlice = F.mode === 'count' ? F.partRate * meanMass : (F.massFlow / 3.6) * sliceFactor;
    const partRate = massRateSlice / meanMass;

    // Contact stiffness (softened, set from a target overlap at vChar)
    const m50 = G.rho * d50 * d50 * d50;
    const mRef = P.kMassRef === 'M50' ? m50 : G.rho * Math.pow(st.Dn90, 3);
    const knAuto = mRef * P.vChar * P.vChar / Math.pow(P.overlapPct / 100 * d50, 2);
    const kn = P.kMode === 'auto' ? knAuto : P.kn;
    const kt = P.ktRatio * kn;
    const wallProps = geom.mats.map(id => FP.materials.contactProps(FP.materials.find(cfg.materials, id), P));
    const kRatioMax = Math.max.apply(null, wallProps.map(w => w.kRatio).concat([1]));
    // Shortest contact: smallest m / (Dn/2) over the stone sample.
    const tcPP = Math.PI * Math.sqrt(st.minRatio * d50 / (4 * kn));
    const tcPW = Math.PI * Math.sqrt(st.minRatio * d50 / (2 * kn * kRatioMax));
    const tc = Math.min(tcPP, tcPW);
    const dtAuto = P.tcFactor * tc;
    const dt = P.dtMode === 'auto' ? dtAuto : P.dt;

    // Inlet velocity
    const v0 = F.v0Mode === 'terminal' && fluid ? vTerm(d50) : F.v0; // velocity at water entry

    // Dry part (moonpool): pipe top above the water surface. Stones fall in air there.
    const sinA = Math.max(0.05, Math.sin(geom.axisAngleH));
    const dryV = fluid ? Math.max(0, (cfg.pipe.dryLen || 0) / 1000) : 0; // vertical [m], moonpool string or side pipe
    const cosTop = geom.shape && geom.shape.active ? Math.cos(geom.shape.thetaAt(0)) : 1;
    const sDryG = dryV / (sinA * cosTop);                                        // along the axis, global [m]
    const sDryWin = Math.max(0, Math.min(geom.L, sDryG - (geom.s0Global || 0))); // dry length inside the DEM window
    const gAir = P.g * sinA * cosTop;
    // speed at the water surface for a stone released at the pipe top with v0 (air drag neglected)
    const vEntry = Math.sqrt(v0 * v0 + 2 * gAir * sDryG);
    // Transit estimate for detection warm-up
    const gAx = P.g * buoy * sinA;
    let tTransit;
    const vWinIn = Math.sqrt(v0 * v0 + 2 * gAir * Math.max(0, Math.min(sDryG, geom.s0Global || 0)));
    const tDry = sDryWin > 0 ? (-vWinIn + Math.sqrt(vWinIn * vWinIn + 2 * gAir * sDryWin)) / gAir : 0;
    if (fluid) {
      const vl = vTerm(d50) * Math.sqrt(sinA);
      tTransit = tDry + (geom.L - sDryWin) / Math.max(vl, 0.05) + vl / gAx;
    } else tTransit = (-v0 + Math.sqrt(v0 * v0 + 2 * gAx * geom.L)) / gAx;
    tTransit += geom.feedLen / Math.max(v0, 0.3);
    const warmupAuto = 2 * tTransit + Math.max(cfg.detect.window, 10 / Math.max(partRate, 1e-6));

    // Body capacity from the domain area (continuous flow recycles slots)
    const cap = Math.max(120, Math.min(9000, Math.ceil((geom.area * 0.9 / st.meanArea + 40) * P.capFactor)));

    return {
      d50, sliceFactor, meanMass, massRateSlice, partRate, v0, dryV, sDryG, sDryWin, vEntry,
      buoy, vTerm50: vTerm(d50), vTermMin: vTerm(st.Dn10), vTermMax: vTerm(st.Dn90),
      knAuto, kn, kt, m50, mRef, tc, tcPP, tcPW, kRatioMax, wallProps, dtAuto, dt, dtOverTc: dt / tc,
      stepsPerSecond: 1 / dt, tTransit, warmupAuto,
      warmup: cfg.detect.warmupMode === 'auto' ? warmupAuto : cfg.detect.warmup,
      nominalSliceMassRate: massRateSlice, cap,
      toTph: 3.6 / sliceFactor // slice kg/s -> 3D-equivalent t/h
    };
  }

  FP.config = { defaultConfig, derive, clone, classTableDnPerD };
})(self.FP = self.FP || {});
