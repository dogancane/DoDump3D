/* ==========================================================================
 * materials.js
 * Bucket / pipe material library and contact-property helpers.
 *
 * Every property carries a source tag:
 *   'datasheet'  value from a cited supplier datasheet
 *   'standard'   nominal value from a cited standard
 *   'definition' follows from the material designation (e.g. PE80 -> MRS 8 MPa)
 *   'typical'    typical literature value, not verified for a specific product
 *   'assumption' provisional modelling value, no source; replace with test data
 * Values are editable in the UI and custom materials can be added.
 *
 * Material properties are used for:
 *   - bucket mass and submerged weight (density)
 *   - axial / bending stiffness EA, EI and allowable axial load (E, allowable stress)
 *   - rock-wall contact: friction, restitution, rolling resistance, and the
 *     contact stiffness ratio from the Hertz effective modulus E*
 *   - future structural / catenary analysis (all fields are exported)
 * ========================================================================== */
(function (FP) {
  'use strict';

  const SRC = {
    scg: 'SCG Chemicals HDPE H1000PC (PE100) datasheet: density 0.960 g/cm3, flexural modulus 1000 MPa, tensile strength at yield 24 MPa, MRS 10 MPa',
    pe80: 'PE80 designation (ISO 12162): MRS 8 MPa',
    ec3: 'EN 1993-1-1 / EN 10025-2 nominal values for S355 (t <= 16 mm)'
  };

  const DEFAULT_MATERIALS = [
    { id: 'HDPE', name: 'HDPE (PE100)', rho: 960, E: 1.0e9, nu: 0.45, sAllow: 24e6, mrs: 10e6, rough: 0.007, mu: 0.30, e: 0.25, muRoll: 0.05,
      src: { rho: 'datasheet', E: 'datasheet', nu: 'typical', sAllow: 'datasheet', mrs: 'datasheet', rough: 'typical', mu: 'assumption', e: 'assumption', muRoll: 'assumption' },
      note: SRC.scg + '. E is the short-term flexural modulus; PE creeps, so long-term stiffness is lower. sAllow is yield, not a design stress.' },
    { id: 'MDPE', name: 'MDPE (PE80)', rho: 940, E: 0.7e9, nu: 0.45, sAllow: 18e6, mrs: 8e6, rough: 0.007, mu: 0.30, e: 0.25, muRoll: 0.05,
      src: { rho: 'typical', E: 'typical', nu: 'typical', sAllow: 'typical', mrs: 'definition', rough: 'typical', mu: 'assumption', e: 'assumption', muRoll: 'assumption' },
      note: SRC.pe80 + '. Other values are typical and must be checked against the supplier datasheet.' },
    { id: 'PE', name: 'PE (generic)', rho: 950, E: 0.8e9, nu: 0.45, sAllow: 20e6, mrs: null, rough: 0.007, mu: 0.30, e: 0.25, muRoll: 0.05,
      src: { rho: 'assumption', E: 'assumption', nu: 'typical', sAllow: 'assumption', mrs: 'assumption', rough: 'typical', mu: 'assumption', e: 'assumption', muRoll: 'assumption' },
      note: 'Placeholder for an unspecified polyethylene. Replace with the actual grade.' },
    { id: 'S355', name: 'Steel S355', rho: 7850, E: 210e9, nu: 0.30, sAllow: 355e6, mrs: null, rough: 0.045, mu: 0.40, e: 0.40, muRoll: 0.05,
      src: { rho: 'standard', E: 'standard', nu: 'standard', sAllow: 'standard', mrs: 'assumption', rough: 'typical', mu: 'assumption', e: 'assumption', muRoll: 'assumption' },
      note: SRC.ec3 + '. sAllow is nominal yield; apply the project safety factors.' }
  ];

  /** Hertz effective modulus of two bodies. */
  function eStar(E1, nu1, E2, nu2) { return 1 / ((1 - nu1 * nu1) / E1 + (1 - nu2 * nu2) / E2); }

  /**
   * Contact properties of a material against rock.
   * kRatio = E*(rock-wall) / E*(rock-rock): scales the softened DEM wall stiffness
   * so a compliant wall (PE) is softer than rock-on-rock and steel is stiffer.
   */
  function contactProps(mat, phys) {
    const Er = phys.Erock, nr = phys.nuRock;
    let kRatio = 1;
    if (phys.wallStiffMode === 'material' && mat && mat.E > 0) {
      kRatio = eStar(Er, nr, mat.E, mat.nu) / eStar(Er, nr, Er, nr);
      kRatio = Math.min(phys.kRatioMax, Math.max(phys.kRatioMin, kRatio));
    }
    const useMat = phys.wallContactFrom === 'material' && mat;
    return {
      mu: useMat ? mat.mu : phys.muPW,
      e: useMat ? mat.e : phys.ePW,
      muRoll: useMat ? mat.muRoll : phys.muRollPW,
      kRatio,
      kRatioRaw: mat && mat.E > 0 ? eStar(Er, nr, mat.E, mat.nu) / eStar(Er, nr, Er, nr) : 1
    };
  }

  function find(list, id) { return list.find(m => m.id === id) || list[0]; }

  FP.materials = { DEFAULT_MATERIALS, eStar, contactProps, find, SRC };
})(self.FP = self.FP || {});
