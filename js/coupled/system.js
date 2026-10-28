/* ==========================================================================
 * coupled/system.js
 * Registry for the coupled fall-pipe system. V2 implements module 1-3 and 8;
 * modules 4-7 are interfaces only (inputs are stored, nothing is computed).
 *
 *   1 rock flow ........... physics.js + detection.js        implemented (quasi-2D DEM)
 *   2 geometry ............ geometry.js + string.js          implemented
 *   3 materials/structure . materials.js + string.js         implemented (section properties)
 *   4 catenary/dynamics ... coupled/catenary.js              interface only
 *   5 current/hydro ....... coupled/hydro.js                 interface only
 *   6 vessel motion ....... coupled/vessel.js                interface only
 *   7 fall pipe ROV ....... coupled/rov.js                   interface only
 *   8 blockage probability  stats.js + study.js              implemented
 *
 * Coupling plan (one time step of the future coupled model):
 *   vessel.state(t)          -> top-end position, velocity, acceleration (6 DOF)
 *   hydro.loads(string, t)   -> drag, added mass, buoyancy per element
 *   rov.loads(state, t)      -> thrust / tension / constraint at the bottom end
 *   catenary.step(...)       -> node positions, tension, curvature, bucket tilt
 *                               and lateral offsets at each transition
 *   string.alignment         <- offsets/tilts fed back to the DEM geometry
 *   rock flow                -> internal rock mass and wall loads per bucket
 *                               fed back to the catenary as distributed load
 * The rock-flow module must be validated before these couplings are enabled.
 * ========================================================================== */
(function (FP) {
  'use strict';
  const mods = {};
  function register(name, mod) { mods[name] = mod; }
  function defaults() {
    const out = {};
    Object.keys(mods).forEach(k => { out[k] = mods[k].defaults(); });
    return out;
  }
  function list() { return Object.keys(mods).map(k => Object.assign({ key: k }, mods[k].info)); }
  FP.coupled = { register, defaults, list, mods };
})(self.FP = self.FP || {});
