// Deterministic editing operations. Each op takes an image and returns a new one,
// so history can be replayed at preview or full resolution.
import {
  clamp01, smoothstep, lum, createImg, cloneImg, resizeMask, resizeRGBA, sampleRGBA, boxBlur, gaussBlur, guidedFilter,
  fillPolygon, fillEllipse, scalePoly, polygonArea,
} from './raster.js';
import { applyRetouch, applyMakeup, applyReshape } from './face-ops.js';

// ---------------------------------------------------------------- looks
export const LOOKS = {
  natural: { label: 'Natural', p: { contrast: 6, saturation: 4, clarity: 6 } },
  studio: { label: 'Studio', p: { contrast: 14, highlights: -14, shadows: 10, clarity: 12 } },
  warm: { label: 'Warm office', p: { warmth: 16, saturation: 4, highlights: -8, brightness: 4 } },
  cool: { label: 'Corporate cool', p: { warmth: -14, tint: -3, contrast: 10, saturation: -4 } },
  matte: { label: 'Soft matte', p: { contrast: -14, shadows: 24, saturation: -10, highlights: -6 } },
  golden: { label: 'Golden hour', p: { warmth: 26, tint: 5, highlights: -12, vignette: 18, saturation: 6 } },
  crisp: { label: 'Crisp', p: { clarity: 22, sharpen: 30, contrast: 8 } },
  mono: { label: 'Classic B&W', p: { saturation: -100, contrast: 16, clarity: 10 } },
};

export const ADJUSTMENTS = [
  { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'warmth', label: 'Warmth', min: -100, max: 100 },
  { key: 'tint', label: 'Tint', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 100 },
  { key: 'vignette', label: 'Vignette', min: -100, max: 100 },
];

export function applyOp(img, op, ctx) {
  switch (op.type) {
    case 'adjust': return applyAdjust(img, op.params, ctx);
    case 'look': return applyLook(img, op.params, ctx);
    case 'retouch': return applyRetouch(img, op.params, ctx);
    case 'makeup': return applyMakeup(img, op.params, ctx);
    case 'reshape': return applyReshape(img, op.params, ctx);
    case 'background': return applyBackground(img, op.params, ctx);
    case 'aiComposite': return applyAiComposite(img, op.params, ctx);
    case 'frame': return img; // framing is applied at display/export time
    default: throw new Error(`Unknown op ${op.type}`);
  }
}

// ---------------------------------------------------------------- adjust
export function applyLook(img, { look, intensity = 100 }, ctx) {
  const preset = LOOKS[look];
  if (!preset) return cloneImg(img);
  const k = intensity / 100;
  const p = {};
  for (const [key, v] of Object.entries(preset.p)) p[key] = v * k;
  return applyAdjust(img, p, ctx);
}

