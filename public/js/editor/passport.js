// Passport / ID photo maker. Works from the ORIGINAL photo — no retouching, makeup,
// reshaping or AI touches the face — then straightens, sizes the head to the official
// rule and crops to the official format at 600 dpi.
import { createImg, sampleRGBA } from '../engine/raster.js';
import { faceMetrics } from '../engine/face.js';
import { applyBackground } from '../engine/ops.js';
import { imgToCanvas, canvasToBlob } from './imageio.js';

const MM_PER_IN = 25.4;

// Sources (checked 25 Oct 2026): GOV.UK photo rules; travel.state.gov passport photos;
// u.ae (UAE passport documents); Schengen/ICAO figures as published by visa-photo guides citing EU rules.
export const PASSPORT_SPECS = {
  icao: {
    label: 'Schengen / ICAO 35×45 mm', short: 'Schengen 35×45', wMM: 35, hMM: 45, headMM: [32, 36], bg: '#ffffff',
    bgLabel: 'white or very light grey', editRule: 'No filters or retouching.', strict: false,
  },
  uk: {
    label: 'UK passport 35×45 mm', short: 'UK 35×45', wMM: 35, hMM: 45, headMM: [29, 34], bg: '#efede8',
    bgLabel: 'plain cream or light grey', editRule: 'GOV.UK: photos must be unaltered by computer software.', strict: true,
  },
  us: {
    label: 'USA passport 2×2 in', short: 'USA 2×2 in', wMM: 50.8, hMM: 50.8, headMM: [25, 35], bg: '#ffffff',
    bgLabel: 'plain white or off-white', editRule: 'travel.state.gov: no digital changes — no filters, apps or AI tools.', strict: true,
    noGlasses: true,
  },
  uae: {
    label: 'UAE passport 4.5×5.5 cm', short: 'UAE 4.5×5.5', wMM: 45, hMM: 55, headMM: [38.5, 44], bg: '#ffffff',
    bgLabel: 'plain white', editRule: 'Digitally altered photos are reported as not accepted.', strict: true,
    note: 'Official UAE pages give inconsistent sizes (4.5×5.5 cm, widths of 35–40 mm). Confirm with ICP or your typing centre before printing.',
  },
};

export function rotateImg(img, angle, cx, cy) {
  if (Math.abs(angle) < 1e-4) return img;
  const { width: w, height: h } = img;
  const out = createImg(w, h);
  const c = Math.cos(angle); const s = Math.sin(angle);
  const px = [0, 0, 0, 0];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      // inverse rotation: where did this output pixel come from?
      const dx = x + 0.5 - cx; const dy = y + 0.5 - cy;
      sampleRGBA(img, cx + c * dx - s * dy, cy + s * dx + c * dy, px);
      out.data[i] = px[0]; out.data[i + 1] = px[1]; out.data[i + 2] = px[2]; out.data[i + 3] = 255;
    }
  }
  return out;
}

const rotPt = ([x, y], angle, cx, cy) => {
  const c = Math.cos(-angle); const s = Math.sin(-angle);
  const dx = x - cx; const dy = y - cy;
  return [cx + c * dx - s * dy, cy + s * dx + c * dy];
};

function lumAt(img, x, y) {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / 255;
}

