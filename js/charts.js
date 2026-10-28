/* ==========================================================================
 * charts.js
 * Small canvas charts: line charts with faint grid, status timeline, and an
 * axial profile chart. Colours come from CSS tokens so both themes work.
 * ========================================================================== */
(function (FP) {
  'use strict';
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function prep(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W: r.width, H: r.height };
  }

  function nice(max) {
    if (!(max > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(max))), f = max / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  /** Time label: s below 2 min, m:ss below 2 h, h:mm above. */
  function tfmt(v, span) {
    if (span < 120) return fmt(v);
    if (span < 7200) { const m = Math.floor(v / 60), sec = Math.round(v - m * 60); return m + ':' + (sec < 10 ? '0' : '') + sec; }
    const h = Math.floor(v / 3600), m = Math.round((v - h * 3600) / 60); return h + 'h' + (m < 10 ? '0' : '') + m;
  }
  function tUnit(span) { return span < 120 ? 's' : span < 7200 ? 'min:s' : 'h:min'; }
  function tStepOf(span) {
    if (span < 120) return nice(span / 5);
    const c = [60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600];
    for (const v of c) if (span / v <= 6) return v;
    return 43200;
  }
  /** First index with t >= x (binary search, t ascending). */
  function lowerBound(t, x) { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; }

  /**
   * Line chart for live time series.
   * series: [{ data, color (css var), label }]
   * opts: { t, tStart, tEnd, yMin, yMax, yRef (reference value, e.g. nominal feed), refLabel,
   *         robust (bool: scale to the 98th percentile, clip spikes), unit, big }
   * Long series are decimated to min/max per pixel column so spikes stay visible.
   */
  function line(cv, series, opts) {
    const { ctx, W, H } = prep(cv);
    const ink = css('--ink'), muted = css('--muted'), grid = css('--grid'), mono = css('--font-mono');
    ctx.clearRect(0, 0, W, H);
    const fs = opts.big ? 13 : 10;
    const L = opts.big ? 64 : 42, R = 12, T = opts.big ? 26 : 18, B = opts.big ? 30 : 20;
    const t = opts.t || [];
    const t1 = Math.max(opts.tEnd != null ? opts.tEnd : (t.length ? t[t.length - 1] : 1), 1e-6);
    const t0 = Math.max(0, Math.min(opts.tStart || 0, t1 - 1e-6));
    const i0 = Math.max(0, lowerBound(t, t0) - 1), i1 = t.length;
    // y range
    let yMax = opts.yMax, clipped = false;
    const yMin = opts.yMin || 0;
    if (yMax == null) {
      const vals = [];
      series.forEach(sr => { for (let i = i0; i < i1; i++) { const v = sr.data[i]; if (v != null && isFinite(v)) vals.push(v); } });
      let top = 0;
      if (vals.length) {
        if (opts.robust && vals.length > 20) { vals.sort((a, b) => a - b); top = vals[Math.floor(0.98 * (vals.length - 1))]; clipped = vals[vals.length - 1] > top * 1.3; }
        else top = Math.max.apply(null, vals.length > 50000 ? vals.slice(-50000) : vals);
      }
      if (opts.yRef > 0) top = Math.max(top, opts.yRef * 1.15);
      yMax = nice(top * 1.08 || 1);
    }
    const X = (v) => L + (W - L - R) * (v - t0) / (t1 - t0), Y = (v) => H - B - (H - T - B) * (v - yMin) / (yMax - yMin || 1);
    ctx.font = fs + 'px ' + mono; ctx.fillStyle = muted; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = yMin + (yMax - yMin) * i / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmt(v), L - 4, y);
    }
    const span = t1 - t0, tStep = tStepOf(span);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = Math.ceil(t0 / tStep) * tStep; v <= t1 + 1e-9; v += tStep) ctx.fillText(tfmt(v, span), X(v), H - B + 4);
    ctx.textAlign = 'right'; ctx.fillText(tUnit(span), W - R, H - B + 4 + (opts.big ? 0 : 0) - (fs + 2));
    // series with per-pixel min/max decimation
    ctx.save(); ctx.beginPath(); ctx.rect(L, T - 2, W - L - R, H - T - B + 4); ctx.clip();
    series.forEach(sr => {
      const col = css(sr.color) || sr.color;
      ctx.strokeStyle = col; ctx.lineWidth = opts.big ? 2 : 1.6; ctx.beginPath();
      const cols = Math.max(50, Math.round(W - L - R));
      const decimate = (i1 - i0) > cols * 3;
      let started = false, lx = 0, ly = 0;
      if (!decimate) {
        for (let i = i0; i < i1; i++) {
          const v = sr.data[i];
          if (v == null || !isFinite(v)) { started = false; continue; }
          const x = X(t[i]), y = Y(Math.min(Math.max(v, yMin), yMax * 1.02));
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          lx = x; ly = y;
        }
      } else {
        let c = -1, mn = Infinity, mx = -Infinity, last = null;
        const flush = () => { if (c < 0 || mn === Infinity) return; const x = L + c + 0.5; const a = Y(Math.min(Math.max(mn, yMin), yMax * 1.02)), b = Y(Math.min(Math.max(mx, yMin), yMax * 1.02));
          if (!started) { ctx.moveTo(x, a); started = true; } else ctx.lineTo(x, a); ctx.lineTo(x, b); lx = x; ly = Y(Math.min(Math.max(last, yMin), yMax * 1.02)); };
        for (let i = i0; i < i1; i++) {
          const v = sr.data[i]; if (v == null || !isFinite(v)) continue;
          const cc = Math.floor(X(t[i]) - L);
          if (cc !== c) { flush(); c = cc; mn = Infinity; mx = -Infinity; }
          if (v < mn) mn = v; if (v > mx) mx = v; last = v;
        }
        flush();
      }
      ctx.stroke();
      if (started) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx, ly, opts.big ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill(); }
    });
    ctx.restore();
    // reference line (requested rate)
    if (opts.yRef > 0 && opts.yRef <= yMax) {
      ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = ink; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(L, Y(opts.yRef)); ctx.lineTo(W - R, Y(opts.yRef)); ctx.stroke(); ctx.restore();
      ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(opts.refLabel || 'reference', L + 4, Y(opts.yRef) - 2);
    }
    // legend
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = fs + 'px ' + mono;
    let lx = L;
    series.forEach(sr => {
      const col = css(sr.color) || sr.color;
      ctx.fillStyle = col; ctx.fillRect(lx, fs / 2, 10, 3);
      ctx.fillStyle = ink; ctx.fillText(sr.label, lx + 14, 1);
      lx += 22 + ctx.measureText(sr.label).width;
    });
    if (opts.unit) { ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.fillText(opts.unit + (clipped ? ' (spikes clipped)' : ''), W - R, 1); }
  }

  /** Status level vs time, coloured step band. levels: -1 (warm-up), 0..3 */
  function status(cv, t, levels, tEnd, opts) {
    opts = opts || {};
    const { ctx, W, H } = prep(cv);
    const cols = ['--st-green', '--st-yellow', '--st-orange', '--st-red'].map(css);
    const muted = css('--muted'), grid = css('--grid'), mono = css('--font-mono');
    ctx.clearRect(0, 0, W, H);
    const fs = opts.big ? 13 : 10;
    const L = opts.big ? 64 : 42, R = 12, T = opts.big ? 26 : 18, B = opts.big ? 30 : 20;
    const t1 = Math.max(tEnd || 0, 1e-6), t0 = Math.max(0, Math.min(opts.tStart || 0, t1 - 1e-6));
    const X = (v) => L + (W - L - R) * (v - t0) / (t1 - t0);
    const bandH = H - T - B;
    ctx.fillStyle = grid; ctx.fillRect(L, T, W - L - R, bandH);
    // per pixel column: worst level
    const ncol = Math.max(1, Math.round(W - L - R)), worst = new Int8Array(ncol).fill(-1);
    for (let i = Math.max(0, lowerBound(t, t0) - 1); i < t.length; i++) {
      const lv = levels[i]; if (lv < 0) continue;
      const a = Math.max(0, Math.floor(X(i ? t[i - 1] : 0) - L)), b = Math.min(ncol - 1, Math.floor(X(t[i]) - L));
      for (let c = a; c <= b; c++) if (lv > worst[c]) worst[c] = lv;
    }
    for (let c = 0; c < ncol; c++) { const lv = worst[c]; if (lv < 0) continue; const h = bandH * (lv + 1) / 4; ctx.fillStyle = cols[lv]; ctx.fillRect(L + c, T + bandH - h, 1.2, h); }
    ctx.font = fs + 'px ' + mono; ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ['G', 'Y', 'O', 'R'].forEach((s2, i) => ctx.fillText(s2, L - 4, T + bandH - bandH * (i + 0.5) / 4));
    const span = t1 - t0, tStep = tStepOf(span);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = Math.ceil(t0 / tStep) * tStep; v <= t1 + 1e-9; v += tStep) ctx.fillText(tfmt(v, span), X(v), H - B + 4);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = css('--ink');
    ctx.fillText('Blockage indicator (' + tUnit(span) + ')', L, 1);
  }

  /** Axial profile: bars = value per bin, optional line = second metric, features as ticks. */
  function profile(cv, det, geom, opts) {
    const { ctx, W, H } = prep(cv);
    const ink = css('--ink'), muted = css('--muted'), grid = css('--grid'), mono = css('--font-mono');
    const acc = css('--accent'), warn = css('--st-orange');
    ctx.clearRect(0, 0, W, H);
    const L = 40, R = 10, T = 18, B = 20;
    if (!det) return;
    const s0 = det.s0, s1 = det.s1;
    const X = (s) => L + (W - L - R) * (s - s0) / (s1 - s0);
    let vmax = 0; for (let j = 0; j < det.nb; j++) vmax = Math.max(vmax, det.slowAccum[j]);
    vmax = nice(vmax || 1);
    const Y = (v) => H - B - (H - T - B) * v / vmax;
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.font = '10px ' + mono; ctx.fillStyle = muted;
    for (let i = 0; i <= 4; i++) {
      const v = vmax * i / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(v), L - 4, y);
    }
    // feature ticks
    geom.features.forEach(f => {
      if (f.kind !== 'opening' && f.kind !== 'overlap') return;
      ctx.fillStyle = f.kind === 'overlap' ? acc : muted;
      ctx.globalAlpha = f.kind === 'overlap' ? 0.18 : 0.5;
      if (f.kind === 'overlap') ctx.fillRect(X(f.s), T, X(f.s2) - X(f.s), H - T - B);
      else ctx.fillRect(X(f.s) - 0.5, T, 1, H - T - B);
      ctx.globalAlpha = 1;
    });
    ctx.fillStyle = acc;
    const bw = Math.max(1, X(s0 + det.binLen) - X(s0) - 1);
    for (let j = 0; j < det.nb; j++) {
      const v = det.slowAccum[j]; if (v <= 0) continue;
      ctx.fillRect(X(s0 + j * det.binLen), Y(v), bw, H - B - Y(v));
    }
    // current solid fraction as a line, scaled 0..1 on the same frame
    ctx.strokeStyle = warn; ctx.lineWidth = 1.4; ctx.beginPath();
    for (let j = 0; j < det.nb; j++) {
      const x = X(det.binMid[j]), y = H - B - (H - T - B) * Math.min(1, det.binPhi[j]);
      if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    const sStep = nice((s1 - s0) / 6);
    ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let s = Math.ceil(s0 / sStep) * sStep; s <= s1 + 1e-9; s += sStep) ctx.fillText(fmt(s), X(s), H - B + 4);
    ctx.textAlign = 'left'; ctx.fillStyle = acc; ctx.fillRect(L, 5, 10, 3);
    ctx.fillStyle = ink; ctx.fillText('stalled particle-s per bin', L + 14, 1);
    const w1 = ctx.measureText('stalled particle-s per bin').width;
    ctx.fillStyle = warn; ctx.fillRect(L + 26 + w1, 5, 10, 3);
    ctx.fillStyle = ink; ctx.fillText('solid fraction (0-1)', L + 40 + w1, 1);
    ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('s [m]', W - R, H - B - 2);
    void opts;
  }


  /**
   * Grouped histogram on log-mass bins: number-weighted and mass-weighted fractions.
   * bins: [{lo, hi, fn, fm}]
   */
  function hist(cv, bins, opts) {
    const { ctx, W, H } = prep(cv);
    const ink = css('--ink'), muted = css('--muted'), grid = css('--grid'), mono = css('--font-mono');
    const cN = css('--c-in'), cM = css('--c-out');
    ctx.clearRect(0, 0, W, H);
    const L = 40, R = 10, T = 20, B = 30;
    const vmax = nice(Math.max.apply(null, bins.map(b => Math.max(b.fn, b.fm))) * 1.05);
    const Y = (v) => H - B - (H - T - B) * v / vmax;
    ctx.font = '10px ' + mono; ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const v = vmax * i / 4, y = Y(v); ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(+(v * 100).toFixed(1) + '%', L - 4, y); }
    const n = bins.length, bw = (W - L - R) / n;
    bins.forEach((b, k) => {
      const x = L + k * bw;
      ctx.fillStyle = cN; ctx.fillRect(x + 1, Y(b.fn), bw / 2 - 1.5, H - B - Y(b.fn));
      ctx.fillStyle = cM; ctx.fillRect(x + bw / 2 + 0.5, Y(b.fm), bw / 2 - 1.5, H - B - Y(b.fm));
    });
    ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let k = 0; k <= n; k += Math.max(1, Math.round(n / 6))) {
      const v = k < n ? bins[k].lo : bins[n - 1].hi;
      ctx.fillText(fmt(v), L + k * bw, H - B + 4);
    }
    ctx.textAlign = 'right'; ctx.fillText(opts && opts.xUnit || 'kg (log bins)', W - R, H - 12);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = cN; ctx.fillRect(L, 5, 10, 3); ctx.fillStyle = ink; ctx.fillText('by number', L + 14, 1);
    const w1 = ctx.measureText('by number').width;
    ctx.fillStyle = cM; ctx.fillRect(L + 26 + w1, 5, 10, 3); ctx.fillStyle = ink; ctx.fillText('by mass', L + 40 + w1, 1);
  }

  /**
   * Cumulative curves on a log x axis.
   * curves: [{pts: [{x, y}], color, label, dash}], markers: [{x, lo, hi, label}] (percent ranges)
   */
  function cdf(cv, curves, markers, opts) {
    const { ctx, W, H } = prep(cv);
    const ink = css('--ink'), muted = css('--muted'), grid = css('--grid'), mono = css('--font-mono');
    ctx.clearRect(0, 0, W, H);
    const L = 40, R = 10, T = 20, B = 30;
    let xmin = Infinity, xmax = -Infinity;
    curves.forEach(c => c.pts.forEach(p => { if (p.x > 0) { xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); } }));
    (markers || []).forEach(m => { xmin = Math.min(xmin, m.x); xmax = Math.max(xmax, m.x); });
    if (!isFinite(xmin)) return;
    const lx0 = Math.log10(xmin) - 0.05, lx1 = Math.log10(xmax) + 0.05;
    const X = (x) => L + (W - L - R) * (Math.log10(x) - lx0) / (lx1 - lx0), Y = (y) => H - B - (H - T - B) * y;
    ctx.font = '10px ' + mono; ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const y = Y(i / 4); ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(i * 25 + '%', L - 4, y); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let e = Math.floor(lx0); e <= Math.ceil(lx1); e++) [1, 2, 5].forEach(f => {
      const v = f * Math.pow(10, e); if (Math.log10(v) < lx0 || Math.log10(v) > lx1) return;
      const x = X(v); ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke();
      ctx.fillStyle = muted; ctx.fillText(fmt(v), x, H - B + 4);
    });
    (markers || []).forEach(m => {
      const x = X(m.x);
      ctx.fillStyle = css('--accent'); ctx.globalAlpha = 0.25; ctx.fillRect(x - 3, Y(m.hi / 100), 6, Y(m.lo / 100) - Y(m.hi / 100)); ctx.globalAlpha = 1;
      ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(m.label, x, H - B - 2);
    });
    curves.forEach(c => {
      ctx.strokeStyle = css(c.color) || c.color; ctx.lineWidth = 1.6; ctx.setLineDash(c.dash ? [5, 4] : []);
      ctx.beginPath(); c.pts.forEach((p, i) => { const x = X(p.x), y = Y(p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
    });
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; let lx = L;
    curves.forEach(c => { ctx.fillStyle = css(c.color) || c.color; ctx.fillRect(lx, 5, 10, 3); ctx.fillStyle = ink; ctx.fillText(c.label, lx + 14, 1); lx += 24 + ctx.measureText(c.label).width; });
    ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.fillText(opts && opts.xUnit || 'kg', W - R, H - 12);
  }

  function fmt(v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
    if (a >= 10) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1).replace(/\.0$/, '');
    return v.toFixed(2);
  }

  FP.charts = { line, status, profile, hist, cdf, fmt };
})(self.FP = self.FP || {});