export function applyAdjust(img, params) {
  const P = (k) => (params?.[k] || 0) / 100;
  const br = P('brightness'); const co = P('contrast'); const hl = P('highlights'); const sh = P('shadows');
  const wa = P('warmth'); const ti = P('tint'); const sa = P('saturation'); const cl = P('clarity');
  const sp = P('sharpen'); const vg = P('vignette');
  const { width: w, height: h } = img;
  const out = createImg(w, h);
  const s = img.data; const d = out.data;
  const rM = (1 + 0.12 * wa) * (1 + 0.03 * ti); const gM = (1 + 0.02 * wa) * (1 - 0.08 * ti); const bM = (1 - 0.12 * wa) * (1 + 0.03 * ti);
  const bExp = 1 + 1.1 * Math.abs(br);
  const cK = 1 + 0.85 * co;
  const needLocal = Math.abs(cl) > 0.001 || sp > 0.001;
  const Y = needLocal ? new Float32Array(w * h) : null;
  const cx = w / 2; const cy = h / 2; const inv = 1 / Math.hypot(cx, cy);

  // brightness curve via LUT
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lut[i] = br >= 0 ? 1 - Math.pow(1 - v, bExp) : Math.pow(v, bExp);
  }

  for (let i = 0, p = 0; i < s.length; i += 4, p++) {
    let r = lut[s[i]] * rM; let g = lut[s[i + 1]] * gM; let b = lut[s[i + 2]] * bM;
    if (co !== 0) { r = (r - 0.5) * cK + 0.5; g = (g - 0.5) * cK + 0.5; b = (b - 0.5) * cK + 0.5; }
    let y = lum(r, g, b);
    if (hl !== 0 || sh !== 0) {
      const yc = clamp01(y);
      const dy = 0.24 * (hl * smoothstep(0.45, 1, yc) + sh * (1 - smoothstep(0, 0.55, yc)));
      if (y > 0.004) { const k = (y + dy) / y; r *= k; g *= k; b *= k; } else { r += dy; g += dy; b += dy; }
      y += dy;
    }
    if (sa !== 0) { const k = 1 + sa; r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k; }
    if (vg !== 0) {
      const x = p % w; const yy = (p / w) | 0;
      const dd = Math.hypot(x - cx, yy - cy) * inv;
      const f = 1 - vg * 0.5 * smoothstep(0.35, 1.05, dd);
      r *= f; g *= f; b *= f;
    }
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255; d[i + 3] = s[i + 3];
    if (Y) Y[p] = lum(d[i], d[i + 1], d[i + 2]) / 255;
  }

  if (needLocal) {
    const minDim = Math.min(w, h);
    let target = null;
    if (Math.abs(cl) > 0.001) {
      const blurY = gaussBlur(Y, w, h, Math.max(2, minDim * 0.012));
      target = new Float32Array(Y.length);
      for (let p = 0; p < Y.length; p++) {
        const y = Y[p];
        target[p] = y + cl * 0.9 * (4 * y * (1 - y)) * (y - blurY[p]);
      }
    }
    const base = target || Y;
    let final = base;
    if (sp > 0.001) {
      const r = Math.max(1, Math.round(minDim / 1600));
      const blurS = boxBlur(boxBlur(base, w, h, r), w, h, r);
      final = new Float32Array(base.length);
      for (let p = 0; p < base.length; p++) final[p] = base[p] + sp * 1.4 * (base[p] - blurS[p]);
    }
    for (let i = 0, p = 0; p < Y.length; i += 4, p++) {
      const y0 = Y[p];
      const y1 = final[p];
      if (y0 > 0.002) {
        const k = y1 / y0;
        d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
      } else {
        const add = (y1 - y0) * 255; d[i] += add; d[i + 1] += add; d[i + 2] += add;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- face edits live in face-ops.js
export { RETOUCH_ITEMS, SKIN_LOOKS, MAKEUP_ITEMS, SHAPE_ITEMS } from './face-ops.js';

// ---------------------------------------------------------------- background replacement
export const STUDIO_COLOURS = {
  cream: { label: 'Cream', inner: [246, 238, 229], outer: [222, 207, 192] },
  grey: { label: 'Light grey', inner: [228, 229, 231], outer: [186, 189, 194] },
  blue: { label: 'Soft blue', inner: [214, 224, 235], outer: [160, 178, 199] },
  plum: { label: 'Plum', inner: [124, 82, 94], outer: [72, 40, 50] },
  white: { label: 'White', inner: [252, 252, 251], outer: [236, 235, 233] },
};

export function applyBackground(img, params, ctx) {
  const { width: w, height: h } = img;
  const matte = ctx.assets[params.matte];
  if (!matte) return cloneImg(img);
  const minDim = Math.min(w, h);
  let alpha = resizeMask(matte, w, h);

  const edge = (params.edge || 0) / 100;
  if (edge < 0) {
    const lo = -edge * 0.55;
    for (let p = 0; p < alpha.length; p++) alpha[p] = smoothstep(lo, 1, alpha[p]);
  } else if (edge > 0) {
    alpha = gaussBlur(alpha, w, h, Math.max(1, edge * minDim * 0.006));
  }

  // Estimate the original background behind soft edges (normalised convolution at low res),
  // so hair edges don't keep a halo of the old background.
  const sk = Math.min(1, 640 / Math.max(w, h));
  const sw = Math.max(8, Math.round(w * sk)); const shh = Math.max(8, Math.round(h * sk));
  const small = resizeRGBA(img, sw, shh);
  const aSmall = resizeMask({ width: w, height: h, data: alpha }, sw, shh);
  const bgEst = estimateBackground(small, aSmall, Math.max(3, Math.round(Math.min(sw, shh) * 0.03)));

  // New background at full size.
  const bg = buildBackground(params, ctx, w, h, small, aSmall, bgEst);

  // Optional subtle light matching of the person toward the new scene.
  let shift = [0, 0, 0];
  const lm = (params.light || 0) / 100;
  if (lm > 0) {
    let pr = 0; let pg = 0; let pb = 0; let pn = 0; let br = 0; let bgc = 0; let bb = 0; let bn = 0;
    const step = Math.max(1, Math.floor((w * h) / 40000));
    for (let p = 0; p < w * h; p += step) {
      const i = p * 4;
      if (alpha[p] > 0.9) { pr += img.data[i]; pg += img.data[i + 1]; pb += img.data[i + 2]; pn++; }
      br += bg.data[i]; bgc += bg.data[i + 1]; bb += bg.data[i + 2]; bn++;
    }
    if (pn && bn) {
      shift = [(br / bn - pr / pn) * 0.14 * lm, (bgc / bn - pg / pn) * 0.14 * lm, (bb / bn - pb / pn) * 0.14 * lm];
    }
  }

  const out = createImg(w, h);
  const s = img.data; const d = out.data; const bd = bg.data;
  const fx = sw / w; const fy = shh / h;
  const est = [0, 0, 0, 0];
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const i = p * 4;
      const a = alpha[p];
      if (a >= 0.995) {
        d[i] = s[i] + shift[0]; d[i + 1] = s[i + 1] + shift[1]; d[i + 2] = s[i + 2] + shift[2]; d[i + 3] = 255;
        continue;
      }
      if (a <= 0.005) {
        d[i] = bd[i]; d[i + 1] = bd[i + 1]; d[i + 2] = bd[i + 2]; d[i + 3] = 255;
        continue;
      }
      sampleRGBA(bgEst, (x + 0.5) * fx, (y + 0.5) * fy, est);
      const ia = 1 / Math.max(a, 0.08);
      const Fr = Math.min(255, Math.max(0, (s[i] - (1 - a) * est[0]) * ia)) + shift[0];
      const Fg = Math.min(255, Math.max(0, (s[i + 1] - (1 - a) * est[1]) * ia)) + shift[1];
      const Fb = Math.min(255, Math.max(0, (s[i + 2] - (1 - a) * est[2]) * ia)) + shift[2];
      d[i] = Fr * a + bd[i] * (1 - a); d[i + 1] = Fg * a + bd[i + 1] * (1 - a); d[i + 2] = Fb * a + bd[i + 2] * (1 - a); d[i + 3] = 255;
    }
  }
  return out;
}

function estimateBackground(small, aSmall, r) {
  const { width: w, height: h, data } = small;
  const n = w * h;
  const wgt = new Float32Array(n); const cr = new Float32Array(n); const cg = new Float32Array(n); const cb = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const k = Math.pow(1 - aSmall[p], 3);
    wgt[p] = k; cr[p] = data[p * 4] * k; cg[p] = data[p * 4 + 1] * k; cb[p] = data[p * 4 + 2] * k;
  }
  let W = wgt; let Rr = cr; let Gg = cg; let Bb = cb;
  // grow the estimate inward over several passes so it covers the person area
  for (let pass = 0; pass < 3; pass++) {
    const rr = r * (pass + 1);
    W = gaussBlur(W, w, h, rr); Rr = gaussBlur(Rr, w, h, rr); Gg = gaussBlur(Gg, w, h, rr); Bb = gaussBlur(Bb, w, h, rr);
  }
  const out = createImg(w, h);
  for (let p = 0; p < n; p++) {
    const k = W[p] > 1e-4 ? 1 / W[p] : 0;
    out.data[p * 4] = k ? Rr[p] * k : data[p * 4];
    out.data[p * 4 + 1] = k ? Gg[p] * k : data[p * 4 + 1];
    out.data[p * 4 + 2] = k ? Bb[p] * k : data[p * 4 + 2];
    out.data[p * 4 + 3] = 255;
  }
  return out;
}

