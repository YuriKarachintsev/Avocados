// Loading, converting and exporting images in the browser.
import { createImg } from '../engine/raster.js';

export const MAX_LONG_SIDE = 4096;
export const MAX_AREA = 16_777_216; // iOS Safari canvas limit
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif', ''];

export class PhotoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

async function decode(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    im.decoding = 'async';
    im.src = url;
    await im.decode();
    return im;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function loadPhoto(file) {
  if (!file) throw new PhotoError('none', 'Choose a photo to start.');
  if (!OK_TYPES.includes(file.type) && !/\.(jpe?g|png|webp|heic|heif|avif)$/i.test(file.name || '')) {
    throw new PhotoError('type', 'That file is not a photo. Use a JPEG, PNG or WebP image.');
  }
  if (file.size > MAX_FILE_BYTES) throw new PhotoError('size', 'That photo is larger than 30 MB. Export a smaller copy and try again.');
  let src;
  try {
    src = await decode(file);
  } catch {
    if (/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '')) {
      throw new PhotoError('heic', "This browser can't open HEIC photos. On iPhone, share the photo as JPEG (or set Camera ▸ Formats ▸ Most Compatible) and try again.");
    }
    throw new PhotoError('decode', "This photo couldn't be opened. It may be damaged or in an unsupported format.");
  }
  const ow = src.width || src.naturalWidth; const oh = src.height || src.naturalHeight;
  if (!ow || !oh) throw new PhotoError('decode', "This photo couldn't be opened.");
  if (Math.min(ow, oh) < 256) throw new PhotoError('small', 'This photo is too small. Use one that is at least 256 pixels on its shortest side.');
  let scale = Math.min(1, MAX_LONG_SIDE / Math.max(ow, oh));
  if (ow * oh * scale * scale > MAX_AREA) scale = Math.sqrt(MAX_AREA / (ow * oh));
  const w = Math.max(1, Math.floor(ow * scale)); const h = Math.max(1, Math.floor(oh * scale));
  const c = makeCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  src.close?.();
  const data = g.getImageData(0, 0, w, h).data;
  // Flatten any transparency onto white so exports look right.
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) {
      const a = data[i] / 255;
      data[i - 3] = data[i - 3] * a + 255 * (1 - a); data[i - 2] = data[i - 2] * a + 255 * (1 - a); data[i - 1] = data[i - 1] * a + 255 * (1 - a);
      data[i] = 255;
    }
  }
  c.width = 1; c.height = 1;
  return { img: createImg(w, h, data), originalWidth: ow, originalHeight: oh, scaled: scale < 1, name: file.name || 'photo' };
}

export function imgToCanvas(img, canvas) {
  const c = canvas || makeCanvas(img.width, img.height);
  if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height; }
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

export async function imgToBitmap(img) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(new ImageData(img.data, img.width, img.height)); } catch { /* fall through */ }
  }
  return imgToCanvas(img);
}

// Crop (in pixel coords) and scale to w×h, returning a canvas.
export function cropToCanvas(img, rect, w, h) {
  const src = imgToCanvas(img);
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  src.width = 1; src.height = 1;
  return c;
}

export function canvasToImg(c) {
  const g = c.getContext('2d', { willReadFrequently: true });
  return createImg(c.width, c.height, g.getImageData(0, 0, c.width, c.height).data);
}

export function canvasToBlob(c, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new PhotoError('export', 'Could not create the image file.'))), type, quality);
  });
}

export async function blobToImg(blob, maxLong = 8192) {
  const bmp = await decode(blob);
  const w0 = bmp.width || bmp.naturalWidth; const h0 = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, maxLong / Math.max(w0, h0));
  const w = Math.round(w0 * s); const h = Math.round(h0 * s);
  const c = makeCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return createImg(w, h, g.getImageData(0, 0, w, h).data);
}

// Extract a single-channel mask from a returned matte image (alpha cutout or greyscale mask).
export function imgToMask(img) {
  const n = img.width * img.height;
  const d = img.data;
  let alphaVaries = false;
  for (let i = 3; i < d.length; i += 4 * 97) { if (d[i] < 250) { alphaVaries = true; break; } }
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = alphaVaries ? d[p * 4 + 3] : d[p * 4];
  return { width: img.width, height: img.height, data: out };
}

export function frameRect(img, frame) {
  const W = img.width; const H = img.height;
  if (!frame || frame.aspect === 'original') return { x: 0, y: 0, w: W, h: H };
  const [a, b] = frame.aspect.split(':').map(Number);
  const ratio = a / b;
  let w = W; let h = W / ratio;
  if (h > H) { h = H; w = H * ratio; }
  const z = Math.max(1, frame.zoom || 1);
  w /= z; h /= z;
  const cx = frame.cx ?? W / 2; const cy = frame.cy ?? H / 2;
  let x = cx - w / 2; let y = cy - h / 2;
  x = Math.max(0, Math.min(W - w, x)); y = Math.max(0, Math.min(H - h, y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function exportFileName(ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `careerstudio-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}
