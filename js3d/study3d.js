/* ==========================================================================
 * js3d/study3d.js
 * Repeated 3D runs (probability) and parametric studies, headless.
 *
 * Each job is one configuration + one seed. Jobs run in a pool of Web
 * Workers (js3d/worker3d.js) with exactly the same 3D modules as the
 * Simulate tab, without drawing. Without worker support they run
 * time-sliced on the page. Results are aggregated per cell with
 * FP.stats.aggregate (Wilson intervals, Poisson blockage rate per tonne).
 * ========================================================================== */
(function (FP) {
  'use strict';

  const setType = (c, k, v) => { c.pipe.string.types.forEach(t => { if (t.id === c.pipe.string.defaultType) t[k] = v; }); };
  const PARAMS = {
    none: { label: 'None (repeated runs of the current setup)', types: ['bucket', 'inclined'], apply: () => {} },
    bucketBot: { label: 'Bucket bottom ID, default type [mm]', types: ['bucket'], guess: '800, 900, 1000, 1100', apply: (c, v) => setType(c, 'dBot', v) },
    bucketTop: { label: 'Bucket top ID, default type [mm]', types: ['bucket'], guess: '1100, 1300, 1500', apply: (c, v) => setType(c, 'dTop', v) },
    bucketBoth: { label: 'Bucket bottom ID, top ID scaled with it [mm]', types: ['bucket'], guess: '800, 900, 1000, 1100', apply: (c, v) => { c.pipe.string.types.forEach(t => { if (t.id === c.pipe.string.defaultType) { const r = t.dTop / t.dBot; t.dBot = v; t.dTop = Math.round(v * r); } }); } },
    insertion: { label: 'Bucket insertion length, default type [mm]', types: ['bucket'], guess: '150, 300, 450', apply: (c, v) => setType(c, 'ins', v) },
    pipeD: { label: 'Inclined pipe ID [mm]', types: ['inclined'], guess: '700, 900, 1100', apply: (c, v) => { c.pipe.inclined.d = v; } },
    angle: { label: 'Inclination [deg, current convention]', types: ['inclined'], guess: '20, 35, 50', apply: (c, v) => { c.pipe.inclined.angle = v; } },
    massFlow: { label: 'Mass flow [t/h]', types: ['bucket', 'inclined'], guess: '1000, 2000, 3000', apply: (c, v) => { c.feed.mode = 'mass'; c.feed.massFlow = v; } },
    beltSpeed: { label: 'Conveyor belt speed [m/s] (sets conveyor feed)', types: ['bucket', 'inclined'], guess: '2, 3, 4', apply: (c, v) => { c.feed.source = 'conveyor'; c.feed.belt.speed = v; } },
    rollAmp: { label: 'Roll amplitude [deg] (sets vessel motion on)', types: ['bucket', 'inclined'], guess: '0, 2, 4', apply: (c, v) => { c.vessel.on = v > 0 || c.vessel.on; c.vessel.rollAmp = v; } },
    tilt: { label: 'Pipe tilt from vertical [deg]', types: ['bucket'], guess: '0, 3, 6', apply: (c, v) => { c.pipe.shape.mode = v ? 'tilt' : 'vertical'; c.pipe.shape.tilt = v; } },
    dryLen: { label: 'Pipe top above water [m]', types: ['bucket', 'inclined'], guess: '0, 3, 6', apply: (c, v) => { c.pipe.dryLen = v * 1000; } },
    muPW: { label: 'Rock-wall friction [-] (sensitivity)', types: ['bucket', 'inclined'], guess: '0.2, 0.3, 0.45', apply: (c, v) => { c.physics.wallContactFrom = 'global'; c.physics.muPW = v; } },
    muPP: { label: 'Rock-rock friction [-] (sensitivity)', types: ['bucket', 'inclined'], guess: '0.45, 0.6, 0.75', apply: (c, v) => { c.physics.muPP = v; } },
    vfBlock: { label: 'Block volume factor V/(L B T) [-] (corner roundness)', types: ['bucket', 'inclined'], guess: '0.55, 0.6, 0.7', apply: (c, v) => { c.grade.shape.vfBlock = v; } }
  };
  /** Allow zero for the parameters where it is meaningful. */
  PARAMS.rollAmp.zeroOk = PARAMS.tilt.zeroOk = PARAMS.dryLen.zeroOk = true;

  let pool = null;
  function nWorkers() { return Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 1)); }
  function makePool() {
    if (pool !== null) return pool;
    try {
      const ws = [];
      for (let i = 0; i < nWorkers(); i++) ws.push(new Worker('js3d/worker3d.js'));
      pool = { workers: ws, busy: ws.map(() => false) };
    } catch (e) { pool = false; }
    return pool;
  }

  /** Same run as the worker, time-sliced on the page (fallback). */
  function runMain(cfg, seed, opts, onProgress) {
    return new Promise((resolve) => {
      let st;
      try { st = FP.runner3d.setup(cfg, seed); } catch (e) { resolve({ error: String(e.message || e) }); return; }
      if (st.error) { resolve(st); return; }
      (function slice() {
        if (opts.cancelled) { resolve({ cancelled: true }); return; }
        const done = FP.runner3d.advance(st, 25, opts);
        onProgress && onProgress(st.eng.t / st.T);
        if (done) resolve(FP.runner3d.finish(st)); else setTimeout(slice, 0);
      })();
    });
  }

  function runJobs(jobs, opts, onDone, onProgress) {
    const P = makePool();
    const prog = jobs.map(() => 0);
    const report = () => onProgress(prog.reduce((a, b) => a + b, 0) / jobs.length);
    if (!P) {
      return jobs.reduce((p, job, i) => p.then(() => opts.cancelled ? null : runMain(job.cfg, job.seed, opts, f => { prog[i] = f; report(); }).then(r => { prog[i] = 1; report(); if (!r.cancelled) onDone(job, r); })), Promise.resolve());
    }
    return new Promise((resolve) => {
      let next = 0, running = 0;
      const launch = () => {
        if (opts.cancelled) { if (!running) resolve(); return; }
        while (running < P.workers.length && next < jobs.length) {
          const wi = P.busy.indexOf(false);
          if (wi < 0) break;
          const i = next++, job = jobs[i], w = P.workers[wi];
          P.busy[wi] = true; running++;
          w.onmessage = (ev) => {
            if (ev.data.id !== i) return;
            if (ev.data.progress != null) { prog[i] = ev.data.progress; report(); return; }
            prog[i] = 1; report();
            P.busy[wi] = false; running--;
            if (!opts.cancelled) onDone(job, ev.data.result);
            if (next >= jobs.length && !running) resolve(); else launch();
          };
          w.onerror = (err) => {
            err.preventDefault && err.preventDefault();
            P.busy[wi] = false; running--;
            onDone(job, { error: 'Worker error: ' + (err.message || 'unknown') });
            if (next >= jobs.length && !running) resolve(); else launch();
          };
          w.postMessage({ id: i, kind: job.kind || 'run', cfg: job.cfg, seed: job.seed, bench: job.bench, opts: { stopOnRed: opts.stopOnRed } });
        }
        if (next >= jobs.length && !running) resolve();
      };
      launch();
    });
  }

  function cancelAll() { if (pool && pool.workers) { pool.workers.forEach(w => w.terminate()); pool = null; } }

  /**
   * spec: { base, grades, param, values, reps, duration, seed0 }
   * onCell(i, j, cell) after each finished run, onProgress(f, text).
   */
  function run(spec, opts, onCell, onProgress) {
    const P = PARAMS[spec.param] || PARAMS.none;
    const values = spec.param === 'none' ? [null] : spec.values;
    const jobs = [];
    // interleave seeds so every cell fills up evenly while the study runs
    for (let r = 0; r < spec.reps; r++) spec.grades.forEach((g, i) => values.forEach((v, j) => {
      const cfg = FP.config.clone(spec.base);
      cfg.grade = FP.config.clone(g); cfg.gradeId = g.id;
      if (!cfg.grade.shape) cfg.grade.shape = FP.grades.defaultShape();
      if (v != null) P.apply(cfg, v);
      if (spec.duration > 0) cfg.run.duration = spec.duration;
      jobs.push({ cfg, seed: (spec.seed0 || 1) + r * 7919, i, j, r });
    }));
    const cells = spec.grades.map(g => values.map(v => ({ grade: g.name, value: v, runs: [] })));
    return runJobs(jobs, opts, (job, res) => {
      res.seed = job.seed;
      cells[job.i][job.j].runs.push(res);
      onCell(job.i, job.j, cells[job.i][job.j]);
    }, (f) => onProgress(f, Math.round(f * jobs.length) + ' of ' + jobs.length + ' runs')).then(() => cells);
  }

  FP.study3d = { PARAMS, run, runJobs, runMain, cancelAll, nWorkers };
})(self.FP = self.FP || {});
