/* ==========================================================================
 * js3d/worker3d.js
 * Web Worker running one 3D simulation (or one benchmark case) headless with
 * the same modules as the Simulate tab.
 * In:  { id, kind: 'run' | 'bench', cfg, seed, bench, opts }
 * Out: { id, progress } during the run, then { id, result }.
 * ========================================================================== */
/* global importScripts */
importScripts('../js/coupled/system.js', '../js/coupled/catenary.js', '../js/coupled/hydro.js', '../js/coupled/vessel.js', '../js/coupled/rov.js',
  '../js/materials.js', '../js/grades.js', '../js/particles.js', '../js/shapes.js', '../js/string.js', '../js/config.js', '../js/units.js',
  '../js/geometry.js', '../js/water.js', '../js/detection.js', '../js/results.js', '../js/stats.js',
  'shapes3d.js', 'particles3d.js', 'geometry3d.js', 'config3d.js', 'physics3d.js', 'detection3d.js', 'extra3d.js', 'runner3d.js', 'bench3d.js');

self.onmessage = function (ev) {
  const { id, kind, cfg, seed, bench, opts } = ev.data;
  try {
    if (kind === 'bench') { self.postMessage({ id, result: self.FP.bench3d.runCase(bench, seed, (f) => self.postMessage({ id, progress: f })) }); return; }
    const st = self.FP.runner3d.setup(cfg, seed);
    if (st.error) { self.postMessage({ id, result: st }); return; }
    let last = 0;
    while (!self.FP.runner3d.advance(st, 200, opts || {})) {
      const now = Date.now(); if (now - last > 400) { last = now; self.postMessage({ id, progress: st.eng.t / st.T }); }
    }
    self.postMessage({ id, result: self.FP.runner3d.finish(st) });
  } catch (err) {
    self.postMessage({ id, result: { error: String(err && err.message || err) } });
  }
};
