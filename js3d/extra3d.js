/* ==========================================================================
 * js3d/extra3d.js
 * 3D-only additions to a run summary (shared by the page and the workers):
 * wall impacts per bucket, stone speed and orientation at the water
 * surface, feed and vessel-motion description.
 * ========================================================================== */
(function (FP) {
  'use strict';

  function groupName(g, geom) {
    if (g === -1) return geom && geom.feedTopWidth > geom.inletWidth + 1e-6 ? 'funnel' : 'feed chute';
    if (g === -2) return 'gate';
    const b = geom && geom.buckets && geom.buckets[g];
    return b ? 'S' + b.stack + '.B' + b.idx : (geom && geom.type === 'inclined' ? 'pipe' : 'wall ' + g);
  }

  function attach(sum, eng, geom) {
    const q = FP.stats ? FP.stats.quantile : (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
    sum.hits = eng.hitSummary().map(h => ({ name: groupName(h.group, geom), n: h.n, E: h.E, vMax: h.vMax }));
    const en = eng.entry;
    sum.entry = en.n ? { n: en.n, vMed: q(en.v, 0.5), v90: q(en.v, 0.9), vMax: Math.max.apply(null, en.v), angMed: q(en.ang, 0.5) } : { n: 0 };
    const c = eng.cfg, B = c.feed.belt || {}, V = c.vessel || {};
    sum.feedText = c.feed.source === 'conveyor' ? 'conveyor ' + B.speed + ' m/s at ' + B.dir + ' deg, stream ' + B.width + ' mm, drop ' + B.drop + ' m, spin ' + B.spin : 'drop at rest, v0 ' + (eng.dv.v0 || 0).toFixed(2) + ' m/s';
    sum.vesselText = V.on ? 'roll ' + V.rollAmp + ' deg / ' + V.rollT + ' s, pitch ' + V.pitchAmp + ' deg / ' + V.pitchT + ' s, heave ' + V.heaveAmp + ' m / ' + V.heaveT + ' s, centre ' + V.zRC + ' m above the pipe top' : 'none';
    sum.precision = eng.dv.precision ? eng.dv.precision.name : 'standard';
    return sum;
  }

  function hitsText(hits, geom) {
    if (!hits || !hits.length) return 'none';
    return hits.map(h => (h.name || groupName(h.group, geom)) + ': ' + h.n + ', ' + (h.E / 1000).toFixed(1) + ' kJ, ' + h.vMax.toFixed(1) + ' m/s').join('; ');
  }

  FP.extra3d = { attach, hitsText, groupName };
})(self.FP = self.FP || {});
