/* ==========================================================================
 * js3d/ui3d.js
 * 3D page: state, schema-driven forms, run loop, live view, results and
 * diagnostics. Adapted from the 2D ui.js with the same input schema, so the
 * two pages read the same configuration. The 3D page keeps its own stored
 * configuration and run list ('fallpipe3d.*') and can import the 2D inputs.
 * Grade library is shared with the 2D page.
 * ========================================================================== */
(function (FP) {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fx = (v, d) => (v == null || !isFinite(v)) ? 'n/a' : Number(v).toFixed(d == null ? 2 : d);
  const sci = (v) => (v == null || !isFinite(v)) ? 'n/a' : Number(v).toExponential(2);
  const isB = (c) => c.pipe.type === 'bucket', isI = (c) => c.pipe.type === 'inclined';

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  const KEY_CFG = 'fallpipe3d.cfg.v1', KEY_LIB = 'fallpipe.grades.v2', KEY_CFG2D = 'fallpipe.cfg.v2';
  // own run list for 3D runs (same summary format as 2D)
  const RS = (() => {
    const KEY = 'fallpipe3d.runs.v1';
    const load = () => { try { const v = localStorage.getItem(KEY); return v ? JSON.parse(v) : []; } catch (e) { return []; } };
    const save = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-80).map((r, i, a) => i < a.length - 30 ? Object.assign({}, r, { cfg: null }) : r))); } catch (e) { /* ignore */ } };
    return { runs: load(), add(r) { this.runs.push(r); save(this.runs); }, remove(id) { this.runs = this.runs.filter(r => r.id !== id); save(this.runs); }, clear() { this.runs = []; save(this.runs); } };
  })();

  function deepMerge(base, over) {
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
    const out = {};
    for (const k of Object.keys(base)) out[k] = deepMerge(base[k], over ? over[k] : undefined);
    if (over) for (const k of Object.keys(over)) if (!(k in out)) out[k] = over[k];
    return out;
  }
  function getP(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
  function setP(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] = a[k] || {}), o)[last] = v; }

  /* ---------------- state ---------------- */
  const stored = LS.get(KEY_CFG, null);
  let cfg = stored && stored.version === 2 ? deepMerge(FP.config3d.defaultConfig(), stored) : FP.config3d.defaultConfig();
  if (stored && stored.version === 2) { cfg.grade = stored.grade; cfg.materials = stored.materials; cfg.pipe.string = Object.assign(FP.config.defaultConfig().pipe.string, stored.pipe.string); }
  let library = LS.get(KEY_LIB, null) || FP.grades.fullLibrary();

  const S = { state: 'idle', eng: null, det: null, geom: null, fac: null, dv: null, runCfg: null, pending: false,
    lastFrame: 0, lastChart: 0, simRate: 0, valid: { errors: [], warnings: [] }, summary: null, selectedRun: null, checks: [] };
  let renderer = null;

  const U = FP.ui = {
    $, $$, esc, fx, sci, LS, getP, setP, S,
    get cfg() { return cfg; }, set cfg(v) { cfg = v; },
    get library() { return library; }, set library(v) { library = v; LS.set(KEY_LIB, library); },
    saveLibrary() { LS.set(KEY_LIB, library); },
    changed, prepare, switchTab, buildForms, syncForms, gradeById: (id) => library.find(g => g.id === id)
  };

  /* ---------------- input schema ---------------- */
  const matOpts = () => cfg.materials.map(m => [m.id, m.name]);
  const gradeOpts = () => library.map(g => [g.id, g.name]).concat(library.some(g => g.id === cfg.grade.id) ? [] : [[cfg.grade.id, '(unsaved) ' + cfg.grade.name]]);
  const T1 = 'pipe.string.types.0.';
  const SCHEMA = {
    geom: [
      { k: 'pipe.type', label: 'Fall-pipe type', type: 'select', opts: [['bucket', 'Moonpool bucket fall pipe'], ['inclined', 'Side / inclined fall pipe']] },
      { k: 'pipe.string.nStacks', label: 'Number of stacks', unit: '1-30', type: 'int', show: isB },
      { k: 'pipe.string.bucketsPerStack', label: 'Buckets per stack', unit: '1-19', type: 'int', show: isB },
      { k: T1 + 'dTop', label: 'Bucket top ID (type 1)', unit: 'mm', show: isB },
      { k: T1 + 'dBot', label: 'Bucket bottom ID (type 1)', unit: 'mm', show: isB },
      { k: T1 + 'h', label: 'Bucket length (type 1)', unit: 'mm', show: isB },
      { k: T1 + 'ins', label: 'Insertion into next bucket', unit: 'mm', show: isB, help: 'Axial overlap length of the upper bucket inside the lower one.' },
      { k: T1 + 't', label: 'Wall thickness (type 1)', unit: 'mm', show: isB },
      { k: T1 + 'mat', label: 'Material (type 1)', type: 'select', opts: matOpts, show: isB },
      { k: 'pipe.string.window.auto', label: 'DEM window on the narrowest transition', type: 'check', show: isB },
      { k: 'pipe.string.window.start', label: 'DEM window first bucket', unit: '#', type: 'int', show: c => isB(c) && !c.pipe.string.window.auto },
      { k: 'pipe.string.window.count', label: 'Buckets in DEM window', unit: '#', type: 'int', show: isB },
      { k: '_stringNote', type: 'custom', show: isB },
      { k: 'pipe.inclined.d', label: 'Pipe ID (constant)', unit: 'mm', show: isI },
      { k: 'pipe.inclined.L', label: 'Pipe length', unit: 'mm', show: isI },
      { k: 'pipe.inclined.angle', label: 'Inclination', unit: 'deg', show: isI },
      { k: 'pipe.inclined.angleRef', label: 'Angle measured from', type: 'select', opts: [['vertical', 'Vertical (0 = vertical pipe)'], ['horizontal', 'Horizontal (90 = vertical pipe)']], show: isI },
      { k: 'pipe.inclined.t', label: 'Wall thickness', unit: 'mm', show: isI },
      { k: 'pipe.inclined.mat', label: 'Pipe material', type: 'select', opts: matOpts, show: isI },
      { k: 'pipe.feedLen', label: 'Feed chute length', unit: 'mm', help: 'Straight chute upstream of the DEM window inlet where stones are released.' },
      { k: 'pipe.dryLen', label: 'Pipe top above water', unit: 'm', scale: 1000, show: c => c.physics.fluid, help: 'Vertical height from the pipe top to the outside water surface (in the moonpool for the bucket string, the sea surface beside the vessel for the side pipe). Stones fall in air over this height (full weight, no buoyancy or water drag) and hit the water at speed. Inside the pipe the water surface is free and can be drawn down by the falling rock. 0 = pipe top submerged.' },
      { k: 'pipe.shape.mode', label: 'Pipe shape', type: 'select', opts: [['vertical', 'Vertical (no tilt)'], ['tilt', 'Straight tilt (one angle)'], ['joints', 'Top angle + change per joint'], ['current', 'From current and ROV (static chain)']], show: isB, help: 'The DEM pipe stays straight; gravity is turned by the local pipe angle, so stones drift to the lower wall and slide along it. Angles are from vertical, in the plane of the simulated section (worst case).' },
      { k: 'pipe.shape.tilt', label: 'Pipe angle from vertical (top bucket for joint mode)', unit: 'deg', show: c => isB(c) && (c.pipe.shape.mode === 'tilt' || c.pipe.shape.mode === 'joints') },
      { k: 'pipe.shape.dJoint', label: 'Angle change at each joint', unit: 'deg', show: c => isB(c) && c.pipe.shape.mode === 'joints', help: 'Positive: the string curves further downstream with depth. Negative: it straightens or reverses.' },
      { k: 'pipe.shape.U0', label: 'Current speed at the surface', unit: 'm/s', show: c => isB(c) && c.pipe.shape.mode === 'current' },
      { k: 'pipe.shape.profile', label: 'Current profile', type: 'select', opts: [['power', 'Power law 1/7 (tidal)'], ['uniform', 'Uniform with depth']], show: c => isB(c) && c.pipe.shape.mode === 'current' },
      { k: 'pipe.shape.depth', label: 'Water depth', unit: 'm', show: c => isB(c) && c.pipe.shape.mode === 'current' && c.pipe.shape.profile === 'power' },
      { k: 'pipe.shape.vVessel', label: 'Vessel speed in the current direction', unit: 'm/s', show: c => isB(c) && c.pipe.shape.mode === 'current', help: 'The string moves with the vessel, so it sees the current minus the vessel speed. Negative when steaming against the current.' },
      { k: 'pipe.shape.Cd', label: 'Drag coefficient of the string', unit: '-', show: c => isB(c) && c.pipe.shape.mode === 'current', help: 'ASSUMPTION 1.0. Cylinders at Re about 1e6: about 0.65 smooth to 1.05 rough (DNV-RP-C205); bucket lips and steps raise it.' },
      { k: 'pipe.shape.chainW', label: 'Chains / wires, weight in water', unit: 'kN/m', show: c => isB(c) && c.pipe.shape.mode === 'current', help: 'Load path carrying the string and the ROV. ASSUMPTION 0.5 kN/m.' },
      { k: 'pipe.shape.rov.on', label: 'FP ROV holds the tip position', type: 'check', show: c => isB(c) && c.pipe.shape.mode === 'current' },
      { k: 'pipe.shape.rov.target', label: 'Target tip offset (downstream +)', unit: 'm', show: c => isB(c) && c.pipe.shape.mode === 'current' && c.pipe.shape.rov.on },
      { k: 'pipe.shape.rov.W', label: 'ROV / bottom weight in water', unit: 'kN', show: c => isB(c) && c.pipe.shape.mode === 'current', help: 'ASSUMPTION 200 kN. Replace with the ROV / bottom section data.' },
      { k: 'pipe.shape.rov.A', label: 'ROV frontal area to the current', unit: 'm2', show: c => isB(c) && c.pipe.shape.mode === 'current' },
      { k: 'pipe.shape.rov.Cd', label: 'ROV drag coefficient', unit: '-', show: c => isB(c) && c.pipe.shape.mode === 'current' },
      { k: 'pipe.shape.rov.thrust', label: 'ROV maximum horizontal thrust', unit: 'kN', show: c => isB(c) && c.pipe.shape.mode === 'current' && c.pipe.shape.rov.on },
      { k: 'pipe.shape.topLimit', label: 'Allowed angle in the moonpool', unit: 'deg', show: c => isB(c) && c.pipe.shape.mode !== 'vertical', help: 'Design dependent. 7 deg is the dumping limit stated in patent US8628287 for one design.' },
      { k: '_shapeNote', type: 'custom', show: c => isB(c) && c.pipe.shape.mode !== 'vertical' }
    ],
    rock: [
      { k: 'gradeId', label: 'Rock grade', type: 'select', opts: gradeOpts },
      { k: '_gradeNote', type: 'custom' },
      { k: 'grade.dist.mode', label: 'Size distribution', type: 'select', opts: () => [['empirical', 'Measured masses (bootstrap)'], ['envelope', 'Curve inside the standard envelope'], ['dvalues', 'D-value curve (Dn)']].filter(o => o[0] !== 'empirical' || (cfg.grade.measured && cfg.grade.measured.masses)).filter(o => o[0] !== 'dvalues' || cfg.grade.dvals) },
      { k: 'grade.dist.pos', label: 'Envelope curve', type: 'select', opts: () => [['mem', 'Match Mem midpoint'], ['mid', 'Mid envelope'], ['fine', 'Fine edge'], ['coarse', 'Coarse edge']].filter(o => o[0] !== 'mem' || cfg.grade.Mem), show: c => c.grade.dist.mode === 'envelope' },
      { k: 'grade.dist.interp', label: 'Interpolation between limits', type: 'select', opts: [['rrm', 'Rosin-Rammler (NLL, NUL)'], ['loglinear', 'Log-linear']], show: c => c.grade.dist.mode === 'envelope' && c.grade.kind === 'mass' },
      { k: 'grade.dist.smoothing', label: 'Bootstrap smoothing (0 = exact)', unit: '-', show: c => c.grade.dist.mode === 'empirical' },
      { k: 'grade.rho', label: 'Rock density', unit: 'kg/m3' },
      { k: 'shape.mode', label: 'Stone representation', type: 'select', opts: [['rock', 'Rock shape model (3D sphere clumps)'], ['sphere', 'Spheres (fast)'], ['clump2', 'Legacy 2-sphere clumps'], ['clump3', 'Legacy 3-sphere clumps']] },
      { k: 'shape.shapeModel', label: 'Rock shape model', type: 'select', opts: [['classes', 'Shape classes (blocky, long, flat, bladed, rounded)'], ['lt', 'L/T distribution (ellipsoids, V2)']], show: c => c.shape.mode === 'rock', help: 'Shape classes after Zingg (B/L and T/B ratios, 2/3 limits). Blocky classes use angular block clumps; rounded stones are smooth ellipses.' },
      { k: 'grade.shape.mix.equant', label: 'Blocky / cubic share', unit: '% by number', show: c => c.shape.mode === 'rock' && c.shape.shapeModel !== 'lt' },
      { k: 'grade.shape.mix.prolate', label: 'Long and thin share', unit: '% by number', show: c => c.shape.mode === 'rock' && c.shape.shapeModel !== 'lt', help: 'B/L 0.40-0.67, T/B 0.67-1. L/T up to about 3.5.' },
      { k: 'grade.shape.mix.oblate', label: 'Flat / slab share', unit: '% by number', show: c => c.shape.mode === 'rock' && c.shape.shapeModel !== 'lt' },
      { k: 'grade.shape.mix.bladed', label: 'Flat and elongated (bladed) share', unit: '% by number', show: c => c.shape.mode === 'rock' && c.shape.shapeModel !== 'lt', help: 'Both ratios 0.40-0.67. These carry most of the L/T > 3 stones.' },
      { k: 'grade.shape.mix.rounded', label: 'Rounded / near circular share', unit: '% by number', show: c => c.shape.mode === 'rock' && c.shape.shapeModel !== 'lt', help: 'Ratios 0.75-1, smooth outline (e.g. weathered or recycled stone).' },
      { k: 'grade.shape.vfBlock', label: 'Block volume factor V/(L B T)', unit: '-', show: c => c.shape.mode === 'rock' && c.shape.shapeModel !== 'lt', help: 'Cuboid 1.0, ellipsoid 0.524. Quarry rock commonly 0.5-0.7 (ASSUMPTION 0.6, check against your measured L/B/T and mass).' },
      { k: 'grade.shape.corner', label: 'Corner roundness of blocks', unit: '0.15-1', show: c => c.shape.mode === 'rock' && c.shape.shapeModel !== 'lt', help: 'Corner circle radius / half thickness. 0.15 sharp, 0.3 angular (default), 0.6 sub-rounded, 1 round.' },
      { k: 'grade.shape.LTmean', label: 'L/T mean', unit: '-', show: c => c.shape.mode === 'rock' && c.shape.shapeModel === 'lt' },
      { k: 'grade.shape.LTsd', label: 'L/T standard deviation', unit: '-', show: c => c.shape.mode === 'rock' && c.shape.shapeModel === 'lt' },
      { k: 'grade.shape.LTmin', label: 'L/T minimum', unit: '-', show: c => c.shape.mode === 'rock' && c.shape.shapeModel === 'lt' },
      { k: 'grade.shape.LTmax', label: 'L/T maximum', unit: '-', show: c => c.shape.mode === 'rock' && c.shape.shapeModel === 'lt' },
      { k: 'grade.shape.phi', label: 'Intermediate axis B = T (L/T)^phi', unit: 'phi', show: c => c.shape.mode === 'rock' && c.shape.shapeModel === 'lt' },
      { k: 'grade.shape.irregular', label: 'Irregularity (angularity proxy)', unit: '0-0.4', show: c => c.shape.mode === 'rock' },
      { k: 'shape.useMeasured', label: 'Use measured shape records of the grade', type: 'check', show: c => c.shape.mode === 'rock' && !!(c.grade.shape && c.grade.shape.measuredSub) },
      { k: 'shape.capL', label: 'Cap length at the grade table Lmax/Dn', type: 'check', show: c => c.shape.mode === 'rock' && !!c.grade.LmaxRatio },
      { k: 'shape.elong', label: 'Legacy clump L/d', unit: '-', show: c => c.shape.mode === 'clump2' || c.shape.mode === 'clump3' },
      { k: 'shape.dnPerD', label: 'Sieve size to Dn ratio (fallback)', unit: 'Dn/D', show: c => c.grade.kind === 'sieve' && !FP.grades.dnPerD(c.grade), help: 'Only for sieve grades without class-table data. Default is the average of the class table.' },
      { k: 'shape.uniform', label: 'Identical stones at M50 (deliberate simplification)', type: 'check' }
    ],
    feed: [
      { k: 'feed.mode', label: 'Feed', type: 'select', opts: [['mass', 'Metered mass flow [t/h]'], ['hopper', 'Gravity-fed full hopper (choke flow)'], ['count', 'Stone rate [1/s]']] },
      { k: 'feed.source', label: 'Rock arrives from', type: 'select', opts: [['drop', 'Drop at rest in the feed zone (falls straight)'], ['conveyor', 'Conveyor discharge (belt speed, stream, spin)']], help: 'Drop: stones start at a random point in the feed opening moving straight down at v0, so they hardly touch the walls in the moonpool. Conveyor: stones leave the head pulley with the belt speed, a stream width and forward spin, and hit the funnel or bucket wall on the far side, as in operation.' },
      { k: 'feed.belt.speed', label: 'Belt speed', unit: 'm/s', show: c => c.feed.source === 'conveyor', help: 'Horizontal speed of the rock leaving the head pulley. Typical rock conveyors 2 to 4 m/s.' },
      { k: 'feed.belt.dir', label: 'Belt direction in the pipe section', unit: 'deg', show: c => c.feed.source === 'conveyor', help: '0 = towards +x (the tilt plane, away from the side gravity pulls to). 90 = across the tilt plane. 180 = towards the lower side of a tilted pipe.' },
      { k: 'feed.belt.drop', label: 'Drop from head pulley to release level', unit: 'm', show: c => c.feed.source === 'conveyor' },
      { k: 'feed.belt.width', label: 'Stream width across the belt', unit: 'mm', show: c => c.feed.source === 'conveyor' },
      { k: 'feed.belt.scatter', label: 'Release velocity scatter', unit: '0-0.5', show: c => c.feed.source === 'conveyor', help: 'Relative standard deviation of the release speed and its direction in radians.' },
      { k: 'feed.belt.spin', label: 'Forward spin (share of v / r)', unit: '0-1', show: c => c.feed.source === 'conveyor', help: '1 = rolling off the pulley without slip. ASSUMPTION 0.5.' },
      { k: 'feed.massFlow', label: 'Mass flow (nominal, full pipe)', unit: 't/h', show: c => c.feed.mode !== 'count', help: 'Hopper mode: reference rate only; the hopper is kept full and the pipe takes what it can.' },
      { k: 'pipe.funnel.on', label: 'Funnel / hopper above the pipe top', type: 'check' },
      { k: 'pipe.funnel.topWidth', label: 'Funnel top width', unit: 'mm', show: c => c.pipe.funnel && c.pipe.funnel.on },
      { k: 'feed.fillZone', label: 'Release zone (share of feed length)', unit: '0-1' },
      { k: 'feed.prefill', label: 'Restart: window full of settled rock at t = 0', type: 'check' },
      { k: 'feed.settle', label: 'Settling time before restart', unit: 's', show: c => c.feed.prefill },
      { k: 'feed.partRate', label: 'Stone rate', unit: '1/s', show: c => c.feed.mode === 'count' },
      { k: 'feed.maxStones', label: 'Stop feed after N stones (0 = continuous)', unit: '-', type: 'int' },
      { k: 'feed.v0Mode', label: 'Inlet velocity', type: 'select', opts: [['input', 'Input value'], ['terminal', 'Terminal velocity of Dn50']], show: c => c.feed.source !== 'conveyor' },
      { k: 'feed.v0', label: 'Stone velocity at the feed release', unit: 'm/s', show: c => c.feed.v0Mode === 'input' && c.feed.source !== 'conveyor', help: 'Velocity of the stones where they are released in the feed chute above the DEM window (off the conveyor / hopper). If the window starts at the pipe top, the fall through the dry moonpool part is simulated. If the window starts deeper, enter the velocity the stones have on arrival there.' },
      { k: 'feed.opening', label: 'Feed opening width', unit: 'mm', show: c => c.feed.source !== 'conveyor' },
      { k: 'feed.offset', label: 'Feed (or stream) centre offset from axis', unit: 'mm', help: 'Along x, the tilt direction: negative towards the side gravity pulls to (lower wall) when the pipe is tilted.' },
      { k: 'run.durUnit', label: 'Duration unit', type: 'select', opts: [['s', 'seconds'], ['min', 'minutes'], ['h', 'hours']] },
      { k: 'run.duration', label: 'Dumping duration', unit: c => (c.run.durUnit || 's'), scale: c => ({ s: 1, min: 60, h: 3600 })[c.run.durUnit || 's'], help: 'Simulated dumping time. Long runs (minutes to hours) take proportionally long in real time at 1x; use a faster speed setting.' },
      { k: 'run.seedMode', label: 'Stone sequence', type: 'select', opts: [['random', 'New random sequence every run'], ['fixed', 'Fixed seed (repeat a run exactly)']], help: 'Random: every Start or Run again draws a new seed, so the stone order, sizes, shapes and orientations differ. The seed used is stored with the run so it can be repeated.' },
      { k: 'run.seed', label: 'Seed', unit: '-', type: 'int', show: c => c.run.seedMode === 'fixed' }
    ],
    vessel: [
      { k: 'vessel.on', label: 'Vessel motion (regular roll, pitch, heave)', type: 'check', help: 'Applied as apparent gravity in the pipe frame: gravity turned by the roll and pitch angles, plus the acceleration of the pipe at its depth below the roll centre, plus heave acceleration. The string is taken to move rigidly with the vessel; its own dynamic response is not modelled.' },
      { k: 'vessel.rollAmp', label: 'Roll amplitude', unit: 'deg', show: c => c.vessel.on, help: 'Roll tilts the pipe in the x direction (tilt plane).' },
      { k: 'vessel.rollT', label: 'Roll period', unit: 's', show: c => c.vessel.on },
      { k: 'vessel.pitchAmp', label: 'Pitch amplitude', unit: 'deg', show: c => c.vessel.on, help: 'Pitch tilts the pipe in the y direction.' },
      { k: 'vessel.pitchT', label: 'Pitch period', unit: 's', show: c => c.vessel.on },
      { k: 'vessel.heaveAmp', label: 'Heave amplitude', unit: 'm', show: c => c.vessel.on },
      { k: 'vessel.heaveT', label: 'Heave period', unit: 's', show: c => c.vessel.on },
      { k: 'vessel.zRC', label: 'Roll / pitch centre above the pipe top', unit: 'm', show: c => c.vessel.on, help: 'Vertical distance from the centre of rotation (near the waterline / centre of gravity) down to the top of the pipe. Sets the lateral acceleration of the pipe at depth.' },
      { k: '_vesselNote', type: 'custom', show: c => c.vessel.on }
    ],
    phys: [
      { k: 'physics.precision', label: 'Numerical precision', type: 'select', opts: [['standard', 'Standard (inputs below as entered)'], ['high', 'High: overlap 1 %, dt 0.10 t_c'], ['veryhigh', 'Very high: overlap 0.5 %, dt 0.07 t_c, stiffness for water entry speed']], help: 'Stiffer contacts and smaller time steps reduce artificial overlap and softness. High takes about 3x the run time of Standard, Very high about 10x. The values used are listed under Derived values.' },
      { k: 'physics.g', label: 'Gravity', unit: 'm/s2' },
      { k: 'physics.muPP', label: 'Friction rock-rock', unit: '-' },
      { k: 'physics.ePP', label: 'Restitution rock-rock', unit: '-' },
      { k: 'physics.muRollPP', label: 'Rolling resistance rock-rock', unit: '-' },
      { k: 'physics.wallContactFrom', label: 'Rock-wall contact values from', type: 'select', opts: [['material', 'Wall material'], ['global', 'Global values below']] },
      { k: 'physics.muPW', label: 'Friction rock-wall (global)', unit: '-', show: c => c.physics.wallContactFrom === 'global' },
      { k: 'physics.ePW', label: 'Restitution rock-wall (global)', unit: '-', show: c => c.physics.wallContactFrom === 'global' },
      { k: 'physics.muRollPW', label: 'Rolling resistance rock-wall (global)', unit: '-', show: c => c.physics.wallContactFrom === 'global' },
      { k: 'physics.wallStiffMode', label: 'Wall contact stiffness', type: 'select', opts: [['material', 'Scaled by E* (material)'], ['same', 'Same as rock-rock']] },
      { k: 'physics.Erock', label: 'Rock elastic modulus', unit: 'GPa', scale: 1e9 },
      { k: 'physics.nuRock', label: 'Rock Poisson ratio', unit: '-' },
      { k: 'physics.kRatioMin', label: 'Wall stiffness ratio, lower clip', unit: '-', show: c => c.physics.wallStiffMode === 'material' },
      { k: 'physics.kRatioMax', label: 'Wall stiffness ratio, upper clip', unit: '-', show: c => c.physics.wallStiffMode === 'material' },
      { k: 'physics.ktRatio', label: 'Tangential / normal stiffness', unit: 'kt/kn' },
      { k: 'physics.kMode', label: 'Normal stiffness', type: 'select', opts: [['auto', 'From target overlap'], ['manual', 'Manual kn']] },
      { k: 'physics.overlapPct', label: 'Target overlap at vChar', unit: '% Dn50', show: c => c.physics.kMode === 'auto' },
      { k: 'physics.vChar', label: 'Characteristic impact velocity', unit: 'm/s', show: c => c.physics.kMode === 'auto' },
      { k: 'physics.kMassRef', label: 'Reference stone mass', type: 'select', opts: [['M90', 'M90 (heavy stones)'], ['M50', 'M50']], show: c => c.physics.kMode === 'auto' },
      { k: 'physics.kn', label: 'kn at Dn50 pair', unit: 'N/m', show: c => c.physics.kMode === 'manual' },
      { k: 'physics.dtMode', label: 'Time step', type: 'select', opts: [['auto', 'Fraction of contact time'], ['manual', 'Manual']] },
      { k: 'physics.tcFactor', label: 'dt / t_contact', unit: '-', show: c => c.physics.dtMode === 'auto' },
      { k: 'physics.dt', label: 'Time step', unit: 's', show: c => c.physics.dtMode === 'manual' },
      { k: 'physics.capFactor', label: 'Body capacity factor', unit: '-' }
    ],
    water: [
      { k: 'physics.fluid', label: 'Submerged pipe (water inside and outside)', type: 'check' },
      { k: 'water.model', label: 'Water in the pipe', type: 'select', opts: [['coupled', 'Coupled: rock drives the water column'], ['still', 'Still water (no induced flow)']], show: c => c.physics.fluid },
      { k: 'physics.rhoF', label: 'Water density', unit: 'kg/m3', show: c => c.physics.fluid },
      { k: 'water.mu', label: 'Water dynamic viscosity', unit: 'Pa s', show: c => c.physics.fluid },
      { k: 'physics.cd', label: 'Stone drag coefficient', unit: '-', show: c => c.physics.fluid },
      { k: 'water.Ca', label: 'Added-mass coefficient', unit: '-', show: c => c.physics.fluid },
      { k: 'water.hindered', label: 'Hindered drag in dense flow (Di Felice)', type: 'check', show: c => c.physics.fluid },
      { k: 'water.Kin', label: 'Entrance loss at the top inlet', unit: 'K', show: c => c.physics.fluid && c.water.model === 'coupled' },
      { k: 'water.frictionMode', label: 'Wall friction factor', type: 'select', opts: [['haaland', 'Haaland, from material roughness'], ['fixed', 'Fixed value']], show: c => c.physics.fluid && c.water.model === 'coupled' },
      { k: 'water.fDarcy', label: 'Darcy friction factor', unit: '-', show: c => c.physics.fluid && c.water.model === 'coupled' && c.water.frictionMode === 'fixed' },
      { k: 'water.leakage', label: 'Water exchange through bucket joint gaps', type: 'check', show: c => c.physics.fluid && c.water.model === 'coupled' && c.pipe.type === 'bucket' },
      { k: 'water.CdGap', label: 'Gap discharge coefficient', unit: '-', show: c => c.physics.fluid && c.water.model === 'coupled' && c.water.leakage && c.pipe.type === 'bucket' },
      { k: 'water.tSmooth', label: 'Smoothing of rock loading on water', unit: 's', show: c => c.physics.fluid && c.water.model === 'coupled' }
    ],
    det: [
      { k: 'detect.sampleDt', label: 'Sampling interval', unit: 's' },
      { k: 'detect.window', label: 'Flow-rate window (min.)', unit: 's', help: 'Extended automatically to hold about 10 stones at the nominal rate.' },
      { k: 'detect.warmupMode', label: 'Detection warm-up', type: 'select', opts: [['auto', 'Auto: first outlet arrival + window'], ['manual', 'Manual']] },
      { k: 'detect.warmup', label: 'Warm-up time', unit: 's', show: c => c.detect.warmupMode === 'manual' },
      { k: 'detect.rRestrict', label: 'Restricted below outlet/inlet', unit: '-' },
      { k: 'detect.rBlock', label: 'Blocked at outlet/nominal', unit: '-' },
      { k: 'detect.vStall', label: 'Stalled stone speed', unit: 'm/s' },
      { k: 'detect.phiJam', label: 'Dense solid fraction (volume)', unit: '-', help: '3D volume fraction of rock in an axial bin. The 2D page uses the in-plane area fraction (default 0.5); dense random rock packing is about 0.55 to 0.6 by volume.' },
      { k: 'detect.tPersist', label: 'Bridge persistence time', unit: 's' },
      { k: 'detect.breakTol', label: 'Bridge break tolerance', unit: 's' },
      { k: 'detect.tMinBridge', label: 'Minimum bridge duration counted', unit: 's' },
      { k: 'detect.binLen', label: 'Axial bin length', unit: 'mm' },
      { k: 'detect.restrictedFrac', label: 'Restricted run if YELLOW+ share above', unit: '-' },
      { k: 'checks.packing', label: 'Bulk packing for empirical checks', unit: '-' },
      { k: 'checks.bevK', label: 'Beverloo k', unit: '-' },
      { k: 'checks.bevC', label: 'Beverloo C', unit: '-' },
      { k: 'checks.rzBeta', label: 'Richardson-Zaki exponent', unit: '-' },
      { k: 'checks.tdC', label: 'Thomas & Durian C', unit: '-' },
      { k: 'checks.tdAlpha', label: 'Thomas & Durian alpha', unit: '-' }
    ]
  };

  function fieldHTML(f) {
    const id = 'in-' + f.k.replace(/\./g, '-');
    if (f.type === 'custom') return '<div class="custom" data-custom="' + f.k + '"></div>';
    let v = getP(cfg, f.k);
    const scale = typeof f.scale === 'function' ? f.scale(cfg) : f.scale;
    const unit = typeof f.unit === 'function' ? f.unit(cfg) : f.unit;
    if (scale && typeof v === 'number') v = +(v / scale).toPrecision(6);
    let ctl;
    if (f.type === 'select') {
      const opts = typeof f.opts === 'function' ? f.opts() : f.opts;
      ctl = '<select id="' + id + '" data-k="' + f.k + '">' + opts.map(o => '<option value="' + esc(o[0]) + '"' + (o[0] === v ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>';
    } else if (f.type === 'check') return '<label class="row check" data-row="' + f.k + '"><input type="checkbox" id="' + id + '" data-k="' + f.k + '"' + (v ? ' checked' : '') + '><span>' + esc(f.label) + '</span></label>';
    else if (f.type === 'text') ctl = '<input type="text" id="' + id + '" data-k="' + f.k + '" value="' + esc(v) + '">';
    else ctl = '<input type="number" step="any" inputmode="decimal" id="' + id + '" data-k="' + f.k + '" data-t="' + (f.type || 'num') + '"' + (scale ? ' data-scale="' + scale + '"' : '') + ' value="' + (v == null ? '' : v) + '">';
    return '<label class="row" data-row="' + f.k + '"' + (f.help ? ' title="' + esc(f.help) + '"' : '') + '><span class="lab">' + esc(f.label) + '</span><span class="ctl">' + ctl + (unit ? '<em class="unit">' + esc(unit) + '</em>' : '') + '</span></label>';
  }

  function normShape() {
    const sh = cfg.grade.shape = cfg.grade.shape || {};
    const d = FP.grades.defaultShape();
    Object.keys(d).forEach(k => { if (sh[k] === undefined) sh[k] = FP.config.clone(d[k]); });
    if (sh.classLTmax === null && sh.measuredSub && sh.LTmax) sh.classLTmax = sh.LTmax;
    sh.mix = Object.assign({}, d.mix, sh.mix || {});
  }
  function buildForms() {
    normShape();
    Object.keys(SCHEMA).forEach(g => { const el = $('#grp-' + g); if (el) el.innerHTML = SCHEMA[g].map(fieldHTML).join(''); });
    renderCustom(); applyVisibility();
    if (U.syncDur) U.syncDur();
  }
  function syncForms() { buildForms(); }
  function applyVisibility() {
    Object.values(SCHEMA).flat().forEach(f => {
      if (!f.show) return;
      const el = f.type === 'custom' ? $('[data-custom="' + f.k + '"]') : $('[data-row="' + f.k + '"]');
      if (el) el.hidden = !f.show(cfg);
    });
  }

  function renderShapeNote(geom) {
    const el = $('[data-custom="_shapeNote"]'); if (!el) return;
    const sh = geom && geom.shape;
    if (!sh || sh.mode === 'vertical') { el.innerHTML = ''; return; }
    const lim = cfg.pipe.shape.topLimit, jOver = sh.joints.filter(j => j.over);
    const rows = [['Top / bottom angle', fx(sh.topAngle, 1) + ' / ' + fx(sh.bottomAngle, 1) + ' deg'], ['Tip offset / max bow', fx(sh.offset, 2) + ' / ' + fx(sh.maxBow, 2) + ' m']];
    if (sh.mode === 'current' && !sh.slack) {
      rows.push(['Drag on string / on ROV', fx(sh.dragPipe / 1000, 1) + ' / ' + fx(sh.Fd / 1000, 1) + ' kN']);
      if (sh.rovOn) rows.push(['ROV thrust needed', fx(Math.abs(sh.thrust) / 1000, 1) + ' of ' + fx(sh.thrustMax / 1000, 0) + ' kN' + (sh.held ? '' : ' (limit)')]);
      rows.push(['Top tension', fx(sh.Ttop / 1000, 0) + ' kN']);
    }
    const msgs = sh.warnings.slice();
    if (Math.abs(sh.topAngle) > lim) msgs.push('Top angle ' + fx(Math.abs(sh.topAngle), 1) + ' deg exceeds the allowed ' + lim + ' deg in the moonpool.');
    if (jOver.length) msgs.push(jOver.length + ' joint(s) above their geometric tilt limit (lip touching the lower bucket).');
    el.innerHTML = '<dl class="kv">' + rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>' +
      msgs.map(m => '<p class="msg warn">' + esc(m) + '</p>').join('') +
      '<p class="note">The DEM pipe stays straight; gravity is turned by the local angle (arrow in the view).</p>';
  }

  function renderVesselNote() {
    const el = $('[data-custom="_vesselNote"]'); if (!el || !cfg.vessel || !cfg.vessel.on) return;
    const V = cfg.vessel, g = cfg.physics.g, w = 2 * Math.PI / Math.max(1, V.rollT);
    const zEq = g / (w * w);
    el.innerHTML = '<p class="note">At ' + fx(zEq, 1) + ' m below the roll centre the roll acceleration of the pipe cancels the tilt of gravity; deeper, the pipe swings faster than gravity turns and stones are pushed to the opposite side. Heave changes apparent gravity by up to ' + fx(V.heaveAmp * Math.pow(2 * Math.PI / Math.max(1, V.heaveT), 2) / g * 100, 0) + ' %.</p>';
  }
  function renderCustom() {
    renderVesselNote();
    const so = $('[data-custom="_shapeOnlyBucket"]');
    if (so) so.innerHTML = '<p class="note">For the side / inclined pipe, set the angle under Geometry.</p>';
    const sn = $('[data-custom="_stringNote"]');
    if (sn) {
      const S2 = cfg.pipe.string;
      const nT = S2.types.length, nO = Object.keys(S2.overrides || {}).length, nSo = (S2.stacks || []).filter(x => x && (x.n || x.type)).length;
      sn.innerHTML = '<p class="note">' + (nT > 1 || nO || nSo ? 'String has ' + nT + ' bucket type(s), ' + nSo + ' stack override(s), ' + nO + ' bucket override(s). ' : '') +
        'Stack and bucket overrides and materials are edited on the 2D page; use <b>Load inputs from the 2D page</b> below the inputs to bring them here.</p>';
    }
    const gn = $('[data-custom="_gradeNote"]');
    if (gn) {
      const g = cfg.grade, inLib = library.find(x => x.id === g.id);
      const dirty = inLib && JSON.stringify(inLib) !== JSON.stringify(g);
      gn.innerHTML = '<p class="note">' + esc(g.family) + ', ' + esc(g.revision || '') + (g.measured ? ', ' + g.measured.masses.length + ' measured stones' : '') +
        (dirty ? ' <b class="warnc">edited, not saved</b>' : '') + '. Grade data and imports: 2D page (shared library).</p>' +
        '<div class="btnrow"><button type="button" class="btn sm" id="gradeSave">Save grade to library</button>' + (dirty ? '<button type="button" class="btn sm ghost" id="gradeRevert">Revert</button>' : '') + '</div>';
    }
  }

  function onInput(e) {
    const el = e.target;
    const k = el.dataset.k; if (!k) return;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.tagName === 'SELECT' || el.type === 'text') v = el.value;
    else {
      v = el.dataset.t === 'int' ? parseInt(el.value, 10) : parseFloat(el.value);
      if (!isFinite(v)) { el.classList.add('bad'); return; }
      if (el.dataset.scale) v *= parseFloat(el.dataset.scale);
    }
    el.classList.remove('bad');
    if (k === 'gradeId') {
      const g = library.find(x => x.id === v);
      if (g) { cfg.grade = FP.config.clone(g); cfg.gradeId = g.id; }
      buildForms(); changed(); return;
    }
    setP(cfg, k, v);
    if (k === 'run.duration' && U.syncDur) U.syncDur();
    if (el.tagName === 'SELECT' || el.type === 'checkbox') { buildForms(); }
    else { renderCustom(); applyVisibility(); }
    changed();
  }

  /* ---------------- change pipeline ---------------- */
  let changeTimer = 0;
  function changed() {
    LS.set(KEY_CFG, cfg);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { changeTimer = 0; prepare(); }, 150);
  }
  /** Apply a pending input change immediately (before Start / Step / Reset). */
  function flushChanges() { if (changeTimer) { clearTimeout(changeTimer); changeTimer = 0; if (S.state !== 'running' && S.state !== 'paused') prepare(); else { S.state = 'idle'; prepare(); } } }

  function prepare() {
    const v = FP.units.validate(cfg);
    S.valid = v;
    let geom = null, fac = null, dv = null;
    if (!v.errors.length) {
      try {
        geom = FP.geometry3d.build(cfg); fac = FP.particles3d.factory(cfg.grade, cfg); dv = FP.config3d.derive(cfg, geom, fac);
        v.warnings = v.warnings.concat(FP.units.numericalChecks(cfg, dv, geom, fac));
        S.checks = FP.checks.run(cfg, geom, fac, dv).map(c => /Janda/.test(c.name) ? Object.assign({}, c, { note: 'Dense granular flow in narrow vertical pipes (3D experiments); faster discharge reduced clogging. This page is a 3D model, so domes with many stones can form; the result still depends on the contact and shape assumptions and is not calibrated against these experiments.' }) : c);
      } catch (err) { v.errors.push('Could not build model: ' + err.message); console.error(err); }
    }
    S.prepGeom = geom; S.prepFac = fac; S.prepDv = dv;
    renderShapeNote(geom);
    renderChecks(v); renderAnalytic(); renderDerived(dv, geom, fac);
    if (S.state === 'running' || S.state === 'paused') { S.pending = true; showPending(); }
    else if (!v.errors.length && geom) newRun(geom, fac, dv, false);
    else { S.eng = null; S.det = null; }
    updateButtons();
    if (U.onPrepared) U.onPrepared();
  }

  function renderChecks(v) {
    const el = $('#checks');
    if (!v.errors.length && !v.warnings.length) { el.innerHTML = '<p class="ok">Inputs pass all unit and consistency checks.</p>'; return; }
    el.innerHTML = v.errors.map(m => '<p class="msg err"><b>Error</b> ' + esc(m) + '</p>').join('') + v.warnings.map(m => '<p class="msg warn"><b>Check</b> ' + esc(m) + '</p>').join('');
  }

  const TAGS = { analytical: 'Analytical', empirical: 'Empirical', assumption: 'Assumption' };
  function renderAnalytic() {
    const el = $('#analytic'); if (!el) return;
    if (!S.checks || !S.checks.length || S.valid.errors.length) { el.innerHTML = '<p class="note">Available once inputs are valid.</p>'; return; }
    el.innerHTML = '<p class="note">Separate from the DEM. Empirical items are indicative only and were fitted to different systems.</p>' +
      S.checks.map(c => '<div class="chk' + (c.level ? ' lv' + c.level : '') + '"><span class="ctag t-' + c.tag + '">' + TAGS[c.tag] + '</span><b>' + esc(c.name) + '</b><span class="cval">' + esc(c.value) + '</span>' + (c.note ? '<span class="cnote">' + esc(c.note) + '</span>' : '') + '</div>').join('');
  }

  function renderDerived(dv, geom, fac) {
    const el = $('#derived');
    if (!dv) { el.innerHTML = '<p class="note">Fix the errors above to compute derived values.</p>'; return; }
    const st = fac.stats;
    const rows = [
      ['DEM window length', fx(geom.L, 2) + ' m' + (geom.window ? ' (buckets ' + geom.window.start + ' to ' + geom.window.end + ', from ' + fx(geom.s0Global, 2) + ' m)' : '')],
      ['Narrowest passage in window', fx(geom.minPassage * 1000, 0) + ' mm'],
      ['Generated Dn10 / Dn50 / Dn90 (by mass)', fx(st.Dn10 * 1000, 0) + ' / ' + fx(st.Dn50 * 1000, 0) + ' / ' + fx(st.Dn90 * 1000, 0) + ' mm'],
      ['Generated M50 (by mass) / mean mass', fx(st.M50, 1) + ' / ' + fx(st.meanMass, 1) + ' kg'],
      ['Mass rate / stone rate (full pipe)', fx(dv.massRateSlice, 1) + ' kg/s / ' + fx(dv.partRate, 2) + ' 1/s'],
      ['Numerical precision', ({ standard: 'Standard', high: 'High', veryhigh: 'Very high' })[dv.precision.name] + ': overlap ' + fx(dv.precision.overlapPct, 2) + ' % Dn50 at ' + fx(dv.precision.vChar, 1) + ' m/s, dt ' + fx(dv.precision.tcFactor, 2) + ' t_c'],
      ['Spheres per stone (mean) / largest sphere', fx(st.meanSubs, 1) + ' / ' + fx(fac.maxSubR * 1000, 0) + ' mm radius'],
      ['Block body exponent p (volume factor)', fx(fac.pBlock, 2) + ' (' + fx(FP.shapes3d.vfOfP(fac.pBlock), 3) + ' L B T)'],
      ['Sphere fill vs stone surface', 'all spheres inside the body; gap mean ' + fx(st.fitErrMean * 100, 0) + ' %, max ' + fx(st.fitErrMax * 100, 0) + ' % of T/2'],
      ['Domain volume (feed + window + exit)', fx(geom.volume, 2) + ' m3'],
      ['Inlet velocity', fx(dv.v0, 2) + ' m/s'],
      ['Terminal velocity Dn50 (still water)', isFinite(dv.vTerm50) ? fx(dv.vTerm50, 2) + ' m/s' : 'no fluid'],
      ['kn (Dn50 pair) / reference mass', sci(dv.kn) + ' N/m / ' + fx(dv.mRef, 0) + ' kg'],
      ['Wall stiffness ratios (E*)', dv.wallProps.map((w, i) => geom.mats[i] + ' ' + fx(w.kRatio, 2) + (w.kRatio !== w.kRatioRaw ? ' (raw ' + fx(w.kRatioRaw, 3) + ')' : '')).join(', ')],
      ['Shortest contact time', sci(dv.tc) + ' s'],
      ['Time step', sci(dv.dt) + ' s (' + fx(dv.dtOverTc, 3) + ' t_c)'],
      ['Body capacity', dv.cap + ' stones'],
      ['Detection warm-up (upper bound)', fx(dv.warmup, 1) + ' s'],
      ['Stones and shapes', fac.describe]
    ];
    el.innerHTML = '<dl class="kv">' + rows.map(r => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>';
  }

  /* ---------------- run control ---------------- */
  function newRun(geom, fac, dv, refit) {
    const runCfg = FP.config.clone(cfg);
    if (runCfg.run.seedMode !== 'fixed') {
      let sd;
      try { const u = new Uint32Array(1); crypto.getRandomValues(u); sd = u[0] % 2147483646 + 1; } catch (e) { sd = Math.floor(Math.random() * 2147483646) + 1; }
      runCfg.run.seed = sd;
    }
    S.runCfg = runCfg; S.geom = geom; S.fac = fac; S.dv = dv;
    S.eng = new FP.physics3d.Engine(runCfg, geom, fac, dv);
    S.det = new FP.detection3d.Detector(runCfg, geom, S.eng, dv);
    S.state = 'idle'; S.pending = false; S.summary = null;
    const geoKey = JSON.stringify([runCfg.pipe]);
    renderer.setGeometry(geom, refit || geoKey !== S.lastGeoKey, dv.cap);
    renderer.setRanges(fac);
    S.lastGeoKey = geoKey;
    showPending(); renderLegend(); drawAll(true); updateButtons();
  }

  function reset() {
    if (S.valid.errors.length) { prepare(); return; }
    S.state = 'idle'; S.pending = false;
    const geom = FP.geometry3d.build(cfg), fac = FP.particles3d.factory(cfg.grade, cfg), dv = FP.config3d.derive(cfg, geom, fac);
    newRun(geom, fac, dv, false);
  }
  function start() {
    if (S.state !== 'running' && S.state !== 'paused') flushChanges();
    if (!S.eng || S.valid.errors.length) return;
    if (S.state === 'done' || S.pending) reset();
    S.state = 'running'; S.lastFrame = performance.now(); updateButtons(); bgStart();
  }
  function pause() { if (S.state === 'running') { S.state = 'paused'; updateButtons(); drawAll(true); } }
  function resume() { if (S.state === 'paused') { S.state = 'running'; S.lastFrame = performance.now(); updateButtons(); bgStart(); } }
  function stopNow() { if (S.state === 'running' || S.state === 'paused') finish(); }
  function stepOnce() {
    if (!S.eng || S.state === 'running' || S.state === 'done') return;
    if (S.pending) reset();
    const target = S.eng.t + S.runCfg.detect.sampleDt;
    while (S.eng.t < target - 1e-12 && S.eng.t < S.runCfg.run.duration) { S.eng.step(); S.det.maybeSample(); }
    if (S.state === 'idle') S.state = 'paused';
    if (S.eng.t >= S.runCfg.run.duration) finish();
    updateButtons(); drawAll(true);
  }
  function finish() {
    S.state = 'done';
    const fin = S.det.finalize();
    S.summary = FP.results.summarize(S.runCfg, S.geom, S.dv, S.eng, S.det, fin, S.fac);
    S.summary.pipeType = '3D: ' + S.summary.pipeType; S.summary.dim = 3;
    FP.extra3d.attach(S.summary, S.eng, S.geom);
    RS.add(S.summary);
    S.selectedRun = S.summary.id;
    renderResults(); renderDiag();
    updateButtons(); drawAll(true);
  }

  /** Advance the running simulation by the real time since the last call (budget in ms of compute). */
  function advance(now, budget, maxReal) {
    if (S.state !== 'running' || !S.eng) return false;
    const real = Math.min(maxReal, Math.max(0, (now - S.lastFrame) / 1000)); S.lastFrame = now;
    const ts = cfg.run.timeScale;
    const target = ts > 0 ? S.eng.t + real * ts : Infinity;
    const t0 = performance.now(), tStart = S.eng.t, T = S.runCfg.run.duration;
    while (S.eng.t < target && S.eng.t < T && performance.now() - t0 < budget) {
      for (let i = 0; i < 20 && S.eng.t < target && S.eng.t < T; i++) { S.eng.step(); S.det.maybeSample(); }
    }
    S.simRate = S.simRate * 0.9 + 0.1 * (real > 0 ? (S.eng.t - tStart) / real : 0);
    if (S.eng.t >= T) finish();
    return true;
  }

  function loop(now) {
    requestAnimationFrame(loop);
    BG.lastRaf = now;
    if (BG.from) bgReturn();                // first frame after a background period
    if (advance(now, 14, 0.1)) drawAll(false);
  }

  /* ---- background running ----
   * Browsers stop requestAnimationFrame in hidden tabs (and slow it for minimised
   * or covered windows). While a run is active a worker clock ticks every 50 ms;
   * when no frame has been drawn for 250 ms the tick advances the simulation
   * instead, so the run keeps going in the background. */
  const BG = { worker: null, from: null, title: document.title || 'DoDump', lastTitle: 0, lastRaf: 0 };
  function bgTick() {
    const now = performance.now();
    if (S.state !== 'running') { bgStop(); return; }
    if (now - BG.lastRaf < 250) return;     // frames are running: the normal loop does the work
    if (!BG.from) BG.from = { t: S.eng.t, wall: Date.now() };
    advance(now, 40, 0.25);
    if (now - BG.lastTitle > 1000) {
      BG.lastTitle = now;
      const T = S.runCfg.run.duration;
      document.title = S.state === 'done' ? 'Done: ' + BG.title : clock(S.eng.t) + ' / ' + clock(T) + ' (' + Math.floor(100 * S.eng.t / T) + ' %) ' + BG.title;
    }
  }
  function bgStart() {
    try {
      if (!BG.worker) { BG.worker = new Worker('js/ticker.js'); BG.worker.onmessage = bgTick; }
      BG.worker.postMessage('start');
    } catch (e) { BG.worker = null; }   // no worker support: the run pauses while hidden, as before
  }
  function bgStop() { if (BG.worker) BG.worker.postMessage('stop'); }
  function bgReturn() {
    document.title = BG.title;
    S.lastFrame = performance.now();
    if (S.eng) {
      const dt = S.eng.t - BG.from.t, away = (Date.now() - BG.from.wall) / 1000;
      if (dt > 1 && away > 3) showBgNote('Kept running in the background: ' + clock(BG.from.t) + ' to ' + clock(S.eng.t) + ' simulated while the tab was hidden (' + clock(away) + ')' + (S.state === 'done' ? '. Run finished.' : '.'));
    }
    BG.from = null;
    drawAll(true);
  }
  function showBgNote(msg) {
    const el = $('#bgNote'); if (!el) return;
    el.textContent = msg; el.hidden = false;
    clearTimeout(BG.noteT); BG.noteT = setTimeout(() => { el.hidden = true; }, 10000);
  }

  function drawAll(forceCharts) {
    if (!renderer || $('#tab-sim').hidden) return;
    renderer.draw(S.eng, S.det, S.dv, S.runCfg || cfg);
    const now = performance.now();
    if (forceCharts || now - S.lastChart > 250) { S.lastChart = now; drawCharts(); renderLive(); }
  }
  function clock(s) {
    if (s < 120) return fx(s, 1) + ' s';
    const h = Math.floor(s / 3600), m = Math.floor((s - h * 3600) / 60), sec = Math.floor(s % 60);
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  function niceMin(v) { if (v >= 0) return 0; const p = Math.pow(10, Math.floor(Math.log10(-v))); return -Math.ceil(-v / p) * p; }
  /* ---------------- live charts ---------------- */
  const CHARTS = {
    flow: { title: 'Inlet and outlet mass flow' }, inside: { title: 'Stones in the DEM window' },
    vel: { title: 'Stone and water velocity' }, status: { title: 'Blockage indicator' }, profile: { title: 'Accumulation along the pipe' }
  };
  let bigChart = null;
  /** Visible time range from the range selector. */
  function timeRange() {
    const T = S.det.ts, now = T.t.length ? T.t[T.t.length - 1] : 0, dur = S.runCfg.run.duration;
    const mode = ($('#chartRange') || {}).value || 'auto';
    if (mode === 'run') return [0, dur];
    if (mode === 'auto') return [0, Math.max(now, Math.min(dur, 30))];
    const w = parseFloat(mode); return [Math.max(0, now - w), Math.max(now, w)];
  }
  function drawChart(id, cv, big) {
    const d = S.det, T = d.ts, [t0, t1] = timeRange();
    const reqTph = S.runCfg.feed.mode === 'count' ? S.dv.massRateSlice * S.dv.toTph : S.runCfg.feed.massFlow;
    if (id === 'flow') FP.charts.line(cv, [{ data: T.inRate, color: '--c-in', label: 'inlet' }, { data: T.outRate, color: '--c-out', label: 'outlet' }],
      { t: T.t, tStart: t0, tEnd: t1, unit: 't/h', yRef: reqTph, refLabel: (S.runCfg.feed.mode === 'hopper' ? 'reference ' : 'requested ') + fx(reqTph, 0) + ' t/h', robust: true, big });
    else if (id === 'inside') FP.charts.line(cv, [{ data: T.nIn, color: '--accent', label: 'stones in window' }], { t: T.t, tStart: t0, tEnd: t1, unit: 'count', big });
    else if (id === 'vel') {
      let vmin = 0; for (let i = 0; i < T.vMin.length; i++) if (T.t[i] >= t0 && T.vMin[i] < vmin) vmin = T.vMin[i];
      FP.charts.line(cv, [{ data: T.vMean, color: '--c-in', label: 'stone speed' }, { data: T.vMin, color: '--st-orange', label: 'lowest bin axial' }].concat(S.eng && S.eng.water && S.eng.water.on ? [{ data: T.uw, color: '--c-out', label: 'water (window)' }] : []),
        { t: T.t, tStart: t0, tEnd: t1, unit: 'm/s', yMin: niceMin(vmin), robust: true, big });
    } else if (id === 'status') FP.charts.status(cv, T.t, T.level, t1, { tStart: t0, big });
    else if (id === 'profile') FP.charts.profile(cv, d, S.geom, { big });
  }
  function drawCharts() {
    if (!S.det) return;
    Object.keys(CHARTS).forEach(id => drawChart(id, $('#ch-' + id), false));
    if (bigChart) drawChart(bigChart, $('#bigCanvas'), true);
  }
  function openBig(id) {
    bigChart = id; $('#bigTitle').textContent = CHARTS[id].title; $('#bigDlg').hidden = false;
    setTimeout(() => drawCharts(), 0);
  }
  function closeBig() { bigChart = null; $('#bigDlg').hidden = true; }
  U.openBig = openBig; U.closeBig = closeBig;

  const LEVEL_CLASS = ['st0', 'st1', 'st2', 'st3'];
  const LEVEL_TEXT = ['Free flowing', 'Restricted / accumulation', 'Probable bridging', 'Persistent blockage'];
  function renderLive() {
    const e = S.eng, d = S.det; if (!e) return;
    const pill = $('#statusPill');
    const lvl = d.active ? d.level : -1;
    pill.className = 'pill ' + (lvl < 0 ? 'stw' : LEVEL_CLASS[lvl]);
    pill.innerHTML = '<b>' + (lvl < 0 ? (S.state === 'idle' ? 'READY' : 'WARM-UP') : ['GREEN', 'YELLOW', 'ORANGE', 'RED'][lvl]) + '</b><span>' + (lvl < 0 ? (S.state === 'idle' ? 'Press Start' : 'Start-up transient, not assessed') : LEVEL_TEXT[lvl]) + '</span>';
    const ins = e.insideCount(), to3 = (kg) => kg / S.dv.sliceFactor / 1000;
    const tOut = to3(e.outMass), tRel = to3(e.spawnedMass), tIn = Math.max(0, to3(e.spawnedMass - e.outMass - (e.lostMass || 0)));
    $('#dumped').innerHTML = '<div class="main"><em>Total rock dumped (out of pipe)</em><b>' + fx(tOut, tOut < 100 ? 1 : 0) + ' t</b><small>' + e.outCount + ' stones through the outlet</small></div>' +
      '<div><em>Released into pipe</em><b>' + fx(tRel, tRel < 100 ? 1 : 0) + ' t</b><small>' + (e.t > 0 ? fx(tRel / e.t * 3600, 0) + ' t/h average' : '-') + '</small></div>' +
      '<div><em>Held in pipe now</em><b>' + fx(tIn, tIn < 100 ? 1 : 0) + ' t</b><small>' + (e.t > 0 ? fx(tOut / e.t * 3600, 0) + ' t/h discharged average' : '-') + '</small></div>';
    $('#readout').innerHTML =
      '<span><em>t</em>' + clock(e.t) + ' / ' + clock(S.runCfg.run.duration) + '</span>' +
      '<span><em>seed</em>' + S.runCfg.run.seed + '</span>' +
      '<span><em>speed</em>' + (S.state === 'running' ? fx(S.simRate, 2) + 'x' : '-') + '</span>' +
      '<span><em>released</em>' + e.spawned + '</span><span><em>entered</em>' + e.inCount + '</span>' +
      '<span><em>left</em>' + e.outCount + '</span><span><em>in window</em>' + ins.n + '</span>' +
      '<span><em>spheres</em>' + e.subTotal() + '</span>' +
      (e.water && e.water.freeSurface ? '<span><em>pipe top above water</em>' + fx(S.dv.dryV, 1) + ' m</span><span><em>entry speed</em>' + fx(S.dv.vEntry, 1) + ' m/s</span>' + (e.water.on ? '<span><em>level in pipe</em>' + (e.water.z >= 0 ? '-' : '+') + fx(Math.abs(e.water.z), 2) + ' m</span>' : '') : '') +
      (e.water && e.water.on ? (() => { const w = e.water.state(); return '<span><em>water in window</em>' + fx(w.uWin, 2) + ' m/s</span>' + (w.freeSurface ? '<span><em>water outflow (outlet)</em>' + fx(w.Qout, 2) + ' m3/s</span>' : '<span><em>water inflow top</em>' + fx(w.Q0, 2) + ' m3/s</span>') + '<span><em>joint inflow</em>' + fx(w.qGap, 2) + ' m3/s</span>' + (w.freeSurface ? '' : '<span><em>p top (rel.)</em>' + fx(w.pTop / 1000, 2) + ' kPa</span>'); })() : '') +
      (d.accept != null ? '<span' + (d.accept < S.runCfg.detect.rRestrict ? ' class="warnc"' : '') + '><em>feed accepted</em>' + fx(d.accept * 100, 0) + ' %</span>' : '') +
      (S.eng.t > 0 ? '<span><em>actual inflow</em>' + fx(e.feedMass / e.t * S.dv.toTph, 0) + ' t/h</span>' : '') +
      (e.vessel ? '<span><em>roll / pitch</em>' + fx(e.vm.roll * 180 / Math.PI, 1) + ' / ' + fx(e.vm.pitch * 180 / Math.PI, 1) + ' deg</span><span><em>heave</em>' + fx(e.vm.heave, 2) + ' m</span>' : '') +
      (() => { let n = 0, E = 0; e.hits.forEach(h => { n += h.n; E += h.E; }); return '<span><em>wall impacts</em>' + n + '</span><span><em>impact energy</em>' + fx(E / 1000, 1) + ' kJ</span>'; })() +
      (e.prefilled ? '<span><em>restart stones</em>' + e.prefilled + (e.gateOpen ? '' : ' (settling)') + '</span>' : '') +
      (e.lostCount ? '<span class="warnc"><em>escaped</em>' + e.lostCount + '</span>' : '') +
      (e.capacityWait ? '<span class="warnc"><em>capacity waits</em>' + e.capacityWait + '</span>' : '');
    $('#reasons').textContent = d.reasons.length ? d.reasons.join('  |  ') : (S.state === 'idle' ? 'Inputs loaded. Start the run to release stones continuously.' : 'No restriction indicators.');
    $('#liveEvents').innerHTML = d.events.length ? eventsTable(d.events.slice(-8).reverse(), S.geom, true) : '<p class="note">No dome, bridging or outflow-stop events yet.</p>';
    $('#archCard').innerHTML = (d.arch ? archCard(d.arch, d) : '') + modelWarn();
  }

  function modelWarn() {
    const c = (S.checks || []).find(x => /Janda/.test(x.name) && x.level === 3);
    return c ? '<div class="msg warn" style="margin-top:6px"><b>Clogging-prone range.</b> ' + esc(c.value) + '. Expect domes and stoppages; compare seeds before reading a single run.</div>' : '';
  }

  function archCard(a, d) {
    const ev = d.openEv;
    return '<div class="arch ' + (d.level >= 3 ? 'st3' : 'st2') + '"><b>' + (a.type === 'single' ? 'Single-stone obstruction' : 'Multi-stone dome') + '</b><span>Wall contact in ' + a.sectors + ' of 12 sectors around the pipe</span>' +
      (a.singleLBT ? '<span>Stone L x B x T ' + a.singleLBT.map(v => fx(v * 1000, 0)).join(' x ') + ' mm vs passage ' + fx(a.width * 1000, 0) + ' mm' + (a.singleLBT[1] >= a.width ? ' (B exceeds the passage: it cannot pass in any orientation)' : (a.singleLBT[0] >= a.width ? ' (L exceeds the passage: passes only aligned with the pipe)' : ' (smaller than the passage: held by friction and the stones above)')) + '</span>' : '') +
      '<span>Depth ' + fx(a.sGlobal != null ? a.sGlobal : a.s, 2) + ' m' + (a.inFeed ? ' (feed chute)' : '') + ', passage ' + fx(a.width * 1000, 0) + ' mm, ' + esc(FP.results.nearestFeature(S.geom, a.s)) + '</span>' +
      '<span>' + a.sizes.length + ' stones in the dome band. Dn ' + a.sizes.slice(0, 8).map(v => fx(v * 1000, 0)).join(', ') + ' mm; L ' + a.lens.slice(0, 8).map(v => fx(v * 1000, 0)).join(', ') + ' mm</span>' +
      (a.clsCount && Object.keys(a.clsCount).length ? '<span>Shape classes in arch: ' + Object.keys(a.clsCount).map(k => k + ' ' + a.clsCount[k]).join(', ') + '</span>' : '') +
      '<span>Supported plug ' + a.nPlug + ' stones, ' + fx(a.massPlug, 0) + ' kg. Local solid fraction (volume) ' + fx(a.phi, 2) + '</span>' +
      (ev ? '<span>Age ' + fx(S.eng.t - ev.tStart, 1) + ' s</span>' : '') + '</div>';
  }

  function eventsTable(evs, geom, compact) {
    const name = { single: 'Single-stone obstruction', arch: 'Multi-stone dome', 'outflow-stop': 'Outflow stopped (no spanning arch)', 'inlet-choke': 'Inlet choked (feed not accepted)' };
    return '<div class="tbl-wrap"><table class="data"><thead><tr><th>#</th><th>Type</th><th>Start [s]</th><th>Duration [s]</th><th>Persistent</th><th>Depth [m]</th><th>Passage [mm]</th>' + (compact ? '' : '<th>Dn in arch [mm]</th><th>L in arch [mm]</th><th>Plug [n]</th><th>Plug mass [kg]</th><th>Solid fraction</th><th>Nearest feature</th>') + '</tr></thead><tbody>' +
      evs.map(ev => '<tr><td>' + ev.id + '</td><td>' + name[ev.type] + '</td><td>' + fx(ev.tStart, 2) + '</td><td>' + fx(ev.open && S.eng ? S.eng.t - ev.tStart : ev.duration, 2) + '</td><td>' + (ev.persistent ? 'yes' : ev.transient ? 'no (transient)' : 'no') + '</td><td>' + (ev.s == null ? '-' : fx(ev.sGlobal != null ? ev.sGlobal : ev.s, 2)) + '</td><td>' + (ev.width == null ? '-' : fx(ev.width * 1000, 0)) + '</td>' +
        (compact ? '' : '<td>' + ev.sizes.slice(0, 10).map(v => fx(v * 1000, 0)).join(', ') + '</td><td>' + (ev.lens || []).slice(0, 10).map(v => fx(v * 1000, 0)).join(', ') + '</td><td>' + ev.nPlugMax + '</td><td>' + fx(ev.massPlugMax, 0) + '</td><td>' + fx(ev.phi, 2) + '</td><td>' + (geom ? esc(FP.results.nearestFeature(geom, ev.s)) : '-') + '</td>') + '</tr>').join('') + '</tbody></table></div>';
  }

  function updateButtons() {
    const st = S.state, ok = !!S.eng && !S.valid.errors.length;
    $('#bStart').disabled = !ok || st === 'running' || st === 'paused';
    $('#bStart').textContent = st === 'done' ? 'Run again' : 'Start';
    $('#bPause').disabled = st !== 'running';
    $('#bResume').disabled = st !== 'paused';
    $('#bStep').disabled = !ok || st === 'running' || st === 'done';
    $('#bStop').disabled = !(st === 'running' || st === 'paused');
    $('#bReset').disabled = !S.eng && !ok;
  }
  function showPending() { $('#pending').hidden = !S.pending; }

  function renderLegend() {
    const mode = renderer.opts.colorBy;
    const grad = 'linear-gradient(90deg,' + [0, 0.25, 0.5, 0.75, 1].map(t => FP.render3d.cmap(t)).join(',') + ')';
    let scale;
    const sr = renderer.sizeRange || [0, 0], lr = renderer.lenRange || [0, 0];
    if (mode === 'size') scale = '<span class="lg-scale" style="background:' + grad + '"></span><span class="lg-lab">' + fx(sr[0] * 1000, 0) + ' mm</span><span class="lg-lab r">' + fx(sr[1] * 1000, 0) + ' mm Dn (log)</span>';
    else if (mode === 'length') scale = '<span class="lg-scale" style="background:' + grad + '"></span><span class="lg-lab">' + fx(lr[0] * 1000, 0) + ' mm</span><span class="lg-lab r">' + fx(lr[1] * 1000, 0) + ' mm L</span>';
    else if (mode === 'velocity') { const v = S.dv && isFinite(S.dv.vTermMax) ? Math.max(0.5, S.dv.vTermMax * 1.3) : 6; scale = '<span class="lg-scale" style="background:' + grad + '"></span><span class="lg-lab">0</span><span class="lg-lab r">' + fx(v, 1) + ' m/s</span>'; }
    else if (mode === 'class') { const names = ['blocky', 'long + thin', 'flat', 'bladed', 'rounded', 'ellipsoid / sphere']; scale = names.map((n, i) => '<span class="lg-dot" style="background:' + FP.render3d.CLASS_COL[i] + '"></span>' + n).join(' '); }
    else scale = '<span class="lg-dot" style="background:var(--st-orange)"></span>stalled (speed &lt; ' + cfg.detect.vStall + ' m/s) <span class="lg-dot" style="background:var(--muted)"></span>moving';
    const wf = S.eng && S.eng.water && S.eng.water.freeSurface;
    $('#legend').innerHTML = '<div class="lg-row"><b>Colour: ' + ({ size: 'nominal diameter Dn', length: 'stone length L', velocity: 'speed', state: 'stall state', class: 'shape class' })[mode] + '</b>' + scale + '</div>' +
      '<div class="lg-row">' + (renderer.opts.showSpheres ? 'Drawn: DEM contact spheres. ' : 'Drawn: stone body (superellipsoid in L x B x T; the DEM spheres sit inside it). ') +
      '<span class="lg-dot" style="background:var(--st-orange)"></span>dome member and ring at the dome depth' + (wf ? ' <span class="lg-band" style="background:#2a8bd6"></span>water level inside the pipe (disc) and outside (ring)' : '') +
      '. Drag to rotate, right-drag or shift-drag to pan, wheel or pinch to zoom, double-click to fit.</div>';
  }

  /* ---------------- results ---------------- */
  function clsPill(cls) {
    const lv = FP.detection.Detector.CLASS[cls].level;
    return '<span class="tag ' + LEVEL_CLASS[lv] + '">' + FP.detection.Detector.CLASS[cls].label + '</span>';
  }
  U.clsPill = clsPill; U.eventsTable = eventsTable; U.LEVEL_CLASS = LEVEL_CLASS;

  function renderResults() {
    const runs = RS.runs;
    const sel = runs.find(r => r.id === S.selectedRun) || runs[runs.length - 1];
    const box = $('#resSummary');
    if (!sel) box.innerHTML = '<p class="note">Complete or stop a run to see a summary here. Runs are kept in this browser only.</p>';
    else {
      const rows = [
        ['Fall-pipe configuration', sel.pipeType], ['Geometry', sel.geometry], ['Narrowest passage in window', fx(sel.minPassage * 1000, 0) + ' mm'],
        ['Rock grade', sel.grade + ', density ' + sel.rho + ' kg/m3'],
        ['Generated stones (by mass)', 'Dn10 ' + fx(sel.realized.dn10, 0) + ', Dn50 ' + fx(sel.realized.dn50, 0) + ', Dn90 ' + fx(sel.realized.dn90, 0) + ' mm; M50 ' + fx(sel.realized.m50, 1) + ' kg; mean ' + fx(sel.realized.meanMass, 1) + ' kg'],
        ['Stones and shapes', sel.shape], ['Flow settings', sel.flow], ['Medium', sel.medium], ['Seed', sel.seed],
        ['Water', sel.medium + (sel.water ? '. Second half of run: water ' + fx(sel.water.uWinMean, 2) + ' m/s in the window, inflow at the top ' + fx(sel.water.QinMean, 2) + ' m3/s over ' + fx(sel.water.Ltot, 1) + ' m of pipe; joint inflow at end ' + fx(sel.water.qGapEnd, 2) + ' m3/s' : '')],
        ['Model', '3D DEM, full pipe cross-section (no slice scaling)'],
        ['Simulation duration', fx(sel.duration, 2) + ' s'],
        ['Blockage status', '#STATUS#'],
        ['Time when bridging first detected', sel.tBridge == null ? 'none' : fx(sel.tBridge, 2) + ' s'],
        ['Time when blockage (RED) started', sel.tBlock == null ? 'none' : fx(sel.tBlock, 2) + ' s'],
        ['Mass discharged before blockage', sel.massOutBeforeBlock == null ? 'n/a' : fx(sel.massOutBeforeBlock, 2) + ' t (' + sel.stonesOutBeforeBlock + ' stones)'],
        ['Blockage location', sel.blockLocation == null ? 'none' : 'depth ' + fx(sel.blockLocationGlobal, 2) + ' m, passage ' + fx(sel.blockWidth * 1000, 0) + ' mm (' + sel.blockFeature + ')'],
        ['Stones involved', sel.blockSizes.length ? sel.blockSizes.length + ' in the dome band; Dn ' + sel.blockSizes.slice(0, 10).map(v => fx(v, 0)).join(', ') + ' mm; L ' + (sel.blockLens || []).slice(0, 10).map(v => fx(v, 0)).join(', ') + ' mm. Supported plug up to ' + sel.blockParticles + ' stones, ' + fx(sel.blockMass, 0) + ' kg' : 'none'],
        ['Outlet / inlet mass ratio (whole run)', fx(sel.flowRatio, 3)],
        ['Feed', ({ mass: 'metered', hopper: 'gravity-fed full hopper', count: 'stone rate' })[sel.feedMode] + (sel.feedAccepted != null ? ', accepted ' + fx(sel.feedAccepted * 100, 0) + ' % of the requested mass' + (sel.feedAcceptMin != null ? ' (lowest over the rate window ' + fx(sel.feedAcceptMin * 100, 0) + ' %)' : '') : '') + (sel.achievedInflow != null ? ', actual inflow ' + fx(sel.achievedInflow, 0) + ' t/h' : '') + (sel.prefilled ? ', restart with ' + sel.prefilled + ' stones in the window' : '')],
        ['Total rock dumped', fx(sel.massOutTotal, 2) + ' t discharged from the pipe outlet in ' + fx(sel.tEnd || sel.duration || 0, 0) + ' s'],
        ['Released / discharged', fx(sel.massReleased, 2) + ' t / ' + fx(sel.massOutTotal, 2) + ' t'],
        ['Released / entered / left / in domain / escaped', sel.spawned + ' / ' + sel.entered + ' / ' + sel.exited + ' / ' + sel.aliveN + ' / ' + sel.lost],
        ['Maximum accumulation location', 'depth ' + fx(sel.maxAccum.s + (sel.s0Global || 0), 2) + ' m' + (sel.maxAccum.s < 0 ? ' (feed chute, above the window)' : '') + ' (' + fx(sel.maxAccum.value, 1) + ' stalled stone-seconds, passage ' + fx(sel.maxAccum.width * 1000, 0) + ' mm)'],
        ['Share of assessed time at YELLOW or worse', fx(sel.restrictedShare * 100, 0) + ' %'],
        ['Wall impacts (normal speed > 0.3 m/s)', sel.hits ? FP.extra3d.hitsText(sel.hits) : 'not recorded'],
        ['Stones at the water surface', sel.entry && sel.entry.n ? sel.entry.n + ' stones; speed median ' + fx(sel.entry.vMed, 1) + ', max ' + fx(sel.entry.vMax, 1) + ' m/s; long axis to pipe axis median ' + fx(sel.entry.angMed, 0) + ' deg' : 'none (pipe top below water or no stones yet)'],
        ['Vessel motion / feed', (sel.vesselText || 'none') + '; ' + (sel.feedText || '')],
        ['Numerics', 'dt ' + sci(sel.dt) + ' s, kn ' + sci(sel.kn) + ' N/m, max overlap ' + fx(sel.maxOverlap * 100, 1) + ' % of stone radius, peak ' + sel.peakBodies + ' of ' + sel.cap + ' slots' + (sel.capacityWait ? ', capacity waits ' + sel.capacityWait : '')]
      ];
      box.innerHTML = '<div class="sumhead"><h3>Run ' + esc(new Date(sel.when).toLocaleString()) + '</h3>' + clsPill(sel.cls) + '</div><dl class="kv wide">' + rows.map(r => '<dt>' + r[0] + '</dt><dd>' + (r[1] === '#STATUS#' ? clsPill(sel.cls) : esc(r[1])) + '</dd>').join('') + '</dl>' +
        '<h4>Events</h4>' + (sel.events.length ? eventsTable(sel.events, null, false) : '<p class="note">No events recorded.</p>') +
        (sel.cfg ? '<div class="btnrow"><button type="button" class="btn sm" data-load="' + sel.id + '">Load these inputs</button></div>' : '');
    }
    const tb = $('#resCompare');
    if (!runs.length) { tb.innerHTML = '<p class="note">No saved runs.</p>'; return; }
    tb.innerHTML = '<div class="tbl-wrap"><table class="data cmp"><thead><tr><th></th><th>When</th><th>Pipe</th><th>Geometry</th><th>Grade</th><th>Flow</th><th>Seed</th><th>Status</th><th>Block depth [m]</th><th>Block t [s]</th><th>Mass before block [t]</th><th>Out/in</th><th>Escaped</th><th></th></tr></thead><tbody>' +
      runs.slice().reverse().map(r => '<tr class="' + (r.id === (sel && sel.id) ? 'sel' : '') + '"><td><button type="button" class="link" data-view="' + r.id + '">View</button></td><td>' + esc(new Date(r.when).toLocaleTimeString()) + '</td><td>' + esc(r.pipeType) + '</td><td class="wrap">' + esc(r.geometry) + '</td><td>' + esc(r.grade) + '</td><td class="wrap">' + esc(r.flow) + '</td><td>' + esc(r.seed) + '</td><td>' + clsPill(r.cls) + '</td><td>' + (r.blockLocationGlobal == null ? '-' : fx(r.blockLocationGlobal, 2)) + '</td><td>' + (r.tBlock == null ? '-' : fx(r.tBlock, 1)) + '</td><td>' + (r.massOutBeforeBlock == null ? '-' : fx(r.massOutBeforeBlock, 2)) + '</td><td>' + fx(r.flowRatio, 2) + '</td><td>' + r.lost + '</td><td><button type="button" class="link danger" data-del="' + r.id + '">Remove</button></td></tr>').join('') + '</tbody></table></div>';
  }

  /* ---------------- diagnostics ---------------- */
  function renderDiag() {
    const e = S.eng, dv = S.dv, c = S.runCfg, box = $('#diagBody');
    if (!e) { box.innerHTML = '<p class="note">No model loaded. Fix input errors first.</p>'; return; }
    const alive = e.aliveMass();
    const N1 = alive.n - alive.nExitedAlive;
    const resN = e.spawned - (N1 + e.outCount + e.lostCount);
    const resM = e.spawnedMass - (alive.mass - alive.mExitedAlive + e.outMass + e.lostMass);
    const ok = (b) => b ? '<span class="tag st0">OK</span>' : '<span class="tag st3">FAIL</span>';
    const g = FP.physics3d.gammaFromE;
    const ovRun = e.maxOverlapRun * 100, ovSub = e.maxSubOverlapRun * 100;
    const flags = [];
    if (ovRun > 10) flags.push(['err', 'Maximum overlap ' + fx(ovRun, 1) + ' % of stone radius. Contacts are too soft or impacts too fast. Lower the target overlap or raise vChar, and reduce the time step. Results near this event are numerical, not physical.']);
    else if (ovRun > 5) flags.push(['warn', 'Maximum overlap ' + fx(ovRun, 1) + ' % of stone radius. Acceptable for screening; check sensitivity with a stiffer setting.']);
    if (e.lostCount) flags.push(['warn', e.lostCount + ' stone(s) left the domain other than through the outlet: genuine spillage through an open gap (e.g. the annular pocket) or a stone passing through a wall because the time step is too large.']);
    if (dv.dtOverTc > 0.2) flags.push(['err', 'Time step is ' + fx(dv.dtOverTc, 2) + ' of the shortest contact time. Reduce it below 0.2.']);
    if (e.capacityWait) flags.push(['warn', 'The body capacity (' + e.cap + ') was full ' + e.capacityWait + ' times; the feed waited. Raise the capacity factor.']);
    if (e.contactOverflow) flags.push(['warn', 'Contact record overflow: the detector saw only part of the contact network.']);
    if (e.histOverflow) flags.push(['warn', 'Tangential history slots overflowed ' + e.histOverflow + ' times; friction memory was dropped for some contacts.']);
    if (!flags.length) flags.push(['ok', 'No numerical warning flags for this run so far.']);
    const to3 = (kg) => kg / dv.sliceFactor / 1000;
    const sections = [
      ['Conservation', [
        ['Released', e.spawned + ' stones, ' + fx(e.spawnedMass, 1) + ' kg (target ' + fx(dv.massRateSlice * e.t, 1) + ' kg)'],
        ['Entered window (s = 0)', e.inCount + ', ' + fx(e.inMass, 1) + ' kg'],
        ['Left through outlet', e.outCount + ', ' + fx(e.outMass, 1) + ' kg'],
        ['Remaining in domain', N1 + ', ' + fx(alive.mass - alive.mExitedAlive, 1) + ' kg'],
        ['Of which inside window', e.insideCount().n],
        ['Escaped elsewhere', e.lostCount + ', ' + fx(e.lostMass, 1) + ' kg'],
        ['Count balance residual', resN + ' ' + ok(resN === 0)],
        ['Mass balance residual', sci(resM) + ' kg ' + ok(Math.abs(resM) < 1e-9 * Math.max(1, e.spawnedMass))],
        ['Released / discharged', fx(to3(e.spawnedMass), 2) + ' t / ' + fx(to3(e.outMass), 2) + ' t'],
        ['Feed blocked time', fx(e.feedBlockedTime, 2) + ' s']
      ]],
      ['Numerics', [
        ['Time step dt', sci(dv.dt) + ' s'], ['Shortest contact t_c (pair / wall)', sci(dv.tcPP) + ' / ' + sci(dv.tcPW) + ' s'], ['dt / t_c', fx(dv.dtOverTc, 3)],
        ['Steps taken', e.steps.toLocaleString()], ['Simulated time', fx(e.t, 3) + ' s'],
        ['Max overlap this step', fx(e.maxOverlapStep * 100, 2) + ' % of stone radius'],
        ['Max overlap in run (stone / wall / sub-circle)', fx(ovRun, 2) + ' / ' + fx(e.maxWallOverlapRun * 100, 2) + ' / ' + fx(ovSub, 2) + ' %'],
        ['Steps with overlap above 5 %', e.overlapOver5.toLocaleString()],
        ['Body slots: capacity / peak in use', e.cap + ' / ' + e.peakBodies],
        ['Stones shortened by the Lmax cap', e.cappedStones],
        ['Neighbour search', 'axial sweep over bodies, bounding spheres, then sphere pairs; ' + e.nz + ' axial wall layers of ' + fx(e.h * 1000, 0) + ' mm'],
        ['Spheres in use / largest spin', e.subTotal() + ' / ' + fx(e.maxSpin, 1) + ' rad/s'],
        ['Integrator', 'Semi-implicit Euler, fixed step; unit quaternions, Euler equations with gyroscopic term']
      ]],
      ['Contact parameters', [
        ['kn (Dn50 pair)', sci(dv.kn) + ' N/m, scaled by Reff / Reff(Dn50)'], ['kt', sci(dv.kt) + ' N/m (kt/kn ' + c.physics.ktRatio + ')'],
        ['Rock-rock friction / restitution / rolling', c.physics.muPP + ' / ' + c.physics.ePP + ' (damping ratio ' + fx(g(c.physics.ePP), 3) + ') / ' + c.physics.muRollPP],
        ['Rock-wall per material', S.geom.mats.map((id, i) => { const w = dv.wallProps[i]; return id + ': mu ' + w.mu + ', e ' + w.e + ', roll ' + w.muRoll + ', k ratio ' + fx(w.kRatio, 2); }).join('; ')],
        ['Gravity, effective (buoyancy)', c.physics.g + ' m/s2, ' + fx(c.physics.g * dv.buoy, 3) + ' m/s2'],
        ['Fluid', c.physics.fluid ? 'water, rho ' + c.physics.rhoF + ' kg/m3, Cd ' + c.physics.cd : 'none'],
        ['Time step basis', 'contact time with the rotational effective mass m / (1 + m d^2 / I) of the most exposed sphere']
      ]],
      ['Water in the pipe', e.water && e.water.on ? (() => { const w = e.water.state(); return [
        ['Model', 'coupled 1D water column over ' + fx(w.Ltot, 1) + ' m, ' + w.nGaps + ' open joint gaps (total ' + fx(w.gapArea, 3) + ' m2)'],
        ['Inflow at top / outflow at outlet', fx(w.Q0, 3) + ' / ' + fx(w.Qout, 3) + ' m3/s'],
        ['Net inflow through joints', fx(w.qGap, 3) + ' m3/s'],
        ['Water velocity top / outlet / window', fx(w.uTop, 2) + ' / ' + fx(w.uOut, 2) + ' / ' + fx(w.uWin, 2) + ' m/s'],
        ['Inlet pressure below ambient', fx(-w.pTop / 1000, 2) + ' kPa'],
        ['Rock loading on water (3D, per metre)', fx(w.forcePerM, 0) + ' N/m'],
        ['Di Felice exponent chi / Re (Dn50)', fx(w.chi, 2) + ' / ' + sci(w.Re50)],
        ['Added mass coefficient', c.water.Ca]
      ]; })() : [['Model', c.physics.fluid ? 'still water: buoyancy, drag' + (c.water.hindered ? ' with Di Felice hindrance' : '') + ', added mass ' + c.water.Ca : 'no fluid']]],
      ['Wall impacts and water entry', [
        ['Impacts per wall (n, energy, peak normal speed)', FP.extra3d.hitsText(e.hitSummary(), S.geom)],
        ['Stones crossing the water surface', e.entry.n ? e.entry.n + '; speed median ' + fx(FP.stats.quantile(e.entry.v, 0.5), 1) + ' m/s, 90 % ' + fx(FP.stats.quantile(e.entry.v, 0.9), 1) + ' m/s' : 'none'],
        ['Long axis to pipe axis at the surface', e.entry.n ? 'median ' + fx(FP.stats.quantile(e.entry.ang, 0.5), 0) + ' deg (random orientation: 60 deg)' : '-']
      ]],
      ['Generated stones vs grade', [
        ['Distribution', S.fac.sampler.label],
        ['Generated Dn10 / Dn50 / Dn90 (by mass)', fx(S.fac.stats.Dn10 * 1000, 0) + ' / ' + fx(S.fac.stats.Dn50 * 1000, 0) + ' / ' + fx(S.fac.stats.Dn90 * 1000, 0) + ' mm'],
        ['Generated M50 / mean mass', fx(S.fac.stats.M50, 1) + ' / ' + fx(S.fac.stats.meanMass, 1) + ' kg'],
        ['Grade Mem', c.grade.Mem ? c.grade.Mem[0] + ' to ' + c.grade.Mem[1] + ' kg' : 'not given'],
        ['Grade Dn50 (class table)', c.grade.classTable && c.grade.classTable.Dn50cm ? c.grade.classTable.Dn50cm + ' cm' : 'not given'],
        ['Stones from measured shape records', fx(S.fac.stats.measuredFrac * 100, 1) + ' %']
      ]],
      ['Simulation assumptions in force (editable, provisional)', [
        ['Sampling interval / effective rate window', c.detect.sampleDt + ' s / ' + fx(S.det.W, 1) + ' s'],
        ['Warm-up', c.detect.warmupMode === 'auto' ? 'auto, upper bound ' + fx(dv.warmup, 1) + ' s' : c.detect.warmup + ' s'],
        ['Restricted if outlet/inlet below', c.detect.rRestrict], ['Blocked if outlet/nominal at or below', c.detect.rBlock],
        ['Stalled speed', c.detect.vStall + ' m/s'], ['Dense solid fraction', c.detect.phiJam],
        ['Persistent bridge after', c.detect.tPersist + ' s'], ['Bridge break tolerance', c.detect.breakTol + ' s'],
        ['Minimum bridge duration counted', c.detect.tMinBridge + ' s'],
        ['Dense solid fraction basis', 'volume (3D)']
      ]]
    ];
    box.innerHTML = '<div class="flags">' + flags.map(f => '<p class="msg ' + f[0] + '">' + esc(f[1]) + '</p>').join('') + '</div>' +
      '<div class="diaggrid">' + sections.map(sc => '<section class="card"><h3>' + sc[0] + '</h3><dl class="kv">' + sc[1].map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl></section>').join('') + '</div>' +
      (e.lostLog.length ? '<section class="card"><h3>Escaped stones (first ' + e.lostLog.length + ')</h3><div class="tbl-wrap"><table class="data"><thead><tr><th>t [s]</th><th>s [m]</th><th>n [m]</th><th>Dn [mm]</th></tr></thead><tbody>' + e.lostLog.map(l => '<tr><td>' + fx(l.t, 2) + '</td><td>' + fx(l.s, 2) + '</td><td>' + fx(l.n, 3) + '</td><td>' + fx(l.d * 1000, 0) + '</td></tr>').join('') + '</tbody></table></div></section>' : '');
  }

  function sensitivity(kind) {
    if (kind === 'seed') { if (cfg.run.seedMode === 'fixed') cfg.run.seed = (cfg.run.seed || 1) + 1; }
    if (kind === 'dt') { cfg.physics.dtMode = 'manual'; cfg.physics.dt = +(S.dv.dt / 2).toPrecision(3); }
    if (kind === 'k') { if (cfg.physics.kMode === 'auto') cfg.physics.overlapPct = +(cfg.physics.overlapPct / Math.SQRT2).toPrecision(3); else cfg.physics.kn *= 2; }
    buildForms(); LS.set(KEY_CFG, cfg);
    S.state = 'idle'; S.pending = false;
    prepare(); switchTab('sim'); setTimeout(start, 50);
  }

  /* ---------------- tabs ---------------- */
  function switchTab(name) {
    if (FP.admin && !FP.admin.allowed(name)) name = 'sim';
    $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'));
    $$('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + name; });
    if (name === 'results') renderResults();
    if (name === 'diag') renderDiag();
    if (U.pages && U.pages[name]) U.pages[name]();
    if (name === 'sim') setTimeout(() => { drawAll(true); }, 0);
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
  }

  /* ---------------- init ---------------- */
  function init() {
    if (FP.admin) FP.admin.init();
    renderer = new FP.render3d.Renderer($('#view'));
    if (!renderer.ok) $('#noGL').hidden = false;
    buildForms();
    document.addEventListener('change', (e) => { if (e.target.closest('#inputs')) onInput(e); });
    document.addEventListener('input', (e) => { if (e.target.closest('#inputs') && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') onInput(e); });
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.id === 'gradeSave') {
        const g = FP.config.clone(cfg.grade);
        const i = library.findIndex(x => x.id === g.id);
        if (i >= 0) { if (JSON.stringify(library[i]) !== JSON.stringify(g)) g.revision = (g.revision || 'R1') + ' / edited ' + new Date().toISOString().slice(0, 10); library[i] = g; }
        else library.push(g);
        cfg.grade = FP.config.clone(g);
        U.saveLibrary(); buildForms(); LS.set(KEY_CFG, cfg);
      } else if (t.id === 'gradeRevert') {
        const g = library.find(x => x.id === cfg.grade.id); if (g) { cfg.grade = FP.config.clone(g); buildForms(); changed(); }
      } else if (t.dataset.tab) switchTab(t.dataset.tab);
      else if (t.dataset.view) { S.selectedRun = t.dataset.view; renderResults(); $('#tab-results').scrollTop = 0; }
      else if (t.dataset.del) { RS.remove(t.dataset.del); renderResults(); }
      else if (t.dataset.load) {
        const r = RS.runs.find(x => x.id === t.dataset.load);
        if (r && r.cfg) { cfg = deepMerge(FP.config3d.defaultConfig(), FP.config.clone(r.cfg)); cfg.grade = FP.config.clone(r.cfg.grade); cfg.materials = FP.config.clone(r.cfg.materials); cfg.run.seedMode = 'fixed'; cfg.run.seed = r.seed != null ? r.seed : cfg.run.seed; S.state = 'idle'; buildForms(); changed(); switchTab('sim'); }
      } else if (t.dataset.sens) sensitivity(t.dataset.sens);
      else if (t.id === 'resClear') { RS.clear(); renderResults(); }
      else if (t.id === 'cfgDefaults') { cfg = FP.config3d.defaultConfig(); S.state = 'idle'; buildForms(); changed(); }
    });
    // chart controls (remembered per viewer)
    const SIZES = { s: ['132px', '400px'], m: ['200px', '440px'], l: ['260px', '560px'], xl: ['340px', '720px'] };
    const applySize = (v) => { const z = SIZES[v] || SIZES.s; document.documentElement.style.setProperty('--ch-h', z[0]); document.documentElement.style.setProperty('--live-w', z[1]); renderer && renderer.fit(); drawAll(true); };
    $('#chartSize').value = LS.get('fallpipe.chartSize', 's'); applySize($('#chartSize').value);
    $('#chartSize').onchange = (e) => { LS.set('fallpipe.chartSize', e.target.value); applySize(e.target.value); };
    $('#chartRange').value = LS.get('fallpipe.chartRange', 'auto');
    $('#chartRange').onchange = (e) => { LS.set('fallpipe.chartRange', e.target.value); drawAll(true); };
    document.addEventListener('click', (e) => { const b = e.target.closest('[data-big]'); if (b) openBig(b.dataset.big); if (e.target.id === 'bigClose' || e.target.id === 'bigDlg') closeBig(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bigChart) closeBig(); });
    window.addEventListener('resize', () => { if (bigChart) drawCharts(); });
    // duration in the top bar (same setting as the panel field; up to 24 h)
    const UNIT = { s: 1, min: 60, h: 3600 };
    const syncDur = () => { const u = cfg.run.durUnit || 's'; $('#topDurUnit').value = u; if (document.activeElement !== $('#topDur')) $('#topDur').value = +(cfg.run.duration / UNIT[u]).toPrecision(6); };
    U.syncDur = syncDur; syncDur();
    S.dt0 = () => S.dv ? S.dv.dt : 0;
    $('#topDur').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value), u = cfg.run.durUnit || 's';
      if (!(v > 0)) { e.target.classList.add('bad'); return; }
      e.target.classList.remove('bad');
      cfg.run.duration = v * UNIT[u]; buildForms();
      if (S.state === 'running' || S.state === 'paused') { S.runCfg.run.duration = Math.max(cfg.run.duration, S.eng.t + S.dt0()); LS.set(KEY_CFG, cfg); } // extend or shorten the running dump
      else changed();
    });
    $('#topDurUnit').addEventListener('change', (e) => { cfg.run.durUnit = e.target.value; buildForms(); syncDur(); LS.set(KEY_CFG, cfg); });
    $('#bStart').onclick = start; $('#bPause').onclick = pause; $('#bResume').onclick = resume;
    $('#bReset').onclick = reset; $('#bStep').onclick = stepOnce; $('#bStop').onclick = stopNow;
    $('#speed').value = String(cfg.run.timeScale);
    $('#speed').onchange = (e) => { cfg.run.timeScale = parseFloat(e.target.value); LS.set(KEY_CFG, cfg); };
    $('#colorBy').onchange = (e) => { renderer.opts.colorBy = e.target.value; renderLegend(); drawAll(false); };
    $('#tgSph').onchange = (e) => { renderer.opts.showSpheres = e.target.checked; renderLegend(); drawAll(false); };
    $('#tgCut').onchange = (e) => { renderer.setCutaway(e.target.checked); };
    $('#tgWater').onchange = (e) => { renderer.opts.showWater = e.target.checked; drawAll(false); };
    $('#wallAlpha').oninput = (e) => { renderer.setWallAlpha(parseFloat(e.target.value)); };
    $('#bFit').onclick = () => { renderer.fit(); };
    $('#bSide').onclick = () => renderer.view('side');
    $('#bIso').onclick = () => renderer.view('iso');
    $('#bTop').onclick = () => renderer.view('top');
    $('#bBot').onclick = () => renderer.view('bottom');
    $('#bCrit').onclick = () => {
      if (!S.geom) return;
      const g = S.geom, d = S.det;
      let s;
      if (d && d.arch) s = d.arch.s;
      else { const f = g.features.find(f => f.kind === 'overlap') || g.features.find(f => f.kind === 'opening'); s = f ? f.s : g.L / 2; }
      renderer.zoomTo(s, Math.max(1.2, g.widthAt(Math.max(0, s)) * 2.2));
    };
    $('#imp2d').onclick = () => {
      const c2 = LS.get(KEY_CFG2D, null), msg = $('#impMsg');
      if (!c2 || c2.version !== 2) { msg.textContent = 'No 2D inputs found in this browser for this site. Open the 2D page from the same site once, then try again.'; return; }
      cfg = deepMerge(FP.config3d.defaultConfig(), FP.config3d.from2D(c2));
      cfg.grade = FP.config.clone(c2.grade); cfg.materials = FP.config.clone(c2.materials);
      cfg.pipe.string = Object.assign(FP.config.defaultConfig().pipe.string, FP.config.clone(c2.pipe.string));
      cfg.dim = 3; S.state = 'idle'; buildForms(); changed();
      msg.textContent = 'Loaded the 2D inputs (grade, string, materials, feed, water, physics). Dense solid fraction set to the 3D default where the 2D default was used.';
    };
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const recolor = () => { renderer.refreshColors(); drawAll(true); };
    mq.addEventListener && mq.addEventListener('change', recolor);
    new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', () => drawAll(true));
    const h = (location.hash || '').replace('#', '');
    switchTab(['sim', 'prob', 'results', 'diag', 'method'].indexOf(h) >= 0 ? h : 'sim');
    prepare();
    setTimeout(() => { renderer.fit(); drawAll(true); }, 30);
    requestAnimationFrame(loop);
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})(self.FP = self.FP || {});