function buildBackground(params, ctx, w, h, small, aSmall, bgEst) {
  const blur = (params.blur || 0) / 100;
  if (params.mode === 'flat') {
    const v = parseInt(String(params.hex || '#ffffff').replace('#', ''), 16);
    const out = createImg(w, h);
    for (let i = 0; i < out.data.length; i += 4) {
      out.data[i] = (v >> 16) & 255; out.data[i + 1] = (v >> 8) & 255; out.data[i + 2] = v & 255; out.data[i + 3] = 255;
    }
    return out;
  }
  if (params.mode === 'color') {
    const c = STUDIO_COLOURS[params.color] || STUDIO_COLOURS.cream;
    const out = createImg(w, h);
    const cx = w * 0.5; const cy = h * 0.42; const R = Math.hypot(w, h) * 0.62;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const t = smoothstep(0, 1, Math.min(1, Math.hypot(x - cx, y - cy) / R));
        const n = ((x * 12.9898 + y * 78.233) % 1) * 1.2 - 0.6; // tiny dither against banding
        out.data[i] = c.inner[0] + (c.outer[0] - c.inner[0]) * t + n;
        out.data[i + 1] = c.inner[1] + (c.outer[1] - c.inner[1]) * t + n;
        out.data[i + 2] = c.inner[2] + (c.outer[2] - c.inner[2]) * t + n;
        out.data[i + 3] = 255;
      }
    }
    return out;
  }
  if (params.mode === 'blur') {
    // Defocus the original scene (with the person removed so no halo bleeds in).
    const k = 0.012 + 0.05 * Math.max(0.15, blur);
    const est = blurRGBA(bgEst, Math.max(1, Math.min(bgEst.width, bgEst.height) * k));
    return resizeRGBA(est, w, h);
  }
  const src = ctx.assets[params.bg];
  if (!src) return resizeRGBA(bgEst, w, h);
  // cover-fit crop of the backdrop
  const scale = Math.max(w / src.width, h / src.height);
  const cw = w / scale; const ch = h / scale;
  const ox = (src.width - cw) / 2; const oy = (src.height - ch) * 0.4;
  if (blur > 0.001) {
    const tw = Math.min(1024, Math.round(cw)); const th = Math.max(1, Math.round(tw * ch / cw));
    const crop = cropResize(src, ox, oy, cw, ch, tw, th);
    const b = blurRGBA(crop, Math.max(1, Math.min(tw, th) * 0.025 * blur));
    return resizeRGBA(b, w, h);
  }
  return cropResize(src, ox, oy, cw, ch, w, h);
}