// Build the passport photo. getMask(img) must return a person mask {width,height,data} for img.
export async function makePassport({ original, faces, faceIndex = 0, specId, plainBackground, straighten = true, getMask }) {
  const spec = PASSPORT_SPECS[specId];
  const face = faces[faceIndex];
  const checks = [];
  if (!face) throw new Error('No face found. Use a clear, front-facing photo.');

  // 1. Straighten so the eyes are level.
  const m0 = faceMetrics(face.landmarks);
  const angle = straighten && Math.abs(m0.angle) > 0.003 && Math.abs(m0.angle) < 0.3 ? m0.angle : 0;
  const [ecx, ecy] = m0.eyeMid;
  const img = angle ? rotateImg(original, angle, ecx, ecy) : original;
  const lm = angle ? face.landmarks.map((p) => rotPt(p, angle, ecx, ecy)) : face.landmarks;
  const m = faceMetrics(lm);

  // 2. Person mask: used to find the top of the head and, if chosen, a plain background.
  const mask = await getMask(img);
  const mw = mask.width; const mh = mask.height; const kx = mw / img.width; const ky = mh / img.height;
  const alphaAt = (x, y) => {
    const ix = Math.min(mw - 1, Math.max(0, Math.round(x * kx))); const iy = Math.min(mh - 1, Math.max(0, Math.round(y * ky)));
    const v = mask.data[iy * mw + ix];
    return mask.data instanceof Float32Array ? v : v / 255;
  };
  const cx = (lm[27][0] + lm[30][0] + m.eyeMid[0]) / 3;
  let crownY = null;
  for (let y = 0; y < m.eyeMid[1]; y += 1) {
    let hit = 0; let tot = 0;
    for (let x = cx - m.faceW * 0.22; x <= cx + m.faceW * 0.22; x += Math.max(1, m.faceW / 60)) { tot++; if (alphaAt(x, y) > 0.5) hit++; }
    if (hit / tot > 0.35) { crownY = y; break; }
  }
  const chinY = lm[8][1];
  let headTopCut = false;
  if (crownY === null) crownY = m.eyeMid[1] - (chinY - m.eyeMid[1]) * 1.05; // fallback estimate
  if (crownY <= 2) headTopCut = true;
  const headPx = chinY - crownY;

  // 3. Geometry from the official head-size rule.
  const pxPerMM = 600 / MM_PER_IN;
  const outW = Math.round(spec.wMM * pxPerMM); const outH = Math.round(spec.hMM * pxPerMM);
  const headMM = (spec.headMM[0] + spec.headMM[1]) / 2;
  const k = headPx / (headMM * pxPerMM); // source px per output px
  const topGapMM = (spec.hMM - headMM) * 0.4;
  const crop = { w: outW * k, h: outH * k };
  crop.x = cx - crop.w / 2;
  crop.y = crownY - topGapMM * pxPerMM * k;

  // 4. Background.
  let src = img;
  let fill = spec.bg;
  if (plainBackground) {
    src = applyBackground(img, { mode: 'flat', hex: spec.bg, matte: 'm', edge: -10 }, { assets: { m: mask }, fullWidth: img.width });
  } else {
    // pad with the background colour nearest the edge that runs out (usually just above the head)
    const sx0 = Math.max(0, Math.floor(crop.x)); const sx1 = Math.min(img.width, Math.ceil(crop.x + crop.w));
    const band = crop.y < 0 ? [0, Math.max(4, Math.round(img.height * 0.03))] : [Math.round(img.height * 0.97), img.height];
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let y = band[0]; y < band[1]; y += 2) {
      for (let x = sx0; x < sx1; x += 4) {
        if (alphaAt(x, y) > 0.2) continue;
        const i = (y * img.width + x) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
    }
    if (n) fill = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const g = canvas.getContext('2d');
  g.fillStyle = fill;
  g.fillRect(0, 0, outW, outH);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const srcCanvas = imgToCanvas(src);
  g.drawImage(srcCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
  srcCanvas.width = 1; srcCanvas.height = 1;

  // 5. Checks (automatic, indicative — the authority makes the final decision).
  const eyeDist = Math.hypot(lm[45][0] - lm[36][0], lm[45][1] - lm[36][1]);
  const yaw = Math.abs(lm[30][0] - m.eyeMid[0]) / eyeDist;
  const ear = (a, b, c, d, e, f) => (Math.hypot(lm[b][0] - lm[f][0], lm[b][1] - lm[f][1]) + Math.hypot(lm[c][0] - lm[e][0], lm[c][1] - lm[e][1])) / (2 * Math.hypot(lm[a][0] - lm[d][0], lm[a][1] - lm[d][1]));
  const earL = ear(36, 37, 38, 39, 40, 41); const earR = ear(42, 43, 44, 45, 46, 47);
  const mouthGap = Math.hypot(lm[62][0] - lm[66][0], lm[62][1] - lm[66][1]) / (chinY - m.eyeMid[1]);
  let lL = 0; let lR = 0; let nL = 0; let nR = 0;
  for (let t = 0.15; t <= 0.85; t += 0.05) {
    const yL = lm[2][1] + (lm[4][1] - lm[2][1]) * t;
    lL += lumAt(img, lm[2][0] + (lm[30][0] - lm[2][0]) * 0.4, yL); nL++;
    lR += lumAt(img, lm[14][0] + (lm[30][0] - lm[14][0]) * 0.4, yL); nR++;
  }
  lL /= nL; lR /= nR;
  const balance = Math.min(lL, lR) / Math.max(lL, lR, 1e-3);
  const faceLum = (lL + lR) / 2;
  const upscale = 1 / k;

  const add = (status, text) => checks.push({ status, text });
  add('ok', 'Made from your original photo — no retouching, makeup or AI on your face.');
  add(faces.length === 1 ? 'ok' : 'warn', faces.length === 1 ? 'Only one person in the photo.' : `${faces.length} faces found — a passport photo must show only you.`);
  add('ok', `Head height set to ${headMM.toFixed(1)} mm (allowed ${spec.headMM[0]}–${spec.headMM[1]} mm).`);
  add(angle ? 'info' : 'ok', angle ? `Straightened by ${(Math.abs(angle) * 180 / Math.PI).toFixed(1)}°.` : 'Head is level.');
  add(yaw < 0.12 ? 'ok' : 'warn', yaw < 0.12 ? 'Facing the camera.' : 'Face looks turned — face the camera straight on.');
  add(Math.min(earL, earR) > 0.17 ? 'ok' : 'warn', Math.min(earL, earR) > 0.17 ? 'Eyes open.' : 'Eyes look closed or narrowed — keep both eyes open.');
  add(mouthGap < 0.03 ? 'ok' : 'warn', mouthGap < 0.03 ? 'Mouth closed.' : 'Mouth is open — use a neutral expression with your mouth closed.');
  add(balance > 0.8 ? 'ok' : 'warn', balance > 0.8 ? 'Even light on both sides of the face.' : 'One side of the face is darker — avoid shadows; face a window or soft light.');
  add(faceLum > 0.25 && faceLum < 0.88 ? 'ok' : 'warn', faceLum > 0.25 && faceLum < 0.88 ? 'Exposure looks right.' : faceLum <= 0.25 ? 'The photo is too dark.' : 'The face is overexposed.');
  add(!headTopCut ? 'ok' : 'warn', !headTopCut ? 'Top of the head is visible.' : 'The top of your head is cut off — retake with space above your head.');
  const roomBelow = crop.y + crop.h <= img.height + 1 && crop.x >= -1 && crop.x + crop.w <= img.width + 1 && crop.y >= -1;
  add(roomBelow ? 'ok' : 'warn', roomBelow ? 'Head and shoulders fit the frame.' : 'The photo is cropped too tightly — the edges were filled in. Retake from a little further away.');
  add(upscale <= 1.3 ? 'ok' : 'warn', upscale <= 1.3 ? 'Resolution is sufficient for 600 dpi.' : `Low resolution: enlarged ${Math.round(upscale * 100)}% — may be rejected. Use a sharper, closer photo.`);
  if (plainBackground) add(spec.strict ? 'warn' : 'info', `Background replaced with ${spec.bgLabel}. ${spec.editRule} An edited background may be rejected — a photo taken against a plain wall is safest.`);
  else {
    // plainness of the existing background
    let s1 = 0; let s2 = 0; let nn = 0;
    for (let y = 0; y < img.height; y += 10) for (let x = 0; x < img.width; x += 10) {
      if (alphaAt(x, y) > 0.1) continue;
      const l = lumAt(img, x, y); s1 += l; s2 += l * l; nn++;
    }
    const mean = nn ? s1 / nn : 0; const sd = nn ? Math.sqrt(Math.max(0, s2 / nn - mean * mean)) : 1;
    const plain = mean > 0.68 && sd < 0.07;
    add(plain ? 'ok' : 'warn', plain ? `Background looks plain and light (${spec.bgLabel} required).` : `Background isn't plain or light enough — required: ${spec.bgLabel}. Retake against a plain wall, or choose a plain background (digital edit).`);
  }
  add('info', spec.noGlasses ? 'Check yourself: no glasses, nothing covering your face, taken in the last 6 months.' : 'Check yourself: no tinted glasses or glare, nothing covering your face, recent photo.');
  if (spec.note) add('info', spec.note);

  return { canvas, spec, checks, outW, outH, geometry: { crownY, chinY, headPx, k, crop, angle, headMM } };
}

// Mark a JPEG as 600 (or other) dpi so print shops print it at the right physical size.
export async function setJpegDpi(blob, dpi) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return blob;
  const isJfif = buf[2] === 0xff && buf[3] === 0xe0 && buf[6] === 0x4a && buf[7] === 0x46 && buf[8] === 0x49 && buf[9] === 0x46;
  if (isJfif) {
    buf[13] = 1; buf[14] = dpi >> 8; buf[15] = dpi & 255; buf[16] = dpi >> 8; buf[17] = dpi & 255;
    return new Blob([buf], { type: 'image/jpeg' });
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
  const out = new Uint8Array(buf.length + app0.length);
  out.set(buf.subarray(0, 2), 0); out.set(app0, 2); out.set(buf.subarray(2), 2 + app0.length);
  return new Blob([out], { type: 'image/jpeg' });
}

export async function passportJpeg(result) {
  const blob = await canvasToBlob(result.canvas, 'image/jpeg', 0.95);
  return setJpegDpi(blob, 600);
}

// 10×15 cm (6×4 in) print sheet at 300 dpi with as many copies as fit, plus cut guides.
export async function printSheet(result) {
  const W = 1800; const H = 1200; const dpi = 300;
  const pw = Math.round(result.spec.wMM / MM_PER_IN * dpi); const ph = Math.round(result.spec.hMM / MM_PER_IN * dpi);
  const gap = Math.round(3 / MM_PER_IN * dpi);
  const cols = Math.max(1, Math.floor((W - gap) / (pw + gap))); const rows = Math.max(1, Math.floor((H - gap) / (ph + gap)));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const ox = Math.round((W - (cols * pw + (cols - 1) * gap)) / 2); const oy = Math.round((H - (rows * ph + (rows - 1) * gap)) / 2);
  g.strokeStyle = '#c8c8c8'; g.lineWidth = 1;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = ox + col * (pw + gap); const y = oy + r * (ph + gap);
      g.drawImage(result.canvas, x, y, pw, ph);
      g.strokeRect(x - 0.5, y - 0.5, pw + 1, ph + 1);
    }
  }
  const blob = await canvasToBlob(c, 'image/jpeg', 0.95);
  return { blob: await setJpegDpi(blob, dpi), copies: cols * rows };
}
