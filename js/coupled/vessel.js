/* ==========================================================================
 * coupled/vessel.js   INTERFACE ONLY (not used in V2 calculations)
 * Future top-end boundary condition: static offset plus six-degree-of-freedom
 * motions (surge, sway, heave, roll, pitch, yaw) from RAOs and a sea state,
 * or from a measured motion time series. Moonpool / side-deployment point
 * position relative to the vessel motion reference point.
 * ========================================================================== */
(function (FP) {
  'use strict';
  FP.coupled.register('vessel', {
    info: { name: 'Vessel offset and 6-DOF motion', status: 'interface only', module: 'coupled/vessel.js' },
    defaults: () => ({ offset: { x: 0, y: 0 }, hangOff: { x: null, y: null, z: null }, motion: 'none', rao: null, seaState: { Hs: null, Tp: null, dir: null }, timeSeries: null }),
    state() { throw new Error('Vessel module not implemented in V2'); }
  });
})(self.FP = self.FP || {});
