/* ==========================================================================
 * coupled/hydro.js   INTERFACE ONLY (not used in V2 calculations)
 * Future hydrodynamic loads on the string (Morison type, relative velocity):
 *   f = 0.5 rho Cd D |u_r| u_r  +  rho (1 + Ca) A du/dt  -  rho Ca A dv/dt
 * per unit length, with u_r = current - structure velocity, plus buoyancy
 * and the water column inside the buckets. Current given as a profile of
 * speed and direction over depth. Coefficients depend on Re, KC and
 * roughness and must be supplied (no defaults are assumed).
 * ========================================================================== */
(function (FP) {
  'use strict';
  FP.coupled.register('hydro', {
    info: { name: 'Current and hydrodynamic loads', status: 'interface only', module: 'coupled/hydro.js' },
    defaults: () => ({ waterDepth: null, rhoW: 1025, profile: [{ z: 0, U: null, dir: null }], Cd: null, Ca: null, roughness: null }),
    loads() { throw new Error('Hydro module not implemented in V2'); }
  });
})(self.FP = self.FP || {});
