/* ==========================================================================
 * js3d/runner3d.js
 * One headless 3D run (setup, advance, finish). Used by the workers and by
 * the page fallback, so a study run is exactly a Simulate run without the view.
 * ========================================================================== */
(function (FP) {
  'use strict';

  function setup(cfg, seed) {
    const v = FP.units.validate(cfg);
    if (v.errors.length) return { error: v.errors[0] };
    const geom = FP.geometry3d.build(cfg), fac = FP.particles3d.factory(cfg.grade, cfg), dv = FP.config3d.derive(cfg, geom, fac);
    const eng = new FP.physics3d.Engine(cfg, geom, fac, dv, seed);
    const det = new FP.detection3d.Detector(cfg, geom, eng, dv);
    return { cfg, geom, fac, dv, eng, det, T: cfg.run.duration };
  }

  /** Step for up to budgetMs; returns true when the run is finished. */
  function advance(st, budgetMs, opts) {
    const t0 = Date.now(), e = st.eng, d = st.det;
    while (Date.now() - t0 < budgetMs && e.t < st.T) {
      for (let i = 0; i < 50 && e.t < st.T; i++) { e.step(); d.maybeSample(); }
      if (opts.stopOnRed && d.level >= 3) return true;
    }
    return e.t >= st.T || (opts.stopOnRed && d.level >= 3);
  }

  function finish(st) {
    const fin = st.det.finalize();
    const s = FP.results.summarize(st.cfg, st.geom, st.dv, st.eng, st.det, fin, st.fac);
    FP.extra3d.attach(s, st.eng, st.geom);
    s.cfg = null; s.stoppedEarly = st.eng.t < st.T; s.dim = 3;
    s.events = s.events.slice(0, 20);
    return s;
  }

  FP.runner3d = { setup, advance, finish };
})(self.FP = self.FP || {});
