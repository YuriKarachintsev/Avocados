// Canvas view: fit-to-stage drawing, pinch/wheel zoom, hold-to-compare,
// split before/after slider, crop-frame editing and face selection.
import { h } from '../ui.js';

export class View {
  constructor(stage, canvas) {
    this.stage = stage;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.after = null; this.before = null;
    this.fullW = 1; this.fullH = 1; this.pScale = 1; this.pScaleBefore = 1;
    this.frame = null; // rect in full-res coords for display (null = whole photo)
    this.mode = 'normal';
    this.split = false; this.splitPos = 0.5;
    this.holding = false;
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.pointers = new Map();
    this.cropFrame = null; this.onCropChange = null;
    this.faceLayer = h('div', { class: 'overlay interactive', hidden: true });
    this.splitHandle = h('div', { class: 'split-handle', role: 'slider', tabindex: '0', 'aria-label': 'Before and after divider', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true });
    this.labelBefore = h('div', { class: 'split-label', hidden: true }, 'Before');
    this.labelAfter = h('div', { class: 'split-label', hidden: true }, 'After');
    this.badge = h('div', { class: 'badge-before', hidden: true }, 'Original');
    this.cropEl = h('div', { class: 'crop-frame', hidden: true });
    stage.append(this.faceLayer, this.cropEl, this.splitHandle, this.labelBefore, this.labelAfter, this.badge);
    this.bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(stage);
    this.resize();
  }

  resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const r = this.stage.getBoundingClientRect();
    this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.dpr = dpr;
    this.draw();
  }

  // Display size the preview should be rendered at (device pixels).
  previewLongSide() {
    return Math.min(2048, Math.round(Math.max(this.cssW, this.cssH) * Math.min(2, this.dpr || 1) * 1.15));
  }

  setImages({ after, before, fullW, fullH, pScale, pScaleBefore }) {
    if (after !== undefined) this.after = after;
    if (before !== undefined) this.before = before;
    if (fullW) { this.fullW = fullW; this.fullH = fullH; }
    if (pScale) this.pScale = pScale;
    if (pScaleBefore) this.pScaleBefore = pScaleBefore;
    this.draw();
  }

  setFrame(rect) { this.frame = rect; this.draw(); }

  setMode(mode) {
    this.mode = mode;
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.cropEl.hidden = mode !== 'crop';
    this.draw();
  }

  setSplit(on) {
    this.split = on;
    this.splitHandle.hidden = !on; this.labelBefore.hidden = !on; this.labelAfter.hidden = !on;
    this.draw();
  }

  setHolding(on) {
    this.holding = on;
    this.badge.hidden = !on;
    this.draw();
  }

  // Source rectangle (full-res coords) currently shown.
  sourceRect() {
    if (this.mode === 'crop' || !this.frame) return { x: 0, y: 0, w: this.fullW, h: this.fullH };
    return this.frame;
  }

  layout() {
    const src = this.sourceRect();
    const pad = this.mode === 'crop' ? 22 : 14;
    const k = Math.min((this.cssW - pad * 2) / src.w, (this.cssH - pad * 2) / src.h) * this.zoom;
    const w = src.w * k; const h = src.h * k;
    const x = (this.cssW - w) / 2 + this.panX; const y = (this.cssH - h) / 2 + this.panY;
    return { src, k, x, y, w, h };
  }

  imageToScreen(ix, iy) {
    const L = this.layout();
    return [L.x + (ix - L.src.x) * L.k, L.y + (iy - L.src.y) * L.k];
  }

  screenToImage(sx, sy) {
    const L = this.layout();
    return [L.src.x + (sx - L.x) / L.k, L.src.y + (sy - L.y) / L.k];
  }

  draw() {
    const g = this.ctx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.after) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const L = this.layout();
    const blit = (bmp, ps, clipX0 = 0, clipX1 = 1) => {
      if (!bmp) return;
      g.save();
      g.beginPath();
      g.rect(L.x + L.w * clipX0, L.y, L.w * (clipX1 - clipX0), L.h);
      g.clip();
      g.drawImage(bmp, L.src.x * ps, L.src.y * ps, L.src.w * ps, L.src.h * ps, L.x, L.y, L.w, L.h);
      g.restore();
    };
    g.save();
    g.shadowColor = 'rgba(57,30,33,0.25)';
    g.shadowBlur = 18;
    g.shadowOffsetY = 6;
    g.fillStyle = '#fff';
    g.fillRect(L.x, L.y, L.w, L.h);
    g.restore();
    if (this.holding) {
      blit(this.before, this.pScaleBefore);
    } else if (this.split && this.mode !== 'crop') {
      blit(this.before, this.pScaleBefore, 0, this.splitPos);
      blit(this.after, this.pScale, this.splitPos, 1);
      const hx = L.x + L.w * this.splitPos;
      this.splitHandle.style.left = `${hx}px`;
      this.splitHandle.setAttribute('aria-valuenow', String(Math.round(this.splitPos * 100)));
      this.labelBefore.style.left = `${Math.max(8, L.x + 10)}px`;
      this.labelAfter.style.left = `${Math.min(this.cssW - 60, L.x + L.w - 62)}px`;
    } else {
      blit(this.after, this.pScale);
    }
    if (this.mode === 'crop' && this.cropFrame) {
      const [x0, y0] = this.imageToScreen(this.cropFrame.x, this.cropFrame.y);
      Object.assign(this.cropEl.style, { left: `${x0}px`, top: `${y0}px`, width: `${this.cropFrame.w * L.k}px`, height: `${this.cropFrame.h * L.k}px` });
    }
    this.positionFaces();
  }

  // ------------------------------------------------------------ faces
  showFaces(faces, selected, onSelect) {
    this.faces = faces; this.selectedFace = selected; this.onFaceSelect = onSelect;
    this.faceLayer.replaceChildren();
    if (!faces || faces.length < 2) { this.faceLayer.hidden = true; return; }
    this.faceLayer.hidden = false;
    faces.forEach((f, i) => {
      const b = h('button', { type: 'button', class: `face-box ${i === selected ? 'selected' : ''}`, 'aria-label': `Select face ${i + 1}`, 'aria-pressed': i === selected ? 'true' : 'false' });
      if (i === selected) b.append(h('span', {}, 'Editing this face'));
      b.addEventListener('click', (e) => { e.stopPropagation(); onSelect?.(i); });
      this.faceLayer.append(b);
    });
    this.positionFaces();
  }

  hideFaces() { this.faceLayer.hidden = true; }

  positionFaces() {
    if (this.faceLayer.hidden || !this.faces) return;
    [...this.faceLayer.children].forEach((el, i) => {
      const f = this.faces[i];
      const [x, y] = this.imageToScreen(f.box.x, f.box.y);
      const L = this.layout();
      Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${f.box.w * L.k}px`, height: `${f.box.h * L.k}px` });
    });
  }

  // ------------------------------------------------------------ interaction
  bind() {
    const st = this.stage;
    let holdTimer = null; let moved = false; let start = null; let lastTap = 0;
    let pinch = null; let drag = null;

    const local = (e) => { const r = st.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    st.addEventListener('pointerdown', (e) => {
      if (!this.after) return;
      if (e.target.closest('.face-box, .split-handle, button, input')) return;
      st.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, local(e));
      moved = false;
      start = local(e);
      if (this.pointers.size === 2) {
        clearTimeout(holdTimer);
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.zoom, cropZoom: this.cropFrameParams?.zoom || 1 };
        return;
      }
      if (this.mode === 'crop') {
        drag = { p: start, frame: { ...this.cropFrameParams } };
        return;
      }
      drag = { p: start, panX: this.panX, panY: this.panY };
      holdTimer = setTimeout(() => { if (!moved && !this.split) this.setHolding(true); }, 260);
    });

    st.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      if (start && Math.hypot(p[0] - start[0], p[1] - start[1]) > 6) { moved = true; clearTimeout(holdTimer); }
      if (pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (this.mode === 'crop') this.updateCrop({ zoom: Math.min(4, Math.max(1, pinch.cropZoom * (d / pinch.d))) });
        else { this.zoom = Math.min(6, Math.max(1, pinch.zoom * (d / pinch.d))); if (this.zoom === 1) { this.panX = 0; this.panY = 0; } this.draw(); }
        return;
      }
      if (!drag || !moved) return;
      if (this.mode === 'crop') {
        const L = this.layout();
        const dx = (p[0] - drag.p[0]) / L.k; const dy = (p[1] - drag.p[1]) / L.k;
        this.updateCrop({ cx: drag.frame.cx + dx, cy: drag.frame.cy + dy });
      } else if (this.zoom > 1) {
        this.panX = drag.panX + (p[0] - drag.p[0]); this.panY = drag.panY + (p[1] - drag.p[1]);
        this.draw();
      }
    });

    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      clearTimeout(holdTimer);
      if (this.holding) this.setHolding(false);
      if (this.pointers.size < 2) pinch = null;
      if (this.pointers.size === 0) {
        if (!moved && this.mode !== 'crop' && e.type === 'pointerup') {
          const now = Date.now();
          if (now - lastTap < 300) { // double-tap: toggle zoom
            if (this.zoom > 1) { this.zoom = 1; this.panX = 0; this.panY = 0; } else {
              this.zoom = 2.5;
              const [x, y] = local(e);
              this.panX = (this.cssW / 2 - x) * 1.5; this.panY = (this.cssH / 2 - y) * 1.5;
            }
            this.draw();
            lastTap = 0;
          } else lastTap = now;
        }
        drag = null;
      }
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
    st.addEventListener('lostpointercapture', end);

    st.addEventListener('wheel', (e) => {
      if (!this.after) return;
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0022);
      if (this.mode === 'crop') { this.updateCrop({ zoom: Math.min(4, Math.max(1, (this.cropFrameParams?.zoom || 1) * f)) }); return; }
      const [x, y] = local(e);
      const nz = Math.min(6, Math.max(1, this.zoom * f));
      const k = nz / this.zoom;
      this.panX = (this.panX - (x - this.cssW / 2)) * k + (x - this.cssW / 2);
      this.panY = (this.panY - (y - this.cssH / 2)) * k + (y - this.cssH / 2);
      this.zoom = nz;
      if (nz === 1) { this.panX = 0; this.panY = 0; }
      this.draw();
    }, { passive: false });

    // split handle
    const sh = this.splitHandle;
    let splitDrag = false;
    sh.addEventListener('pointerdown', (e) => { splitDrag = true; sh.setPointerCapture(e.pointerId); e.stopPropagation(); });
    sh.addEventListener('pointermove', (e) => {
      if (!splitDrag) return;
      const L = this.layout(); const [x] = local(e);
      this.splitPos = Math.min(1, Math.max(0, (x - L.x) / L.w));
      this.draw();
    });
    sh.addEventListener('pointerup', () => { splitDrag = false; });
    sh.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        this.splitPos = Math.min(1, Math.max(0, this.splitPos + (e.key === 'ArrowLeft' ? -0.05 : 0.05)));
        this.draw();
        e.preventDefault();
      }
    });
  }

  // ------------------------------------------------------------ crop
  setCrop(params, rectFn) {
    this.cropFrameParams = { ...params };
    this.rectFn = rectFn;
    this.cropFrame = rectFn(this.cropFrameParams);
    this.draw();
  }

  updateCrop(patch) {
    if (!this.cropFrameParams) return;
    Object.assign(this.cropFrameParams, patch);
    // keep the centre inside the photo
    this.cropFrame = this.rectFn(this.cropFrameParams);
    this.cropFrameParams.cx = this.cropFrame.x + this.cropFrame.w / 2;
    this.cropFrameParams.cy = this.cropFrame.y + this.cropFrame.h / 2;
    this.draw();
    this.onCropChange?.({ ...this.cropFrameParams });
  }
}
