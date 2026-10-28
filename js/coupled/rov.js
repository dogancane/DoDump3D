/* ==========================================================================
 * coupled/rov.js   INTERFACE ONLY (not used in V2 calculations)
 * Future Fall Pipe ROV coupling at the bottom end. Modes:
 *   'free'        ROV as a body with mass, added mass, drag and thrust
 *   'controlled'  position/heading controller with thrust limits
 *   'fixed'       fixed point (only when deliberately selected)
 * Effects: bottom position, horizontal offset, tension, curvature, drag,
 * bucket alignment and dynamic response of the string.
 * ========================================================================== */
(function (FP) {
  'use strict';
  FP.coupled.register('rov', {
    info: { name: 'Fall Pipe ROV forces and control', status: 'interface only', module: 'coupled/rov.js' },
    defaults: () => ({ mode: 'free', mass: null, submergedWeight: null, addedMass: null, Cd: null, area: null, thrustMax: { x: null, y: null, z: null }, target: { x: null, y: null } }),
    loads() { throw new Error('ROV module not implemented in V2'); }
  });
})(self.FP = self.FP || {});