function cropResize(src, ox, oy, cw, ch, w, h) {
  let s = src;
  // Pre-shrink when the crop is much larger than the target, to avoid aliasing.
  if (cw > 2 * w) {
    const f = (2 * w) / cw;
    s = resizeRGBA(src, Math.max(1, Math.round(src.width * f)), Math.max(1, Math.round(src.height * f)));
    ox *= f; oy *= f; cw *= f; ch *= f;
  }
  const out = createImg(w, h);
  const px = [0, 0, 0, 0];
  const sx = cw / w; const sy = ch / h;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      sampleRGBA(s, ox + (x + 0.5) * sx, oy + (y + 0.5) * sy, px);
      out.data[i] = px[0]; out.data[i + 1] = px[1]; out.data[i + 2] = px[2]; out.data[i + 3] = 255;
    }
  }
  return out;
}

export function blurRGBA(img, sigma) {
  const { width: w, height: h } = img;
  const n = w * h;
  const out = createImg(w, h);
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(n);
    for (let p = 0; p < n; p++) plane[p] = img.data[p * 4 + c];
    const b = gaussBlur(plane, w, h, sigma);
    for (let p = 0; p < n; p++) out.data[p * 4 + c] = b[p];
  }
  for (let p = 0; p < n; p++) out.data[p * 4 + 3] = 255;
  return out;
}

// ---------------------------------------------------------------- AI composite
// Blend an aligned AI result into the photo only where its region mask allows.
export function applyAiComposite(img, params, ctx) {
  const res = ctx.assets[params.result]; const mask = ctx.assets[params.mask];
  if (!res || !mask) return cloneImg(img);
  const s = img.width / ctx.fullWidth;
  const out = cloneImg(img);
  const rx = params.roi.x * s; const ry = params.roi.y * s; const rw = params.roi.w * s; const rh = params.roi.h * s;
  const x0 = Math.max(0, Math.floor(rx)); const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(img.width, Math.ceil(rx + rw)); const y1 = Math.min(img.height, Math.ceil(ry + rh));
  const px = [0, 0, 0, 0];
  const mw = mask.width; const mh = mask.height; const md = mask.data;
  const mScale = md instanceof Float32Array ? 1 : 1 / 255;
  for (let y = y0; y < y1; y++) {
    const v = ((y + 0.5 - ry) / rh);
    for (let x = x0; x < x1; x++) {
      const u = ((x + 0.5 - rx) / rw);
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;
      // mask (bilinear)
      let fx = u * mw - 0.5; let fy = v * mh - 0.5;
      if (fx < 0) fx = 0; if (fy < 0) fy = 0; if (fx > mw - 1) fx = mw - 1; if (fy > mh - 1) fy = mh - 1;
      const mx0 = fx | 0; const my0 = fy | 0; const mx1 = Math.min(mw - 1, mx0 + 1); const my1 = Math.min(mh - 1, my0 + 1);
      const ax = fx - mx0; const ay = fy - my0;
      const top = md[my0 * mw + mx0] + (md[my0 * mw + mx1] - md[my0 * mw + mx0]) * ax;
      const bot = md[my1 * mw + mx0] + (md[my1 * mw + mx1] - md[my1 * mw + mx0]) * ax;
      const m = (top + (bot - top) * ay) * mScale;
      if (m <= 0.003) continue;
      sampleRGBA(res, u * res.width, v * res.height, px);
      const i = (y * img.width + x) * 4;
      out.data[i] = img.data[i] + (px[0] - img.data[i]) * m;
      out.data[i + 1] = img.data[i + 1] + (px[1] - img.data[i + 1]) * m;
      out.data[i + 2] = img.data[i + 2] + (px[2] - img.data[i + 2]) * m;
    }
  }
  return out;
}
