/* ==========================================================================
 * js3d/prob3d.js
 * Probability tab of the 3D page: many headless runs (seeds) per cell, for
 * selected rock grades against one varied parameter (pipe size, flow, feed,
 * vessel motion, friction sensitivity). Runs use background workers and
 * never draw. Also runs the 3D validation benchmark.
 * ========================================================================== */
(function (FP) {
  'use strict';
  const U = FP.ui, $ = U.$, $$ = U.$$, esc = U.esc, fx = U.fx;
  const KEY = 'fallpipe3d.study.v1';
  let studyOpts = null, lastSpec = null, lastCells = null, selCell = null, benchOpts = null;

  try { const sv = JSON.parse(localStorage.getItem(KEY) || 'null'); if (sv && sv.spec && sv.cells) { lastSpec = sv.spec; lastCells = sv.cells; selCell = [0, 0]; } } catch (e) { /* no storage */ }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ spec: Object.assign({}, lastSpec, { base: null }), cells: lastCells })); } catch (e) { /* storage full */ } }

  function render() {
    const cfg = U.cfg, P = FP.study3d.PARAMS, sel = $('#stParam');
    const cur = sel.value || 'none';
    sel.innerHTML = Object.keys(P).filter(k => P[k].types.indexOf(cfg.pipe.type) >= 0).map(k => '<option value="' + k + '">' + esc(P[k].label) + '</option>').join('');
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'none';
    $('#stValuesRow').hidden = sel.value === 'none';
    if (!$('#stValues').value && P[sel.value] && P[sel.value].guess) $('#stValues').value = P[sel.value].guess;
    const prev = new Set($$('#stGrades input:checked').map(i => i.value));
    $('#stGrades').innerHTML = U.library.map((g, i) => '<label class="row check"><input type="checkbox" id="stg-' + i + '" value="' + esc(g.id) + '"' + ((prev.size ? prev.has(g.id) : g.id === cfg.grade.id) ? ' checked' : '') + '><span>' + esc(g.name) + (g.id === cfg.grade.id ? ' (current)' : '') + '</span></label>').join('');
    let gt = ''; try { gt = FP.results.geometryText(cfg, FP.geometry.build(cfg)); } catch (e) { gt = 'invalid geometry'; }
    $('#stBase').textContent = 'Base case: everything as on the Simulate tab (' + gt + '; feed ' + (cfg.feed.mode === 'mass' ? cfg.feed.massFlow + ' t/h' : cfg.feed.partRate + ' stones/s') + ', ' + (cfg.feed.source === 'conveyor' ? 'conveyor discharge' : 'drop feed') + ', vessel motion ' + (cfg.vessel && cfg.vessel.on ? 'on' : 'off') + ', precision ' + (cfg.physics.precision || 'standard') + '). Each run uses its own seed: new stone sizes, shapes, orientations and release points.';
    $('#stWorkers').textContent = 'Runs execute in ' + FP.study3d.nWorkers() + ' parallel background workers. Nothing is drawn while they run; you can keep using the other tabs.';
    if (lastCells) drawMatrix(lastSpec, lastCells);
  }

  function readSpec() {
    const cfg = U.cfg, param = $('#stParam').value, P = FP.study3d.PARAMS[param];
    const values = param === 'none' ? [null] : $('#stValues').value.split(/[,;\s]+/).filter(x => x !== '').map(Number).filter(v => isFinite(v) && (v > 0 || (P.zeroOk && v === 0)));
    const ids = $$('#stGrades input:checked').map(i => i.value);
    const grades = ids.map(id => id === cfg.grade.id ? cfg.grade : U.library.find(g => g.id === id)).filter(Boolean);
    const reps = Math.max(1, Math.min(5000, parseInt($('#stReps').value, 10) || 1)); $('#stReps').value = reps;
    return { base: FP.config.clone(cfg), grades, param, values, reps, duration: parseFloat($('#stDur').value) || 0, seed0: parseInt($('#stSeed').value, 10) || 1 };
  }

  function runStudy() {
    if (studyOpts || benchOpts) return;
    const spec = readSpec(), msg = $('#stMsg');
    const v = FP.units.validate(U.cfg);
    if (v.errors.length) { msg.textContent = 'Fix the input errors on the Simulate tab first: ' + v.errors[0]; return; }
    if ((spec.param !== 'none' && !spec.values.length) || !spec.grades.length) { msg.textContent = 'Select at least one grade and enter at least one value.'; return; }
    const nRuns = spec.grades.length * spec.values.length * spec.reps;
    msg.textContent = nRuns + ' runs queued.';
    studyOpts = { cancelled: false, stopOnRed: $('#stStop').checked };
    lastSpec = spec; lastCells = spec.grades.map(g => spec.values.map(val => ({ grade: g.name, value: val, runs: [] }))); selCell = [0, 0];
    drawMatrix(spec, lastCells);
    $('#stRun').disabled = true; $('#stCancel').disabled = false; $('#benchRun').disabled = true;
    const t0 = performance.now(); let lastDraw = 0;
    FP.study3d.run(spec, studyOpts, (i, j, cell) => {
      lastCells[i][j] = cell;
      if (performance.now() - lastDraw > 500) { lastDraw = performance.now(); drawMatrix(spec, lastCells); }
    }, (f, label) => {
      $('#stBar').style.width = (f * 100).toFixed(1) + '%';
      const el = (performance.now() - t0) / 1000;
      $('#stProg').textContent = (f * 100).toFixed(0) + '%  ' + label + (f > 0.02 ? '  (about ' + clock(Math.max(0, el / f - el)) + ' left)' : '');
    }).then(() => {
      $('#stProg').textContent = studyOpts.cancelled ? 'Cancelled; finished runs are kept.' : 'Complete in ' + clock((performance.now() - t0) / 1000) + '.';
      studyOpts = null; $('#stRun').disabled = false; $('#stCancel').disabled = true; $('#benchRun').disabled = false;
      drawMatrix(spec, lastCells); save();
    });
  }
  function clock(s) { return s < 90 ? s.toFixed(0) + ' s' : s < 5400 ? (s / 60).toFixed(0) + ' min' : (s / 3600).toFixed(1) + ' h'; }

  function pct(w) { return isFinite(w.p) ? (w.p * 100).toFixed(0) + ' % [' + (w.lo * 100).toFixed(0) + ', ' + (w.hi * 100).toFixed(0) + ']' : 'n/a'; }
  function ciBar(w) {
    if (!isFinite(w.p)) return '';
    return '<span class="cibar"><span class="ci" style="left:' + (w.lo * 100) + '%;width:' + Math.max(0.5, (w.hi - w.lo) * 100) + '%"></span><span class="cip" style="left:' + (w.p * 100) + '%"></span></span>';
  }
  const paramLabel = (spec) => (FP.study3d.PARAMS[spec.param] || FP.study3d.PARAMS.none).label;

  function drawMatrix(spec, cells) {
    const vals = spec.param === 'none' ? [null] : spec.values;
    $('#stMatrix').innerHTML = '<div class="tbl-wrap"><table class="matrix"><thead><tr><th>Grade' + (spec.param === 'none' ? '' : ' \\ ' + esc(paramLabel(spec))) + '</th>' + vals.map(v => '<th>' + (v == null ? 'current setup' : v) + '</th>').join('') + '</tr></thead><tbody>' +
      spec.grades.map((g, i) => '<tr><th>' + esc(g.name) + '</th>' + vals.map((v, j) => {
        const c = cells[i] && cells[i][j];
        if (!c || !c.runs.length) return '<td class="pend">queued</td>';
        const errs = c.runs.filter(r => r.error);
        const A = FP.stats.aggregate(c.runs);
        if (!A.n) return '<td class="cell-err" title="' + esc(errs[0] ? errs[0].error : '') + '">input error</td>';
        const lv = FP.detection.Detector.CLASS[A.worst].level;
        return '<td class="mcell ' + U.LEVEL_CLASS[lv] + (selCell && selCell[0] === i && selCell[1] === j ? ' selc' : '') + '" data-cell="' + i + ',' + j + '" tabindex="0"><b>P(blockage) ' + pct(A.p.persistent) + '</b>' + ciBar(A.p.persistent) +
          '<span>P(dome or worse) ' + pct(A.p.atLeastTemporary) + '</span><span>n = ' + A.n + ' of ' + spec.reps + (errs.length ? ', ' + errs.length + ' errors' : '') + '</span></td>';
      }).join('') + '</tr>').join('') + '</tbody></table></div>' +
      '<p class="note">Share of runs (seeds) ending in persistent blockage, with the 95 % Wilson interval in brackets and as the bar. "Dome or worse" includes domes that broke up again. Select a cell for the breakdown.</p>' + sampleNote(spec);
    if (selCell && cells[selCell[0]] && cells[selCell[0]][selCell[1]]) drawCell(spec, cells[selCell[0]][selCell[1]], selCell);
  }
  function sampleNote(spec) {
    const n = spec.reps;
    const half = (p) => 1.96 * Math.sqrt(p * (1 - p) / n) * 100;
    return '<p class="note">With ' + n + ' runs per cell the interval half-width is about ' + half(0.5).toFixed(0) + ' points at 50 %, ' + half(0.1).toFixed(0) + ' at 10 % and ' + half(0.05).toFixed(1) + ' at 5 %. Two cells differ clearly when their intervals do not overlap.</p>';
  }

  function drawCell(spec, c, ij) {
    const A = FP.stats.aggregate(c.runs), el = $('#stDetail');
    if (!A.n) { el.innerHTML = ''; return; }
    const r = A.rate, X = parseFloat($('#stX') ? $('#stX').value : '') || 1000;
    const pX = (lam) => 1 - Math.exp(-lam * X);
    const ok = c.runs.filter(x => !x.error);
    // wall impacts: mean per run, per wall group
    const hit = {}; ok.forEach(x => (x.hits || []).forEach(h => { const o = hit[h.name] || (hit[h.name] = { n: 0, E: 0, v: 0 }); o.n += h.n; o.E += h.E; o.v = Math.max(o.v, h.vMax); }));
    const hitTxt = Object.keys(hit).length ? Object.keys(hit).map(k => esc(k) + ': ' + fx(hit[k].n / ok.length, 1) + ' impacts, ' + fx(hit[k].E / ok.length / 1000, 1) + ' kJ per run, peak ' + fx(hit[k].v, 1) + ' m/s').join('; ') : 'none';
    const vE = ok.map(x => x.entry && x.entry.vMed).filter(v => v != null);
    const rows = [
      ['Runs (seeds)', A.n],
      ['Free flow', A.counts.free + ' runs, ' + pct(A.p.free)],
      ['Restricted flow', A.counts.restricted + ' runs, ' + pct(A.p.restricted)],
      ['Temporary dome (broke up)', A.counts.temporary + ' runs, ' + pct(A.p.temporary)],
      ['Persistent blockage', A.counts.persistent + ' runs, ' + pct(A.p.persistent)],
      ['Total discharged rock (exposure)', fx(A.exposure, 1) + ' t'],
      ['Blockage rate per tonne (Poisson)', isFinite(r.rate) ? fx(r.rate * 1000, 2) + ' per 1000 t [' + fx(r.lo * 1000, 2) + ', ' + fx(r.hi * 1000, 2) + ']' : 'n/a'],
      ['P(blockage within X t), X = <input type="number" id="stX" value="' + X + '" style="width:6em">', isFinite(r.rate) ? fx(pX(r.rate) * 100, 1) + ' % [' + fx(pX(r.lo) * 100, 1) + ', ' + fx(pX(r.hi) * 100, 1) + ']' : 'n/a'],
      ['Time to blockage: min / median / max', A.tBlock.list.length ? fx(A.tBlock.min, 1) + ' / ' + fx(A.tBlock.median, 1) + ' / ' + fx(A.tBlock.max, 1) + ' s' : 'no blockage'],
      ['Rock discharged before blockage: min / median / max', A.massBeforeBlock.list.length ? fx(A.massBeforeBlock.min, 2) + ' / ' + fx(A.massBeforeBlock.median, 2) + ' / ' + fx(A.massBeforeBlock.max, 2) + ' t' : 'no blockage'],
      ['Blockage positions (nearest feature)', Object.keys(A.featCount).length ? Object.keys(A.featCount).map(k => esc(k) + ': ' + A.featCount[k]).join('; ') : 'none'],
      ['Stones in blocking domes', A.rocks.n ? 'median ' + fx(A.rocks.perArch, 0) + ' per dome; Dn median ' + fx(A.rocks.dnMedian, 0) + ', max ' + fx(A.rocks.dnMax, 0) + ' mm; L median ' + fx(A.rocks.lMedian, 0) + ', max ' + fx(A.rocks.lMax, 0) + ' mm' : 'none'],
      ['Wall impacts (mean per run)', hitTxt],
      ['Speed at the water surface (median of runs)', vE.length ? fx(FP.stats.quantile(vE, 0.5), 1) + ' m/s' : '-']
    ];
    el.innerHTML = '<h3>' + esc(c.grade) + (c.value != null ? ', ' + esc(paramLabel(spec)) + ' = ' + c.value : '') + '</h3><dl class="kv wide">' + rows.map(x => '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>').join('') + '</dl>' +
      '<h4>Individual runs</h4><div class="tbl-wrap"><table class="data"><thead><tr><th>Seed</th><th>Status</th><th>t block [s]</th><th>Rock before block [t]</th><th>Depth [m]</th><th>Feature</th><th>Dn in dome [mm]</th><th>L in dome [mm]</th><th>Out/in</th><th></th></tr></thead><tbody>' +
      c.runs.map((x, k) => x.error ? '<tr><td>' + esc(x.seed) + '</td><td colspan="9">' + esc(x.error) + '</td></tr>' : '<tr><td>' + x.seed + '</td><td>' + U.clsPill(x.cls) + '</td><td>' + (x.tBlock == null ? '-' : fx(x.tBlock, 1)) + '</td><td>' + (x.massOutBeforeBlock == null ? '-' : fx(x.massOutBeforeBlock, 2)) + '</td><td>' + (x.blockLocationGlobal == null ? '-' : fx(x.blockLocationGlobal, 2)) + '</td><td>' + esc(x.blockFeature || '-') + '</td><td>' + (x.blockSizes || []).slice(0, 6).map(v => fx(v, 0)).join(', ') + '</td><td>' + (x.blockLens || []).slice(0, 6).map(v => fx(v, 0)).join(', ') + '</td><td>' + fx(x.flowRatio, 2) + '</td><td>' + (lastSpec.base ? '<button type="button" class="link" data-replay="' + ij[0] + ',' + ij[1] + ',' + k + '">Replay in Simulate</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>' +
      '<p class="note">The blockage rate treats clogging as a Poisson process in discharged rock (Thomas and Durian 2015); runs that did not block count as exposure. Replay loads this run\'s inputs and seed on the Simulate tab so it can be watched.</p>';
  }

  function replay(i, j, k) {
    const spec = lastSpec, run = lastCells[i][j].runs[k];
    if (!spec.base || !run) return;
    const cfg = FP.config.clone(spec.base), g = spec.grades[i], v = spec.param === 'none' ? null : spec.values[j];
    cfg.grade = FP.config.clone(g); cfg.gradeId = g.id;
    if (v != null) FP.study3d.PARAMS[spec.param].apply(cfg, v);
    if (spec.duration > 0) cfg.run.duration = spec.duration;
    cfg.run.seedMode = 'fixed'; cfg.run.seed = run.seed;
    U.cfg = cfg; U.buildForms(); U.changed(); U.switchTab('sim');
  }

  /* ---------------- benchmark ---------------- */
  function runBench() {
    if (studyOpts || benchOpts) return;
    const jobs = FP.bench3d.jobs(), res = [];
    benchOpts = { cancelled: false, stopOnRed: false };
    $('#benchRun').disabled = true; $('#stRun').disabled = true; $('#benchOut').innerHTML = '';
    const t0 = performance.now();
    FP.study3d.runJobs(jobs, benchOpts, (job, r) => { res.push(r); drawBench(res); }, (f) => { $('#benchProg').textContent = (f * 100).toFixed(0) + '% of ' + jobs.length + ' runs'; })
      .then(() => {
        $('#benchProg').textContent = 'Complete in ' + clock((performance.now() - t0) / 1000) + '.';
        benchOpts = null; $('#benchRun').disabled = false; $('#stRun').disabled = false; drawBench(res);
        try { localStorage.setItem('fallpipe3d.bench.v1', JSON.stringify(res)); } catch (e) { /* ignore */ }
      });
  }
  function drawBench(res) {
    if (!res.length) return;
    const J = FP.bench3d.judge(res);
    const tag = (p) => p == null ? '<span class="tag stw">-</span>' : p ? '<span class="tag st0">PASS</span>' : '<span class="tag st3">FAIL</span>';
    $('#benchOut').innerHTML = '<div class="tbl-wrap"><table class="data"><thead><tr><th>Orifice / sphere D/d</th><th>Runs</th><th>Jammed</th><th>Grains out before jam (median)</th><th>Grains in silo</th><th>Expected</th><th>Result</th></tr></thead><tbody>' +
      J.rows.map(r => '<tr><td>' + r.ratio + '</td><td>' + r.n + '</td><td>' + r.jams + '</td><td>' + (r.medianOut == null ? '-' : r.medianOut) + '</td><td>' + (r.fill == null ? '-' : r.fill) + '</td><td class="wrap">' + esc(r.expect) + '</td><td>' + tag(r.pass) + '</td></tr>').join('') +
      '</tbody></table></div><p class="note">Trend (share of jams falls as D/d grows): ' + tag(J.trend) + '. ' + (res.some(r => r.error) ? 'Errors: ' + esc(res.find(r => r.error).error) : '') + '</p>';
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, td.mcell'); if (!t || !t.closest('#tab-prob')) return;
    if (t.id === 'stRun') runStudy();
    else if (t.id === 'stCancel') { if (studyOpts) { studyOpts.cancelled = true; FP.study3d.cancelAll(); } }
    else if (t.id === 'benchRun') runBench();
    else if (t.dataset.cell) { selCell = t.dataset.cell.split(',').map(Number); drawMatrix(lastSpec, lastCells); }
    else if (t.dataset.replay) { const a = t.dataset.replay.split(',').map(Number); replay(a[0], a[1], a[2]); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'stParam') { $('#stValues').value = ''; render(); }
    if (e.target.id === 'stX' && lastCells && selCell) drawCell(lastSpec, lastCells[selCell[0]][selCell[1]], selCell);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('mcell')) e.target.click(); });

  U.pages = Object.assign(U.pages || {}, { prob: render });
  try { const b = JSON.parse(localStorage.getItem('fallpipe3d.bench.v1') || 'null'); if (b && b.length) setTimeout(() => drawBench(b), 0); } catch (e) { /* ignore */ }
  if ((location.hash || '') === '#prob') setTimeout(render, 0);
  FP.prob3d = { render };
})(self.FP = self.FP || {});
