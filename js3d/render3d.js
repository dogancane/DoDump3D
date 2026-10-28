/* ==========================================================================
 * js3d/render3d.js
 * WebGL view of the 3D DEM window (three.js r128, global THREE).
 *
 * Display frame: screen up = up the pipe. Engine (x, y, z = s) maps to
 * three.js (x, -z, y), so the tilt plane (x, s) faces the camera in the
 * side view. Stones are instanced meshes of the same superellipsoid the
 * engine fills with spheres (blocks: exponent from the volume factor,
 * rounded / L/T: ellipsoid), oriented by the stone's quaternion. "Contact spheres" shows the DEM spheres
 * instead. The pipe walls are lathe surfaces of the same meridian
 * quadrilaterals the engine collides with, with an optional cutaway.
 * Orbit: drag rotates, right-drag or shift-drag pans, wheel or pinch zooms.
 * ========================================================================== */
(function (FP) {
  'use strict';

  const CLASS_COL = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#8a8f98'];
  const CMAP = [[0.00, [43, 52, 120]], [0.25, [38, 104, 160]], [0.50, [33, 154, 140]], [0.75, [150, 196, 70]], [1.00, [250, 220, 60]]];
  function cmapRGB(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < CMAP.length - 1; i++) {
      const a = CMAP[i], b = CMAP[i + 1];
      if (t <= b[0]) { const u = (t - a[0]) / (b[0] - a[0]); return [0, 1, 2].map(k => (a[1][k] + u * (b[1][k] - a[1][k])) / 255); }
    }
    return [250 / 255, 220 / 255, 60 / 255];
  }
  function cmap(t) { const c = cmapRGB(t); return 'rgb(' + c.map(v => Math.round(v * 255)).join(',') + ')'; }
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  const MAT_COL = { HDPE: '#3f7f9c', MDPE: '#4d8aa3', PE: '#5b93a8', S355: '#8a9199' };

  function Renderer(canvas) {
    this.cv = canvas;
    this.opts = { colorBy: 'size', wallAlpha: 0.3, showSpheres: false, cutaway: true, showWater: true };
    this.ok = typeof THREE !== 'undefined';
    this.geom = null;
    this.cam = { az: 0.55, el: 0.28, dist: 12, tx: 0, ty: -3, tz: 0 };
    if (!this.ok) return;
    const R = this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    R.localClippingEnabled = true;
    R.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.05, 500);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.75));
    const dl = new THREE.DirectionalLight(0xffffff, 0.75); dl.position.set(4, 6, 8); this.scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.25); dl2.position.set(-5, -2, -6); this.scene.add(dl2);
    this.clip = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];
    this.pipe = new THREE.Group(); this.scene.add(this.pipe);
    this.extras = new THREE.Group(); this.scene.add(this.extras);
    this.inst = null; this.cap = 0;
    this.tmpM = new THREE.Matrix4(); this.tmpC = new THREE.Color();
    this.refreshColors();
    this.bindInput();
  }

  Renderer.prototype.refreshColors = function () {
    this.colors = { ink: css('--ink') || '#13222c', muted: css('--muted') || '#5a6a74', wallLine: css('--wall-line') || '#2c414d',
      orange: css('--st-orange') || '#dc6418', red: css('--st-red') || '#c4282c', accent: css('--accent') || '#0b6a86', grid: css('--grid') || '#e0e6e9' };
    if (this.lineMat) this.lineMat.color.set(this.colors.wallLine);
  };

  Renderer.prototype.setRanges = function (fac) {
    const sm = fac.stats.sample, dn = sm.map(s => s.Dn), L = sm.map(s => s.L);
    this.sizeRange = [Math.min.apply(null, dn), Math.max.apply(null, dn)];
    this.lenRange = [Math.min.apply(null, L), Math.max.apply(null, L)];
  };

  /** Build pipe surfaces, section lines and instance buffers for a geometry and body capacity. */
  Renderer.prototype.setGeometry = function (geom, refit, cap) {
    this.geom = geom;
    if (!this.ok) return;
    const clear = (grp) => { while (grp.children.length) { const c = grp.children.pop(); if (c.children && c.children.length) clear(c); c.geometry && c.geometry.dispose(); } };
    clear(this.pipe);
    const W = geom.wsegs, mats = geom.mats;
    this.wallMats = [];
    this.lineMat = new THREE.LineBasicMaterial({ color: this.colors.wallLine });
    this.outline = new THREE.Group(); this.pipe.add(this.outline);
    for (let i = 0; i + 3 < W.length; i += 4) {
      const q = W.slice(i, i + 4);
      const pts = q.map(s => new THREE.Vector2(Math.max(0, s.r1), -s.s1)); pts.push(pts[0].clone());
      const col = q[0].gate ? '#9aa3a8' : (q[0].feed ? '#9fb7c2' : (MAT_COL[mats[q[0].mat]] || '#6f8794'));
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, metalness: 0.05, transparent: true, opacity: this.opts.wallAlpha,
        side: THREE.DoubleSide, depthWrite: false, clippingPlanes: this.opts.cutaway ? this.clip : [] });
      this.wallMats.push(mat);
      const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 72), mat);
      mesh.renderOrder = 2;
      this.pipe.add(mesh);
      // section outline in the cut plane, both sides of the axis
      for (const sg of [1, -1]) {
        const g = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(sg * p.x, p.y, 0)));
        this.outline.add(new THREE.Line(g, this.lineMat));
      }
    }
    // axis line
    {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, geom.feedLen, 0), new THREE.Vector3(0, -geom.exitS, 0)]);
      const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color: this.colors.muted, dashSize: 0.15, gapSize: 0.1 }));
      l.computeLineDistances(); this.pipe.add(l);
    }
    this.buildInstances(cap || 200);
    if (refit || !this.fitted) { this.fit(); this.fitted = true; }
    this.render();
  };

  /** Unit superellipsoid |x|^p + |y|^p + |z|^p = 1 (radial projection of a sphere mesh): the exact body the engine fills with spheres. */
  function superGeo(p) {
    const g = new THREE.SphereGeometry(1, 40, 28), a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
      const t = Math.pow(Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p) + Math.pow(Math.abs(z), p), -1 / p);
      a.setXYZ(i, x * t, y * t, z * t);
    }
    g.computeVertexNormals();
    return g;
  }

  /** Set the block exponent; rebuilds the block mesh when it changes. */
  Renderer.prototype.setShape = function (pBlock) {
    if (!this.ok || !(pBlock > 0) || Math.abs((this.pBlock || 0) - pBlock) < 1e-3) return;
    this.pBlock = pBlock;
    if (this.inst) { const old = this.inst.block, geo = superGeo(pBlock); old.geometry.dispose(); old.geometry = geo; }
  };

  Renderer.prototype.buildInstances = function (cap) {
    if (this.inst && cap <= this.cap) return;
    if (this.inst) Object.values(this.inst).forEach(m => { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
    const MAXS = FP.shapes3d.MAXS;
    const mk = (geo, n) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 }), n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false;
      m.setColorAt(0, new THREE.Color(1, 1, 1));   // allocates the colour buffer for all n instances (uses count)
      m.count = 0;
      this.scene.add(m); return m;
    };
    this.inst = {
      block: mk(superGeo(this.pBlock || 2.33), cap),
      round: mk(new THREE.SphereGeometry(1, 24, 16), cap),
      sph: mk(new THREE.SphereGeometry(1, 12, 8), cap * MAXS)
    };
    this.cap = cap;
  };

  Renderer.prototype.resize = function () {
    if (!this.ok) return false;
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; this.gl.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    return true;
  };

  Renderer.prototype.applyCamera = function () {
    const c = this.cam, ce = Math.cos(c.el);
    this.camera.position.set(c.tx + c.dist * ce * Math.sin(c.az), c.ty + c.dist * Math.sin(c.el), c.tz + c.dist * ce * Math.cos(c.az));
    this.camera.lookAt(c.tx, c.ty, c.tz);
    // cutaway faces the camera: remove the half of the pipe between the axis and the viewer
    const n = new THREE.Vector3(-Math.sin(c.az), 0, -Math.cos(c.az));
    this.clip[0].normal.copy(n); this.clip[0].constant = 0;
    if (this.outline) this.outline.rotation.y = c.az;   // section outline lies in the cut plane
  };

  Renderer.prototype.fit = function () {
    if (!this.geom) return;
    this.resize();
    const g = this.geom, top = g.feedLen, bot = g.exitS, H = top + bot;
    const c = this.cam;
    c.tx = 0; c.tz = 0; c.ty = (top - bot) / 2;
    const fov = 35 * Math.PI / 180, asp = this.camera ? this.camera.aspect : 1;
    const needH = H * 1.08, needW = (g.rOuter * 2 + 0.6) * 1.1;
    c.dist = Math.max(needH / (2 * Math.tan(fov / 2)), needW / (2 * Math.tan(fov / 2) * asp));
    this.render();
  };
  Renderer.prototype.view = function (name) {
    const c = this.cam;
    if (name === 'side') { c.az = 0; c.el = 0; }
    else if (name === 'iso') { c.az = 0.55; c.el = 0.28; }
    else if (name === 'top') { c.az = 0; c.el = Math.PI / 2 - 0.02; }
    else if (name === 'bottom') { c.az = 0; c.el = -Math.PI / 2 + 0.02; }
    this.fit();
  };
  /** Centre on axial position s (local, m) with a field of about span metres. */
  Renderer.prototype.zoomTo = function (s, span) {
    const c = this.cam; c.tx = 0; c.tz = 0; c.ty = -s;
    c.dist = span / (2 * Math.tan(35 * Math.PI / 360)) * 1.4;
    this.render();
  };

  Renderer.prototype.bindInput = function () {
    const cv = this.cv, c = this.cam, self = this;
    let drag = null; const ptrs = new Map();
    const pan = (dx, dy) => {
      const k = c.dist * 0.0016;
      const right = new THREE.Vector3(Math.cos(c.az), 0, -Math.sin(c.az));
      const up = new THREE.Vector3(-Math.sin(c.el) * Math.sin(c.az), Math.cos(c.el), -Math.sin(c.el) * Math.cos(c.az));
      c.tx += (-dx * right.x + dy * up.x) * k; c.ty += (-dx * right.y + dy * up.y) * k; c.tz += (-dx * right.z + dy * up.z) * k;
    };
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey || e.button === 1 };
      if (ptrs.size === 2) { const p = [...ptrs.values()]; drag.pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); drag.mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; }
      cv.style.cursor = 'grabbing';
    });
    cv.addEventListener('pointermove', e => {
      if (!drag || !ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2 && drag.pinch) {
        const p = [...ptrs.values()], d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
        c.dist = Math.max(0.3, Math.min(200, c.dist * drag.pinch / Math.max(1, d)));
        pan(mid.x - drag.mid.x, mid.y - drag.mid.y);
        drag.pinch = d; drag.mid = mid; self.render(); return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) pan(dx, dy);
      else { c.az -= dx * 0.008; c.el = Math.max(-1.55, Math.min(1.55, c.el + dy * 0.008)); }
      self.render();
    });
    const end = e => { ptrs.delete(e.pointerId); if (!ptrs.size) { drag = null; cv.style.cursor = ''; } else if (drag) drag.pinch = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', e => { e.preventDefault(); c.dist = Math.max(0.3, Math.min(200, c.dist * Math.exp(e.deltaY * 0.0012))); self.render(); }, { passive: false });
    cv.addEventListener('dblclick', () => self.fit());
  };

  Renderer.prototype.setWallAlpha = function (a) { this.opts.wallAlpha = a; (this.wallMats || []).forEach(m => { m.opacity = a; m.visible = a > 0.01; }); this.render(); };
  Renderer.prototype.setCutaway = function (on) { this.opts.cutaway = on; (this.wallMats || []).forEach(m => { m.clippingPlanes = on ? this.clip : []; m.needsUpdate = true; }); this.render(); };

  Renderer.prototype.render = function () {
    if (!this.ok || !this.resize()) return;
    this.applyCamera();
    this.gl.render(this.scene, this.camera);
  };

  /** Update stones and markers from the engine, then render. */
  Renderer.prototype.draw = function (eng, det, dv, cfg) {
    if (!this.ok) return;
    if (!this.inst || (eng && eng.cap > this.cap)) this.buildInstances(eng ? eng.cap : 200);
    if (!this.geom) { this.render(); return; }
    if (eng && eng.fac && eng.fac.pBlock) this.setShape(eng.fac.pBlock);
    const I = this.inst, O = this.opts, M = this.tmpM, C = this.tmpC;
    let nB = 0, nR = 0, nS = 0;
    // markers
    while (this.extras.children.length) { const ch = this.extras.children.pop(); ch.geometry && ch.geometry.dispose(); ch.material && ch.material.dispose(); }
    if (eng) {
      const g = this.geom, MAXS = FP.shapes3d.MAXS;
      const arch = det && det.arch;
      const member = new Set(arch ? arch.members : []);
      const vSt = cfg.detect.vStall;
      const dLo = this.sizeRange ? this.sizeRange[0] : 0.1, dHi = this.sizeRange ? this.sizeRange[1] : 1;
      const LR = this.lenRange || [0, 1];
      const vHi = dv && isFinite(dv.vTermMax) ? Math.max(0.5, dv.vTermMax * 1.3) : 6;
      const orange = new THREE.Color(this.colors.orange), grey = new THREE.Color(this.colors.muted);
      if (eng.dirty) eng.rebuildActive();
      for (let k = 0; k < eng.nActive; k++) {
        const b = eng.active[k];
        const sp = Math.sqrt(eng.vx[b] * eng.vx[b] + eng.vy[b] * eng.vy[b] + eng.vz[b] * eng.vz[b]);
        if (member.has(b)) C.copy(orange);
        else if (O.colorBy === 'velocity') C.setRGB.apply(C, cmapRGB(sp / vHi));
        else if (O.colorBy === 'state') C.copy(sp < vSt ? orange : grey);
        else if (O.colorBy === 'class') C.set(CLASS_COL[eng.cls[b]] || CLASS_COL[5]);
        else if (O.colorBy === 'length') C.setRGB.apply(C, cmapRGB(LR[1] > LR[0] ? (eng.L[b] - LR[0]) / (LR[1] - LR[0]) : 0.5));
        else C.setRGB.apply(C, cmapRGB(dHi > dLo ? (Math.log(eng.d[b]) - Math.log(dLo)) / (Math.log(dHi) - Math.log(dLo)) : 0.5));
        // engine rotation (body -> pipe frame), mapped to the display frame (x, -z, y)
        const qw = eng.qw[b], qx = eng.qx[b], qy = eng.qy[b], qz = eng.qz[b];
        const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
        const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
        const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
        const X = eng.px[b], Y = -eng.pz[b], Z = eng.py[b];
        if (O.showSpheres) {
          const o = b * MAXS;
          for (let i = 0; i < eng.subCount[b]; i++) {
            const ox = eng.sox[o + i], oy = eng.soy[o + i], oz = eng.soz[o + i], r = eng.sr[o + i];
            const wx = r00 * ox + r01 * oy + r02 * oz, wy = r10 * ox + r11 * oy + r12 * oz, wz = r20 * ox + r21 * oy + r22 * oz;
            M.set(r, 0, 0, X + wx, 0, r, 0, Y - wz, 0, 0, r, Z + wy, 0, 0, 0, 1);
            I.sph.setMatrixAt(nS, M); I.sph.setColorAt(nS, C); nS++;
          }
          continue;
        }
        const box = eng.boxLike[b], h3 = 3 * b;
        const sx = eng.half[h3], sy = eng.half[h3 + 1], sz = eng.half[h3 + 2];   // unit meshes scaled by the half axes
        // display rows: x -> row0, y_disp = -z_eng -> -row2, z_disp = y_eng -> row1
        M.set(r00 * sx, r01 * sy, r02 * sz, X,
          -r20 * sx, -r21 * sy, -r22 * sz, Y,
          r10 * sx, r11 * sy, r12 * sz, Z,
          0, 0, 0, 1);
        if (box) { I.block.setMatrixAt(nB, M); I.block.setColorAt(nB, C); nB++; }
        else { I.round.setMatrixAt(nR, M); I.round.setColorAt(nR, C); nR++; }
      }
      // water levels
      const wt = eng.water;
      if (O.showWater && wt && wt.freeSurface) {
        const s0g = g.s0Global || 0;
        const sIn = (wt.on ? wt.surfS : wt.sW) - s0g, sOut = wt.sW - s0g;
        if (sIn > -g.feedLen && sIn < g.exitS) {
          const r = g.widthAt(Math.min(sIn, g.L)) / 2;
          const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), new THREE.MeshBasicMaterial({ color: 0x2a8bd6, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
          m.rotation.x = -Math.PI / 2; m.position.y = -sIn; m.renderOrder = 3; this.extras.add(m);
        }
        if (sOut > -g.feedLen && sOut < g.exitS) {
          const r = g.widthAt(Math.min(sOut, g.L)) / 2 + 0.06;
          const m = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.7, 48), new THREE.MeshBasicMaterial({ color: 0x2a8bd6, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
          m.rotation.x = -Math.PI / 2; m.position.y = -sOut; m.renderOrder = 3; this.extras.add(m);
        }
      }
      // spanning dome marker
      if (arch) {
        const r = g.widthAt(Math.max(0, Math.min(arch.s, g.L))) / 2;
        const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.025, 8, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(det.level >= 3 ? this.colors.red : this.colors.orange) }));
        m.rotation.x = Math.PI / 2; m.position.y = -arch.s; this.extras.add(m);
      }
      // gravity direction when the pipe is tilted (arrow beside the pipe)
      const gg = g.gAt(g.L / 2);
      if (Math.abs(gg[0]) > 1e-3) {
        const dir = new THREE.Vector3(gg[0], -gg[1], 0).normalize();
        const ar = new THREE.ArrowHelper(dir, new THREE.Vector3(g.rOuter + 0.5, -g.L * 0.15, 0), 1.0, new THREE.Color(this.colors.accent).getHex(), 0.25, 0.12);
        this.extras.add(ar);
      }
    }
    I.block.count = nB; I.round.count = nR; I.sph.count = nS;
    [I.block, I.round, I.sph].forEach(m => { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    this.render();
  };

  FP.render3d = { Renderer, cmap, CLASS_COL };
})(self.FP = self.FP || {});
