import { $, h, toast, modal, confirmDialog, getConfig, mountChrome, ApiError } from '../ui.js';
import { icons, garmentIcon } from '../icons.js';
import { Engine } from '../engine/engine.js';
import { History } from '../engine/history.js';
import { applyOp, LOOKS, ADJUSTMENTS, RETOUCH_ITEMS, SKIN_LOOKS, MAKEUP_ITEMS, SHAPE_ITEMS } from '../engine/ops.js';
import { faceMetrics } from '../engine/face.js';
import { View } from './view.js';
import {
  loadPhoto, PhotoError, imgToBitmap, cropToCanvas, canvasToImg, canvasToBlob, blobToImg, imgToMask, frameRect, exportFileName,
} from './imageio.js';
import { loadFaceModels, detectFaces } from './faces.js';
import { segmentOnDevice } from './segment.js';
import { ensureConsent, runAiJob, deleteServerSession } from './ai-client.js';
import { roiFor, prepareUpload, composeResult } from './ai-compose.js';
import { saveProject } from '../store.js';
import { PASSPORT_SPECS, makePassport, passportJpeg, printSheet } from './passport.js';

mountChrome('/editor');

const els = {
  stage: $('#stage'), canvas: $('#view'), upload: $('#upload'), uploadError: $('#upload-error'), dropzone: $('#dropzone'),
  file: $('#file-input'), camera: $('#camera-input'), cameraLabel: $('#camera-label'),
  busy: $('#busy'), busyStage: $('#busy-stage'), busySub: $('#busy-sub'), busyCancel: $('#busy-cancel'),
  options: $('#options'), tools: $('#tools'), faceHint: $('#face-hint'),
  undo: $('#btn-undo'), redo: $('#btn-redo'), compare: $('#btn-compare'), split: $('#btn-split'), more: $('#btn-more'),
  download: $('#btn-download'), menu: $('#menu'),
};

const isTouch = matchMedia('(pointer: coarse)').matches;
if (!isTouch) els.cameraLabel.hidden = true;

const TOOLS = [
  { id: 'skin', label: 'Skin', icon: 'retouch' },
  { id: 'face', label: 'Face', icon: 'faceShape' },
  { id: 'makeup', label: 'Makeup', icon: 'makeup' },
  { id: 'hair', label: 'Hair', icon: 'hair', ai: true },
  { id: 'outfit', label: 'Outfit', icon: 'outfit', ai: true },
  { id: 'background', label: 'Background', icon: 'background' },
  { id: 'light', label: 'Light', icon: 'light' },
  { id: 'adjust', label: 'Adjust', icon: 'adjust' },
  { id: 'smile', label: 'Smile', icon: 'smile', ai: true },
  { id: 'passport', label: 'Passport', icon: 'idCard' },
  { id: 'crop', label: 'Crop', icon: 'crop' },
];

const FORMATS = [
  { id: 'original', label: 'Original', aspect: 'original' },
  { id: 'linkedin', label: 'LinkedIn 1:1', aspect: '1:1' },
  { id: 'cv', label: 'CV 3:4', aspect: '3:4' },
  { id: 'corporate', label: 'Corporate 4:5', aspect: '4:5' },
  { id: 'passport', label: 'ID 35×45', aspect: '7:9' },
];

// [jacket, inner layer, tie?] colours for the outfit tiles
const GARMENTS = {
  'w-office-ivory': ['#efe8dc', '#f7f2ea'], 'w-office-tuxedo': ['#18171a', '#ffffff'], 'w-office-camel': ['#b98b5e', '#f1e6d3'],
  'w-office-navy': ['#22304b', '#ffffff'], 'w-office-greige': ['#b7aea3', '#b7aea3'],
  'w-smart-cashmere': ['#efe6d6', '#efe6d6'], 'w-smart-silk': ['#e8d6b8', '#e8d6b8'], 'w-smart-boucle': ['#e9c9c4', '#ffffff'],
  'w-smart-knitblazer': ['#1e1e21', '#ffffff'], 'w-smart-trench': ['#cdb592', '#25304a'],
  'm-office-charcoal': ['#45464b', '#ffffff', '#23345a'], 'm-office-chalk': ['#22304d', '#cfe0f2', '#6d2433'],
  'm-office-3piece': ['#1c2740', '#ffffff', '#a7a9ad'], 'm-office-black': ['#1d1c1f', '#ffffff', '#111111'],
  'm-office-glen': ['#77797d', '#ffffff', '#1f2c4d'],
  'm-smart-camel': ['#b98b5e', '#ffffff'], 'm-smart-polo': ['#cfc4ae', '#24304a'], 'm-smart-rollneck': ['#3c3d41', '#111111'],
  'm-smart-oxford': ['#273657', '#bcd2ea'], 'm-smart-suede': ['#a8754b', '#ffffff'],
};

const S = {
  config: null, engine: new Engine(), view: null, history: null,
  faces: [], face: 0, fullW: 0, fullH: 0,
  full: null, prevAfter: null, prevBefore: null,
  tool: 'skin', pending: null, pendingLabel: '', pendingAssets: [],
  abort: null, seq: 0, mattes: new Map(), backdrops: new Map(), ui: {}, dirty: false,
  faceError: null, passport: null,
};
S.view = new View(els.stage, els.canvas);
S.view.onCropChange = (params) => { if (S.pending?.type === 'frame') S.pending.params = { ...params }; };

// ---------------------------------------------------------------- helpers
const uid = () => Math.random().toString(36).slice(2, 10);
const budget = isTouch ? 160 * 1048576 : 420 * 1048576;
const meta = () => ({ faces: S.faces, fullWidth: S.fullW });
const face = () => S.faces[S.face] || null;

function busy(on, stage = 'Working…', { cancellable = false, sub = '' } = {}) {
  els.busy.hidden = !on;
  els.busyStage.textContent = stage;
  els.busySub.textContent = sub;
  els.busyCancel.hidden = !cancellable;
}
els.busyCancel.addEventListener('click', () => S.abort?.abort());

function previewOf(img) {
  const long = S.view.previewLongSide();
  const s = Math.min(1, long / Math.max(img.width, img.height));
  if (s >= 1) return img;
  const c = cropToCanvas(img, { x: 0, y: 0, w: img.width, h: img.height }, Math.round(img.width * s), Math.round(img.height * s));
  const out = canvasToImg(c);
  c.width = 1; c.height = 1;
  return out;
}

async function showAfter(img) {
  const bmp = await imgToBitmap(img);
  S.view.setImages({ after: bmp, pScale: img.width / S.fullW });
}

async function refresh() {
  S.full = await S.history.current();
  S.prevAfter = previewOf(S.full);
  await showAfter(S.prevAfter);
  const frame = S.history.frameAt();
  S.view.setFrame(frame ? frameRect(S.full, frame) : null);
  syncButtons();
}

function syncButtons() {
  const has = Boolean(S.history);
  els.undo.disabled = !has || !S.history.canUndo || Boolean(S.pending);
  els.redo.disabled = !has || !S.history.canRedo || Boolean(S.pending);
  for (const b of [els.compare, els.split, els.more, els.download]) b.disabled = !has;
}

function errorMessage(err) {
  if (err instanceof ApiError || err instanceof PhotoError) return err.message;
  if (err?.name === 'AbortError') return 'Canceled.';
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------- loading
async function openFile(file) {
  els.uploadError.hidden = true;
  if (S.history?.hasEdits() && !(await confirmDialog('Open another photo?', 'Your current edits will be discarded unless you download or save them first.', 'Open new photo'))) return;
  busy(true, 'Opening your photo');
  try {
    const { img, scaled, originalWidth, originalHeight } = await loadPhoto(file);
    resetState();
    S.fullW = img.width; S.fullH = img.height;
    S.engine.clear();
    S.history = new History(S.engine, img, meta(), { budgetBytes: budget });
    S.history.onChange(() => { S.dirty = true; syncButtons(); });
    S.prevBefore = previewOf(img);
    const beforeBmp = await imgToBitmap(S.prevBefore);
    S.view.setImages({ before: beforeBmp, pScaleBefore: S.prevBefore.width / img.width, fullW: img.width, fullH: img.height });
    await refresh();
    els.upload.hidden = true;
    document.body.classList.remove('no-photo');
    if (scaled) toast(`Your photo (${originalWidth}×${originalHeight}) was resized to ${img.width}×${img.height} to fit this browser's memory.`);
    busy(true, 'Finding faces', { sub: 'On your device' });
    try {
      S.faces = await detectFaces(img);
      S.history.meta = meta();
    } catch {
      S.faces = [];
      S.faceError = "Face tools couldn't start on this device. Light, Adjust, Background and Crop still work.";
    }
    busy(false);
    afterFaces();
    await applyInitialFormat();
    renderTools();
    renderOptions();
  } catch (err) {
    busy(false);
    if (!S.history) {
      els.uploadError.textContent = errorMessage(err);
      els.uploadError.hidden = false;
      els.upload.hidden = false;
    } else toast(errorMessage(err), { type: 'error' });
  } finally {
    els.file.value = ''; els.camera.value = '';
  }
}

function resetState() {
  S.history = null; S.faces = []; S.face = 0; S.pending = null; S.pendingAssets = [];
  S.mattes.clear(); S.faceError = null; S.dirty = false; S.passport = null;
  if (typeof showPassportView === 'function') showPassportView(false);
  S.view.setSplit(false); els.split.setAttribute('aria-pressed', 'false');
  S.view.setMode('normal'); S.view.hideFaces();
}

function afterFaces() {
  if (S.faces.length > 1) {
    els.faceHint.hidden = false;
    S.view.showFaces(S.faces, S.face, selectFace);
    setTimeout(() => { els.faceHint.hidden = true; }, 6000);
    toast(`${S.faces.length} faces found. Face tools edit the highlighted one — tap another face to switch.`);
  } else if (!S.faces.length && !S.faceError) {
    toast("No face found. Retouch, Smile and Hair need a clear, front-facing face; other tools still work.", { timeout: 7000 });
  }
}

function selectFace(i) {
  S.face = i;
  S.view.showFaces(S.faces, S.face, selectFace);
  els.faceHint.hidden = true;
  if (S.pending?.type === 'retouch') { S.pending.params.face = i; schedulePreview(); }
  renderOptions();
}

async function applyInitialFormat() {
  const fmt = new URLSearchParams(location.search).get('format');
  const f = FORMATS.find((x) => x.id === fmt && x.aspect !== 'original');
  if (!f) return;
  const params = smartFrame(f.aspect);
  await S.history.push({ type: 'frame', params }, `Framed for ${f.label}`);
  await refresh();
  toast(`Framed for ${f.label}. Change it any time in Crop.`);
}

// ---------------------------------------------------------------- preview of pending op
let previewBusy = false; let previewQueued = false;
async function schedulePreview() {
  if (previewBusy) { previewQueued = true; return; }
  previewBusy = true;
  try {
    do {
      previewQueued = false;
      const op = S.pending;
      if (!op || op.type === 'frame') { await showAfter(S.prevAfter); break; }
      const img = await S.engine.run(S.prevAfter, [op], meta());
      if (S.pending === op || (S.pending && S.pending.type === op.type)) await showAfter(img);
    } while (previewQueued);
  } catch (err) {
    toast(errorMessage(err), { type: 'error' });
  } finally {
    previewBusy = false;
  }
}

function setPending(op, label) {
  S.pending = op;
  S.pendingLabel = label;
  syncButtons();
  renderConfirm();
  schedulePreview();
}

async function cancelPending() {
  S.pending = null;
  S.pendingAssets = [];
  S.view.setMode(S.tool === 'crop' ? 'crop' : 'normal');
  await showAfter(S.prevAfter);
  syncButtons();
  renderOptions();
}

async function applyPending() {
  if (!S.pending) return;
  const op = S.pending; const label = S.pendingLabel;
  S.pending = null;
  busy(true, 'Applying at full resolution');
  try {
    await S.history.push(op, label);
    S.pendingAssets = [];
    if (op.type === 'frame') S.view.setMode(S.tool === 'crop' ? 'crop' : 'normal');
    await refresh();
    toast(`${label} applied.`, { timeout: 2200 });
  } catch (err) {
    toast(errorMessage(err), { type: 'error' });
  } finally {
    busy(false);
    renderOptions();
  }
}

async function guardPending() {
  if (!S.pending) return true;
  const choice = await modal({
    title: 'Keep this change?', body: `You have an unapplied ${S.pendingLabel.toLowerCase()} change.`,
    actions: [{ label: 'Discard', value: 'discard' }, { label: 'Apply', value: 'apply', primary: true }],
  });
  if (choice === 'apply') { await applyPending(); return true; }
  if (choice === 'discard') { await cancelPending(); return true; }
  return false;
}

// ---------------------------------------------------------------- tools UI
function renderTools() {
  els.tools.replaceChildren(...TOOLS.map((t) => {
    const b = h('button', { type: 'button', class: 'tool', role: 'tab', 'aria-selected': String(t.id === S.tool), id: `tool-${t.id}`, title: t.ai ? `${t.label} (AI)` : t.label });
    b.innerHTML = `<span class="${t.ai ? 'ai-dot' : ''}">${icons[t.icon]}</span><span>${t.label}</span>`;
    b.addEventListener('click', async () => {
      if (t.id === S.tool) return;
      if (!(await guardPending())) return;
      S.tool = t.id;
      S.view.setMode(t.id === 'crop' ? 'crop' : 'normal');
      showPassportView(t.id === 'passport');
      renderTools();
      renderOptions();
    });
    return b;
  }));
}

function head(title, sub) {
  return h('div', { class: 'opt-head' }, h('div', {}, h('div', { class: 'opt-title' }, title), sub ? h('div', { class: 'opt-sub' }, sub) : null),
    S.faces.length > 1 && ['skin', 'face', 'makeup', 'smile', 'hair', 'outfit', 'passport'].includes(S.tool)
      ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { els.faceHint.hidden = false; S.view.showFaces(S.faces, S.face, selectFace); } }, `Face ${S.face + 1} of ${S.faces.length}`) : null);
}

function tile({ label, thumb, pressed, onClick, disabled, check }) {
  const t = h('button', { type: 'button', class: 'tile', 'aria-pressed': String(Boolean(pressed)), disabled: disabled || null });
  const th = h('span', { class: 'thumb' });
  if (typeof thumb === 'string') th.innerHTML = thumb; else if (thumb) th.append(thumb);
  if (check) th.append(h('span', { class: 'check-dot', html: icons.check }));
  t.append(th, h('span', {}, label));
  t.addEventListener('click', onClick);
  return t;
}

function slider({ name, value, min = 0, max = 100, def = 0, onInput }) {
  const id = `s-${uid()}`;
  const input = h('input', { type: 'range', class: 'range', id, min, max, step: 1, value });
  const out = h('output', { for: id }, String(value));
  const fill = () => input.style.setProperty('--fill', `${((input.value - min) / (max - min)) * 100}%`);
  fill();
  input.addEventListener('input', () => { out.textContent = input.value; fill(); onInput(Number(input.value)); });
  input.addEventListener('dblclick', () => { input.value = def; out.textContent = String(def); fill(); onInput(def); });
  return h('div', { class: 'slider-row' }, h('label', { class: 'name', for: id }, name), input, out);
}

function confirmRow() {
  const row = h('div', { class: 'confirm-row', id: 'confirm-row' },
    h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Discard change', html: icons.close, onclick: cancelPending }),
    h('div', { class: 'label' }, S.pending ? S.pendingLabel : ''),
    h('button', { type: 'button', class: 'btn btn-icon apply', 'aria-label': 'Apply change', html: icons.check, onclick: applyPending }));
  row.hidden = !S.pending;
  return row;
}
function renderConfirm() {
  const row = $('#confirm-row');
  if (!row) return;
  row.hidden = !S.pending;
  row.querySelector('.label').textContent = S.pending ? S.pendingLabel : '';
}

function unavailable(title, text) {
  return h('div', { class: 'unavailable' }, h('strong', {}, title), h('span', {}, text));
}

function needsFace() {
  if (face()) return null;
  return unavailable('No face to edit', S.faceError || 'This tool needs a clear, front-facing face. Try a photo where your face is well lit and not covered.');
}

function aiOff(what) {
  if (S.config?.ai?.enabled) return null;
  return unavailable(`${what} needs the AI service`, 'AI editing is not set up on this server yet, so this tool is unavailable. Skin, Face, Makeup, Light, Adjust, Background (on-device), Passport and Crop still work.');
}

function renderOptions() {
  const o = els.options;
  o.replaceChildren();
  if (!S.history) return;
  const fn = { skin: optSkin, face: optFace, makeup: optMakeup, light: optLight, adjust: optAdjust, outfit: optOutfit, background: optBackground, smile: optSmile, hair: optHair, passport: optPassport, crop: optCrop }[S.tool];
  fn(o);
  o.append(confirmRow());
}

// ----- shared: a small face crop (with landmarks) for live tile previews
function faceThumb(size = 128) {
  const f = face();
  if (!f) return null;
  const src = S.prevAfter;
  const k = src.width / S.fullW;
  const m = faceMetrics(f.landmarks);
  const side = Math.min(m.faceW * 1.5 * k, src.width, src.height);
  const r = {
    x: Math.max(0, Math.min(src.width - side, m.center[0] * k - side / 2)),
    y: Math.max(0, Math.min(src.height - side, m.center[1] * k - side / 2)), w: side, h: side,
  };
  const c = cropToCanvas(src, r, size, size);
  const img = canvasToImg(c);
  c.width = 1; c.height = 1;
  const t = size / side;
  const landmarks = f.landmarks.map(([x, y]) => [(x * k - r.x) * t, (y * k - r.y) * t]);
  return { img, faces: [{ landmarks }] };
}

function previewTile(base, op) {
  if (!base) return null;
  try {
    return thumbCanvas(applyOp(base.img, op, { faces: base.faces, fullWidth: base.img.width, assets: {} }));
  } catch { return thumbCanvas(base.img); }
}

// Multiselect group (FaceApp-style): several items active at once, each with its own strength.
function multiGroup(o, { items, opType, label, ariaLabel, getValue, setValue, removeValue, icon, colors }) {
  const cur = S.pending?.type === opType ? S.pending.params : { face: S.face };
  const selKey = `${opType}Sel`;
  if (!(S.ui[selKey] && getValue(cur, S.ui[selKey]))) S.ui[selKey] = items.find((i) => getValue(cur, i.key))?.key || null;
  const tiles = h('div', { class: 'tiles', role: 'group', 'aria-label': ariaLabel });
  for (const it of items) {
    tiles.append(tile({
      label: it.label, thumb: icon(it), pressed: Boolean(getValue(cur, it.key)), check: true,
      onClick: () => {
        const p = structuredClone(S.pending?.type === opType ? S.pending.params : { face: S.face });
        p.face = S.face;
        if (getValue(p, it.key) && S.ui[selKey] === it.key) { removeValue(p, it.key); S.ui[selKey] = null; } else { if (!getValue(p, it.key)) setValue(p, it, it.def); S.ui[selKey] = it.key; }
        const active = items.filter((x) => getValue(p, x.key));
        if (!active.length) { cancelPending(); return; }
        setPending({ type: opType, params: p }, active.length > 1 ? label : active[0].label);
        renderOptions();
      },
    }));
  }
  o.append(tiles);
  const sel = items.find((i) => i.key === S.ui[selKey]);
  if (sel && S.pending?.type === opType) {
    if (colors && sel.colors) {
      const row = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': `${sel.label} colour` });
      for (const [name, hex] of sel.colors) {
        const cur2 = S.pending.params[sel.key]?.c || sel.colors[0][1];
        const b = h('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(cur2 === hex), 'aria-label': name, title: name });
        b.style.setProperty('--sw', hex);
        b.addEventListener('click', () => { S.pending.params[sel.key].c = hex; schedulePreview(); renderOptions(); });
        row.append(b);
      }
      o.append(row);
    }
    o.append(slider({ name: sel.label, value: getValue(S.pending.params, sel.key), def: sel.def, onInput: (v) => { setValue(S.pending.params, sel, Math.max(1, v), true); schedulePreview(); } }));
  } else {
    o.append(h('p', { class: 'opt-sub' }, 'Tap to try; tap again to switch it off. Combine as many as you like.'));
  }
}

// ----- Skin: Fresh / Silk / Cute finishes + fine-tuning (face only)
function skinParams(look, intensity, fine) {
  const p = { face: S.face, look, intensity, fine: { ...fine } };
  const preset = look ? SKIN_LOOKS[look].p : {};
  for (const key of new Set([...Object.keys(preset), ...Object.keys(fine)])) {
    p[key] = Math.max(((preset[key] || 0) * intensity) / 100, fine[key] || 0);
  }
  return p;
}

function optSkin(o) {
  o.append(head('Skin', 'Fresh, Silk or Cute finish — on your face only.'));
  const miss = needsFace();
  if (miss) { o.append(miss); return; }
  const cur = S.pending?.type === 'retouch' ? S.pending.params : null;
  const base = faceThumb();
  const looks = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Skin finishes' });
  looks.append(tile({ label: 'Original', thumb: base ? thumbCanvas(base.img) : icons.retouch, pressed: !cur?.look, onClick: () => {
    if (!cur) return;
    const p = skinParams(null, 0, cur.fine || {});
    if (!Object.keys(cur.fine || {}).length) { cancelPending(); return; }
    setPending({ type: 'retouch', params: p }, 'Skin');
    renderOptions();
  } }));
  for (const [key, lk] of Object.entries(SKIN_LOOKS)) {
    looks.append(tile({
      label: lk.label, thumb: previewTile(base, { type: 'retouch', params: { face: 0, ...lk.p } }) || icons.retouch, pressed: cur?.look === key,
      onClick: () => { setPending({ type: 'retouch', params: skinParams(key, cur?.intensity ?? 70, cur?.fine || {}) }, `${lk.label} skin`); renderOptions(); },
    }));
  }
  o.append(looks);
  if (cur?.look) {
    o.append(slider({ name: 'Intensity', value: cur.intensity, def: 70, onInput: (v) => { Object.assign(S.pending.params, skinParams(cur.look, v, S.pending.params.fine || {})); schedulePreview(); } }));
  }
  o.append(h('div', { class: 'group-label' }, 'Fine-tune'));
  const iconFor = { smooth: 'retouch', even: 'palette', eyes: 'light', teeth: 'smile', underEye: 'blur' };
  multiGroup(o, {
    items: RETOUCH_ITEMS, opType: 'retouch', label: 'Skin', ariaLabel: 'Fine-tune',
    icon: (it) => icons[iconFor[it.key]],
    getValue: (p, k) => p.fine?.[k] || 0,
    setValue: (p, it, v) => {
      p.fine = { ...(p.fine || {}), [it.key]: v };
      Object.assign(p, skinParams(p.look || null, p.intensity ?? 70, p.fine));
    },
    removeValue: (p, k) => {
      const fine = { ...(p.fine || {}) }; delete fine[k];
      for (const key of Object.keys(p)) if (!['face', 'look', 'intensity', 'fine'].includes(key)) delete p[key];
      p.fine = fine;
      Object.assign(p, skinParams(p.look || null, p.intensity ?? 70, fine));
    },
  });
}

// ----- Face shape (on-device local warp, features kept rigid)
function optFace(o) {
  o.append(head('Face shape', 'Subtle reshaping. This changes how you look, so keep it natural for application photos.'));
  const miss = needsFace();
  if (miss) { o.append(miss); return; }
  multiGroup(o, {
    items: SHAPE_ITEMS, opType: 'reshape', label: 'Face shape', ariaLabel: 'Face shape tools',
    icon: (it) => icons[`shape_${it.key}`] || icons.faceShape,
    getValue: (p, k) => p[k] || 0, setValue: (p, it, v) => { p[it.key] = v; }, removeValue: (p, k) => { delete p[k]; },
  });
}

// ----- Makeup (on-device, landmark-placed)
function optMakeup(o) {
  o.append(head('Makeup', 'Lipstick, blush, contouring, brows and lashes — placed on your features only.'));
  const miss = needsFace();
  if (miss) { o.append(miss); return; }
  multiGroup(o, {
    items: MAKEUP_ITEMS, opType: 'makeup', label: 'Makeup', ariaLabel: 'Makeup tools', colors: true,
    icon: (it) => icons[`mk_${it.key}`] || icons.makeup,
    getValue: (p, k) => p[k]?.a || 0,
    setValue: (p, it, v) => { p[it.key] = { a: v, c: p[it.key]?.c || it.colors?.[0]?.[1] }; },
    removeValue: (p, k) => { delete p[k]; },
  });
}

// ----- Light (looks)
function lookThumbBase() {
  const f = face();
  const src = S.prevAfter;
  const k = src.width / S.fullW;
  let r;
  if (f) {
    const m = faceMetrics(f.landmarks);
    const side = m.faceW * 1.6 * k;
    r = { x: Math.max(0, m.center[0] * k - side / 2), y: Math.max(0, m.center[1] * k - side / 2), w: side, h: side };
    r.w = Math.min(r.w, src.width - r.x); r.h = Math.min(r.h, src.height - r.y);
  } else {
    const side = Math.min(src.width, src.height);
    r = { x: (src.width - side) / 2, y: (src.height - side) / 2, w: side, h: side };
  }
  const c = cropToCanvas(src, r, 128, 128);
  const img = canvasToImg(c);
  c.width = 1; c.height = 1;
  return img;
}

function thumbCanvas(img) {
  const c = h('canvas', { width: img.width, height: img.height });
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

function optLight(o) {
  o.append(head('Light', 'Colour and light looks for the whole photo.'));
  const base = lookThumbBase();
  const cur = S.pending?.type === 'look' ? S.pending.params : null;
  const tiles = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Looks' });
  tiles.append(tile({ label: 'None', thumb: thumbCanvas(base), pressed: !cur, onClick: () => cancelPending() }));
  for (const [key, look] of Object.entries(LOOKS)) {
    const prev = applyOp(base, { type: 'look', params: { look: key, intensity: 100 } }, { fullWidth: base.width, assets: {} });
    tiles.append(tile({
      label: look.label, thumb: thumbCanvas(prev), pressed: cur?.look === key,
      onClick: () => { setPending({ type: 'look', params: { look: key, intensity: cur?.intensity ?? 70 } }, look.label); renderOptions(); },
    }));
  }
  o.append(tiles);
  if (cur) o.append(slider({ name: 'Intensity', value: cur.intensity, def: 70, onInput: (v) => { S.pending.params.intensity = v; schedulePreview(); } }));
}

// ----- Adjust
function optAdjust(o) {
  o.append(head('Adjust', 'Fine-tune light and colour. Double-click a slider to reset it.'));
  const cur = S.pending?.type === 'adjust' ? S.pending.params : {};
  S.ui.adjustSel = S.ui.adjustSel || 'brightness';
  const chips = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Adjustments' });
  for (const a of ADJUSTMENTS) {
    const val = cur[a.key] || 0;
    chips.append(h('button', {
      type: 'button', class: 'btn btn-sm', 'aria-pressed': String(S.ui.adjustSel === a.key),
      onclick: () => { S.ui.adjustSel = a.key; renderOptions(); },
    }, a.label + (val ? ` ${val > 0 ? '+' : ''}${val}` : '')));
  }
  o.append(chips);
  const a = ADJUSTMENTS.find((x) => x.key === S.ui.adjustSel);
  o.append(slider({
    name: a.label, value: cur[a.key] || 0, min: a.min, max: a.max, def: 0,
    onInput: (v) => {
      const p = { ...(S.pending?.type === 'adjust' ? S.pending.params : {}) };
      p[a.key] = v;
      if (Object.values(p).every((x) => !x)) { S.pending = null; syncButtons(); renderConfirm(); schedulePreview(); return; }
      if (S.pending?.type === 'adjust') { S.pending.params = p; schedulePreview(); renderConfirm(); } else setPending({ type: 'adjust', params: p }, 'Adjustments');
    },
  }));
}

// ----- AI edit flow shared by Outfit, Smile and Hair
async function runFaceAi(feature, preset, label) {
  const f = face();
  if (!f) return;
  const what = { outfit: 'change your outfit', smile: 'change your expression', hair: 'restyle your hair' }[feature];
  if (!(await ensureConsent(what))) return;
  if (!(await guardPending())) return;
  S.abort = new AbortController();
  busy(true, 'Preparing your photo', { cancellable: true, sub: 'Usually 10–30 seconds' });
  try {
    const roi = roiFor(feature, f, S.fullW, S.fullH);
    const { blob, orig, ws } = await prepareUpload(S.full, roi);
    const resultBlob = await runAiJob({
      feature, preset, blob, signal: S.abort.signal,
      onStage: (t) => busy(true, t, { cancellable: true, sub: 'Usually 10–30 seconds' }),
    });
    busy(true, 'Blending into your photo', { sub: 'Keeping your face exactly as it is' });
    const { result, mask } = await composeResult({ feature, resultBlob, orig, roi, ws, face: f, imageW: S.fullW, imageH: S.fullH });
    const rid = `ai-${uid()}`; const mid = `mask-${uid()}`;
    S.engine.putAsset(rid, result);
    S.engine.putAsset(mid, mask);
    setPending({ type: 'aiComposite', params: { roi, result: rid, mask: mid, feature, preset } }, label);
    S.ui.aiPreset = `${feature}:${preset}`;
    renderOptions();
  } catch (err) {
    if (err?.name !== 'AbortError') toast(errorMessage(err), { type: 'error', timeout: 8000 });
  } finally {
    S.abort = null;
    busy(false);
  }
}

function aiTiles(feature, ids, thumbFn) {
  const presets = S.config?.ai?.presets?.[feature] || [];
  const byId = Object.fromEntries(presets.map((p) => [p.id, p]));
  const wrap = h('div', { class: 'tiles', role: 'group' });
  for (const id of ids) {
    const p = byId[id];
    if (!p) continue;
    wrap.append(tile({
      label: p.label, thumb: thumbFn(id), pressed: S.pending?.type === 'aiComposite' && S.ui.aiPreset === `${feature}:${id}`,
      onClick: () => runFaceAi(feature, id, p.label),
    }));
  }
  return wrap;
}

function optOutfit(o) {
  o.append(head('Outfit', 'Swap your clothes for office or smart-casual styles. Your face stays untouched.'));
  const off = aiOff('Outfit change') || needsFace();
  if (off) { o.append(off); return; }
  S.ui.outfitGroup = S.ui.outfitGroup || 'w';
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Style group' });
  for (const [k, l] of [['w', "Women's styles"], ['m', "Men's styles"]]) {
    seg.append(h('button', { type: 'button', 'aria-pressed': String(S.ui.outfitGroup === k), onclick: () => { S.ui.outfitGroup = k; renderOptions(); } }, l));
  }
  o.append(seg);
  const g = S.ui.outfitGroup;
  const all = (S.config.ai.presets.outfit || []).map((p) => p.id);
  const thumb = (id) => { const c = GARMENTS[id] || ['#888', '#fff']; return garmentIcon(c[0], c[1], c[2]); };
  o.append(h('div', { class: 'group-label' }, 'Office'), aiTiles('outfit', all.filter((id) => id.startsWith(`${g}-office`)), thumb));
  o.append(h('div', { class: 'group-label' }, 'Smart casual'), aiTiles('outfit', all.filter((id) => id.startsWith(`${g}-smart`)), thumb));
  o.append(h('p', { class: 'cost-note' }, 'Uses AI · a resized copy of the edited area is sent for processing after you agree.'));
}

function optSmile(o) {
  o.append(head('Smile', 'Changes your expression. Your eyes and upper face stay original.'));
  const off = aiOff('Smile') || needsFace();
  if (off) { o.append(off); return; }
  const ids = (S.config.ai.presets.smile || []).map((p) => p.id);
  o.append(aiTiles('smile', ids, () => icons.smile));
  o.append(h('p', { class: 'cost-note' }, 'Uses AI · this changes how you look, so use it thoughtfully on application photos.'));
}

function optHair(o) {
  o.append(head('Hair', 'Change the finish of your hair. Your face stays untouched.'));
  const off = aiOff('Hair styling') || needsFace();
  if (off) { o.append(off); return; }
  const ids = (S.config.ai.presets.hair || []).map((p) => p.id);
  o.append(aiTiles('hair', ids, (id) => icons[`hair_${id}`] || icons.hair));
  o.append(h('p', { class: 'cost-note' }, 'Uses AI · a resized copy of the edited area is sent for processing after you agree.'));
}

// ----- Background
// Background and framing changes don't alter the person, so a cut-out stays valid across them.
function personVersion() {
  let i = S.history.pointer;
  while (i > 0 && ['background', 'frame'].includes(S.history.entries[i].op?.type)) i--;
  return i;
}

async function getMatte(quality) {
  const key = `${personVersion()}:${quality}`;
  if (S.mattes.has(key)) return S.mattes.get(key);
  let mask;
  if (quality === 'hd') {
    if (!(await ensureConsent('cut you out in HD'))) throw new DOMException('Canceled', 'AbortError');
    S.abort = new AbortController();
    busy(true, 'Preparing your photo', { cancellable: true, sub: 'HD cut-out · usually under 15 seconds' });
    try {
      const long = 2048;
      const s = Math.min(1, long / Math.max(S.fullW, S.fullH));
      const c = cropToCanvas(S.full, { x: 0, y: 0, w: S.fullW, h: S.fullH }, Math.round(S.fullW * s), Math.round(S.fullH * s));
      const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
      c.width = 1; c.height = 1;
      const out = await runAiJob({ feature: 'matte', blob, signal: S.abort.signal, onStage: (t) => busy(true, t, { cancellable: true }) });
      mask = imgToMask(await blobToImg(out, 4096));
    } finally { S.abort = null; }
  } else {
    busy(true, 'Finding you in the photo', { sub: 'On your device' });
    mask = await segmentOnDevice(S.full);
  }
  const id = `matte-${uid()}`;
  S.engine.putAsset(id, mask);
  S.mattes.set(key, id);
  return id;
}

async function getBackdrop(item) {
  if (S.backdrops.has(item.id)) return S.backdrops.get(item.id);
  const res = await fetch(item.src);
  if (!res.ok) throw new Error('Could not load that backdrop.');
  const img = await blobToImg(await res.blob(), 2400);
  const id = `bg-${item.id}`;
  S.engine.putAsset(id, img);
  S.backdrops.set(item.id, id);
  return id;
}

async function chooseBackground(patch, label) {
  const quality = S.ui.bgQuality || 'standard';
  try {
    const matte = await getMatte(quality);
    if (patch.loadBackdrop) { busy(true, 'Loading backdrop'); patch.bg = await getBackdrop(patch.loadBackdrop); delete patch.loadBackdrop; }
    const prev = S.pending?.type === 'background' ? S.pending.params : { blur: 0, light: 0, edge: 0 };
    const params = { ...prev, ...patch, matte };
    S.ui.bgKey = params.key;
    busy(false);
    setPending({ type: 'background', params }, label);
    renderOptions();
  } catch (err) {
    busy(false);
    if (err?.name !== 'AbortError') toast(errorMessage(err), { type: 'error', timeout: 8000 });
  }
}

let backdropList = null;
async function loadBackdropList() {
  if (backdropList) return backdropList;
  try { backdropList = await (await fetch('/backgrounds/manifest.json')).json(); } catch { backdropList = []; }
  return backdropList;
}

function optBackground(o) {
  o.append(head('Background', 'Modern offices or a career-photoshoot studio backdrop.'));
  const aiOn = Boolean(S.config?.ai?.enabled);
  S.ui.bgQuality = S.ui.bgQuality || 'standard';
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Cut-out quality' });
  for (const [k, l] of [['standard', 'Standard · on device'], ['hd', 'HD · AI']]) {
    seg.append(h('button', {
      type: 'button', 'aria-pressed': String(S.ui.bgQuality === k), disabled: k === 'hd' && !aiOn ? true : null,
      title: k === 'hd' && !aiOn ? 'Needs the AI service (not set up on this server)' : null,
      onclick: () => {
        S.ui.bgQuality = k;
        if (S.pending?.type === 'background') { const p = { ...S.pending.params }; delete p.matte; chooseBackground(p, S.pendingLabel); } else renderOptions();
      },
    }, l));
  }
  o.append(seg);
  const cur = S.pending?.type === 'background' ? S.pending.params : null;

  const offices = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Modern offices' });
  const studio = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Career photoshoot backdrops' });
  o.append(h('div', { class: 'group-label' }, 'Modern offices'), offices);
  for (const p of S.config?.ai?.presets?.background || []) {
    offices.append(tile({
      label: p.label, thumb: icons.wand, disabled: !aiOn, pressed: cur?.key === `ai:${p.id}`,
      onClick: async () => {
        S.abort = new AbortController();
        busy(true, 'Creating an office backdrop', { cancellable: true, sub: 'Photorealistic · no photo is sent for this' });
        try {
          const aspect = S.fullW > S.fullH * 1.15 ? '4:3' : S.fullH > S.fullW * 1.15 ? '3:4' : '1:1';
          const blob = await runAiJob({ feature: 'background', preset: p.id, aspect, signal: S.abort.signal, onStage: (t) => busy(true, t, { cancellable: true }) });
          const img = await blobToImg(blob, 2400);
          const id = `bg-ai-${uid()}`;
          S.engine.putAsset(id, img);
          S.abort = null;
          await chooseBackground({ mode: 'image', bg: id, key: `ai:${p.id}` }, p.label);
        } catch (err) {
          busy(false);
          if (err?.name !== 'AbortError') toast(errorMessage(err), { type: 'error', timeout: 8000 });
        } finally { S.abort = null; }
      },
    }));
  }
  o.append(h('div', { class: 'group-label' }, 'Career photoshoot'), studio);
  loadBackdropList().then((list) => {
    for (const item of list) {
      const t = tile({
        label: item.label, thumb: h('img', { src: item.thumb, alt: '', loading: 'lazy' }), pressed: cur?.key === `art:${item.id}`,
        onClick: () => chooseBackground({ mode: 'image', key: `art:${item.id}`, loadBackdrop: item }, item.label),
      });
      (item.group === 'studio' ? studio : offices).append(t);
    }
  });
  o.append(h('p', { class: 'cost-note' }, aiOn
    ? 'Wand tiles create a photorealistic office with AI (no photo sent). Picture tiles are built in and free.'
    : 'Photorealistic AI offices need the AI service; the built-in offices and studio backdrops work now.'));

  const more = h('div', { class: 'tiles', role: 'group', 'aria-label': 'More backgrounds' });
  more.append(tile({ label: 'Blur my background', thumb: icons.blur, pressed: cur?.key === 'blur', onClick: () => chooseBackground({ mode: 'blur', key: 'blur', blur: Math.max(cur?.blur || 0, 45) }, 'Background blur') }));
  const own = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr-only', id: 'own-bg' });
  own.addEventListener('change', async () => {
    const file = own.files?.[0];
    if (!file) return;
    try {
      busy(true, 'Loading your backdrop');
      const { img } = await loadPhoto(file);
      const id = `bg-own-${uid()}`;
      S.engine.putAsset(id, img);
      busy(false);
      chooseBackground({ mode: 'image', bg: id, key: 'own' }, 'Your backdrop');
    } catch (err) { busy(false); toast(errorMessage(err), { type: 'error' }); }
  });
  more.append(tile({ label: 'Use my own', thumb: icons.upload, pressed: cur?.key === 'own', onClick: () => own.click() }), own);
  o.append(h('div', { class: 'group-label' }, 'More'), more);

  if (cur) {
    const upd = (k) => (v) => { S.pending.params[k] = v; schedulePreview(); };
    o.append(slider({ name: 'Blur', value: cur.blur || 0, def: cur.mode === 'blur' ? 45 : 0, onInput: upd('blur') }));
    o.append(slider({ name: 'Blend light', value: cur.light || 0, def: 0, onInput: upd('light') }));
    o.append(slider({ name: 'Edge', value: cur.edge || 0, min: -100, max: 100, def: 0, onInput: upd('edge') }));
  }
}

// ----- Passport / ID photo
const passportView = h('div', { class: 'passport-view', hidden: true }, h('img', { alt: 'Passport photo preview' }), h('div', { class: 'badge-before' }, 'Passport photo preview'));
els.stage.append(passportView);
function showPassportView(on) {
  passportView.hidden = !on || !S.passport;
}

async function buildPassport() {
  const spec = S.ui.ppSpec || 'icao';
  const plain = Boolean(S.ui.ppPlain);
  const hd = plain && S.ui.ppHd && S.config?.ai?.enabled;
  S.abort = new AbortController();
  busy(true, 'Making your passport photo', { sub: 'From your original photo', cancellable: hd });
  try {
    const getMask = async (img) => {
      if (!hd) return segmentOnDevice(img);
      if (!(await ensureConsent('cut you out in HD'))) throw new DOMException('Canceled', 'AbortError');
      const s = Math.min(1, 2048 / Math.max(img.width, img.height));
      const c = cropToCanvas(img, { x: 0, y: 0, w: img.width, h: img.height }, Math.round(img.width * s), Math.round(img.height * s));
      const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
      c.width = 1; c.height = 1;
      const out = await runAiJob({ feature: 'matte', blob, signal: S.abort.signal, onStage: (t) => busy(true, t, { cancellable: true }) });
      return imgToMask(await blobToImg(out, 4096));
    };
    const result = await makePassport({
      original: S.history.original, faces: S.faces, faceIndex: S.face, specId: spec, plainBackground: plain,
      straighten: S.ui.ppStraighten !== false, getMask,
    });
    S.passport = result;
    const blob = await canvasToBlob(result.canvas, 'image/jpeg', 0.92);
    const img = passportView.querySelector('img');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
    showPassportView(true);
  } catch (err) {
    if (err?.name !== 'AbortError') toast(errorMessage(err), { type: 'error', timeout: 8000 });
  } finally {
    S.abort = null;
    busy(false);
    renderOptions();
  }
}

function optPassport(o) {
  o.append(head('Passport photo', 'Made from your original photo — your face is never edited.'));
  const miss = needsFace();
  if (miss) { o.append(miss); return; }
  S.ui.ppSpec = S.ui.ppSpec || 'icao';
  const specs = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Passport format' });
  for (const [id, sp] of Object.entries(PASSPORT_SPECS)) {
    const box = h('span', {});
    const k = 40 / Math.max(sp.wMM, sp.hMM);
    Object.assign(box.style, { width: `${sp.wMM * k}px`, height: `${sp.hMM * k}px`, border: '2px solid var(--plum)', borderRadius: '3px', display: 'block' });
    specs.append(tile({ label: sp.short, thumb: box, pressed: S.ui.ppSpec === id, onClick: () => { S.ui.ppSpec = id; S.passport = null; showPassportView(false); renderOptions(); } }));
  }
  o.append(specs);
  const sp = PASSPORT_SPECS[S.ui.ppSpec];
  o.append(h('p', { class: 'opt-sub' }, `${sp.label} · head ${sp.headMM[0]}–${sp.headMM[1]} mm · background ${sp.bgLabel} · 600 dpi`));

  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Background' });
  for (const [k, l] of [[false, 'Background as taken'], [true, 'Plain background']]) {
    seg.append(h('button', { type: 'button', 'aria-pressed': String(Boolean(S.ui.ppPlain) === k), onclick: () => { S.ui.ppPlain = k; S.passport = null; showPassportView(false); renderOptions(); } }, l));
  }
  o.append(seg);
  if (S.ui.ppPlain) {
    o.append(h('div', { class: `notice ${sp.strict ? 'warn' : ''}` }, `Replacing the background is a digital edit. ${sp.editRule} ${sp.strict ? 'This may be rejected — a photo taken against a plain light wall is the safe choice.' : 'Use a plain light wall where possible.'}`));
    if (S.config?.ai?.enabled) {
      const q = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.ui.ppHd ? true : null, onchange: (e) => { S.ui.ppHd = e.target.checked; S.passport = null; showPassportView(false); } }), h('span', {}, 'Use HD cut-out (AI service) for cleaner hair edges'));
      o.append(q);
    }
  }
  o.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.ui.ppStraighten !== false ? true : null, onchange: (e) => { S.ui.ppStraighten = e.target.checked; S.passport = null; showPassportView(false); } }), h('span', {}, 'Straighten a tilted head')));
  o.append(h('button', { type: 'button', class: 'btn btn-shine', id: 'pp-make', onclick: buildPassport }, h('span', {}, S.passport ? 'Re-create passport photo' : 'Create passport photo')));

  if (S.passport) {
    const list = h('ul', { class: 'pp-checks', 'aria-label': 'Automatic checks' });
    for (const c of S.passport.checks) {
      list.append(h('li', { class: `pp-${c.status}` }, h('span', { class: 'pp-mark', 'aria-hidden': 'true' }, c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : 'i'), h('span', {}, c.text)));
    }
    o.append(h('div', { class: 'group-label' }, 'Automatic checks (indicative — the authority decides)'), list);
    const { spec } = S.passport;
    const dl = h('div', { class: 'row-wrap' },
      h('button', { type: 'button', class: 'btn btn-shine', id: 'pp-download', onclick: async () => {
        const blob = await passportJpeg(S.passport);
        saveBlob(blob, `careerstudio-passport-${S.ui.ppSpec}.jpg`);
        toast(`Downloaded ${S.passport.outW} × ${S.passport.outH} px (${spec.wMM === 50.8 ? '2×2 in' : `${spec.wMM}×${spec.hMM} mm`} at 600 dpi).`);
      } }, h('span', {}, 'Download photo')),
      h('button', { type: 'button', class: 'btn', id: 'pp-sheet', onclick: async () => {
        const { blob, copies } = await printSheet(S.passport);
        saveBlob(blob, `careerstudio-passport-${S.ui.ppSpec}-print-10x15.jpg`);
        toast(`Print sheet with ${copies} photos — print at 10×15 cm (4×6 in), 100% scale.`);
      } }, 'Print sheet 10×15 cm'));
    o.append(dl);
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ----- Crop / framing
function smartFrame(aspect, zoom = 1) {
  const f = face();
  const params = { aspect, zoom, cx: S.fullW / 2, cy: S.fullH / 2 };
  if (aspect !== 'original' && f) {
    const m = faceMetrics(f.landmarks);
    const r = frameRect({ width: S.fullW, height: S.fullH }, { ...params });
    params.cx = m.eyeMid[0];
    params.cy = m.eyeMid[1] + r.h * 0.08; // eyes a little above centre
  }
  const r = frameRect({ width: S.fullW, height: S.fullH }, params);
  params.cx = r.x + r.w / 2; params.cy = r.y + r.h / 2;
  return params;
}

function optCrop(o) {
  o.append(head('Crop', 'Frame your photo for where it will be used. Drag or pinch to adjust.'));
  const applied = S.history.frameAt();
  const cur = S.pending?.type === 'frame' ? S.pending.params : applied || { aspect: 'original', zoom: 1, cx: S.fullW / 2, cy: S.fullH / 2 };
  S.view.setCrop(cur, (p) => frameRect({ width: S.fullW, height: S.fullH }, p));
  const tiles = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Formats' });
  for (const f of FORMATS) {
    const [a, b] = f.aspect === 'original' ? [S.fullW, S.fullH] : f.aspect.split(':').map(Number);
    const box = h('span', {});
    const k = 40 / Math.max(a, b);
    Object.assign(box.style, { width: `${a * k}px`, height: `${b * k}px`, border: '2px solid var(--plum)', borderRadius: '4px', display: 'block' });
    tiles.append(tile({
      label: f.label, thumb: box, pressed: cur.aspect === f.aspect,
      onClick: () => {
        const p = smartFrame(f.aspect, 1);
        setPending({ type: 'frame', params: p }, f.aspect === 'original' ? 'Original framing' : `Framed for ${f.label}`);
        S.view.setCrop(p, (pp) => frameRect({ width: S.fullW, height: S.fullH }, pp));
        renderOptions();
      },
    }));
  }
  o.append(tiles);
  if (cur.aspect !== 'original') {
    o.append(slider({
      name: 'Zoom', value: Math.round(((cur.zoom || 1) - 1) * 50), min: 0, max: 100, def: 0,
      onInput: (v) => {
        if (S.pending?.type !== 'frame') setPending({ type: 'frame', params: { ...cur } }, 'Framing');
        S.view.updateCrop({ zoom: 1 + v / 50 });
      },
    }));
    const r = frameRect({ width: S.fullW, height: S.fullH }, cur);
    o.append(h('p', { class: 'opt-sub' }, `Download size: ${r.w} × ${r.h} px`));
  }
  S.view.onCropChange = (params) => {
    if (S.pending?.type === 'frame') S.pending.params = { ...params };
    else setPending({ type: 'frame', params: { ...params } }, 'Framing');
  };
}

// ---------------------------------------------------------------- top bar actions
els.undo.addEventListener('click', async () => { if (S.pending) return; busy(true, 'Undoing'); try { await S.history.undo(); await refresh(); } finally { busy(false); renderOptions(); } });
els.redo.addEventListener('click', async () => { if (S.pending) return; busy(true, 'Redoing'); try { await S.history.redo(); await refresh(); } finally { busy(false); renderOptions(); } });

const holdOn = (e) => { e.preventDefault(); if (S.history) S.view.setHolding(true); };
const holdOff = () => S.view.setHolding(false);
els.compare.addEventListener('pointerdown', holdOn);
els.compare.addEventListener('pointerup', holdOff);
els.compare.addEventListener('pointerleave', holdOff);
els.compare.addEventListener('pointercancel', holdOff);
els.compare.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); S.view.setHolding(true); } });
els.compare.addEventListener('keyup', holdOff);

els.split.addEventListener('click', () => {
  const on = els.split.getAttribute('aria-pressed') !== 'true';
  els.split.setAttribute('aria-pressed', String(on));
  S.view.setSplit(on);
});

els.more.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = els.menu.hidden;
  els.menu.hidden = !open;
  els.more.setAttribute('aria-expanded', String(open));
  if (open) els.menu.querySelector('button:not([hidden])')?.focus();
});
document.addEventListener('click', (e) => { if (!els.menu.hidden && !e.target.closest('#menu')) { els.menu.hidden = true; els.more.setAttribute('aria-expanded', 'false'); } });
els.menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { els.menu.hidden = true; els.more.focus(); } });
const closeMenu = () => { els.menu.hidden = true; els.more.setAttribute('aria-expanded', 'false'); };

async function renderExport(type = 'image/jpeg') {
  if (!(await guardPending())) return null;
  busy(true, 'Preparing your download', { sub: 'Full resolution' });
  try {
    const full = await S.history.current();
    const frame = S.history.frameAt();
    const r = frameRect(full, frame);
    const c = cropToCanvas(full, r, r.w, r.h);
    const blob = await canvasToBlob(c, type, type === 'image/jpeg' ? 0.93 : undefined);
    c.width = 1; c.height = 1;
    return { blob, w: r.w, h: r.h };
  } finally { busy(false); }
}

async function download(type) {
  try {
    const out = await renderExport(type);
    if (!out) return;
    const url = URL.createObjectURL(out.blob);
    const a = h('a', { href: url, download: exportFileName(type === 'image/png' ? 'png' : 'jpg') });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    S.dirty = false;
    toast(`Downloaded ${out.w} × ${out.h} px.`);
  } catch (err) { toast(errorMessage(err), { type: 'error' }); }
}
els.download.addEventListener('click', () => download('image/jpeg'));
$('#m-png').addEventListener('click', () => { closeMenu(); download('image/png'); });

if (navigator.canShare?.({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' })] })) $('#m-share').hidden = false;
$('#m-share').addEventListener('click', async () => {
  closeMenu();
  const out = await renderExport('image/jpeg');
  if (!out) return;
  try { await navigator.share({ files: [new File([out.blob], exportFileName('jpg'), { type: 'image/jpeg' })] }); S.dirty = false; } catch { /* user canceled */ }
});

$('#m-save').addEventListener('click', async () => {
  closeMenu();
  const out = await renderExport('image/jpeg');
  if (!out) return;
  try {
    await saveProject(out.blob, out.w, out.h);
    S.dirty = false;
    toast('Saved to Projects on this device.', { action: 'View', onAction: () => { location.href = '/projects'; } });
  } catch { toast("Couldn't save to Projects (browser storage may be full or disabled).", { type: 'error' }); }
});

$('#m-new').addEventListener('click', () => { closeMenu(); els.file.click(); });

$('#m-reset').addEventListener('click', async () => {
  closeMenu();
  if (!S.history?.hasEdits()) { toast('There are no edits to reset.'); return; }
  if (S.pending) await cancelPending();
  busy(true, 'Resetting');
  try { await S.history.push({ type: 'reset' }, 'Reset'); await refresh(); toast('All edits reset. Use Undo to bring them back.', { action: 'Undo', onAction: () => els.undo.click() }); }
  finally { busy(false); renderOptions(); }
});

$('#m-delete').addEventListener('click', async () => {
  closeMenu();
  if (!(await confirmDialog('Delete this photo?', 'This removes the photo and all edits from this page, cancels any AI edit in progress and asks our server to discard anything it still holds. Downloads and saved Projects are not affected.', 'Delete photo', { danger: true }))) return;
  S.abort?.abort();
  resetState();
  S.engine.clear();
  S.full = null; S.prevAfter = null; S.prevBefore = null;
  S.view.setImages({ after: null, before: null });
  els.options.replaceChildren(); els.tools.replaceChildren();
  els.upload.hidden = false;
  document.body.classList.add('no-photo');
  syncButtons();
  try { await deleteServerSession(); } catch { /* offline: nothing held server-side beyond the job TTL */ }
  toast('Photo deleted from this page.');
});

// ---------------------------------------------------------------- input wiring
els.file.addEventListener('change', () => openFile(els.file.files?.[0]));
els.camera.addEventListener('change', () => openFile(els.camera.files?.[0]));
for (const ev of ['dragenter', 'dragover']) els.stage.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('drag'); });
for (const ev of ['dragleave', 'drop']) els.stage.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove('drag'); });
els.stage.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) openFile(f); });
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) openFile(f);
});

window.addEventListener('keydown', (e) => {
  if (!S.history || e.target.closest('input, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (!els.undo.disabled) els.undo.click(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); if (!els.redo.disabled) els.redo.click(); }
  else if (e.key === 'Escape' && S.pending) cancelPending();
  else if (e.key === '\\' && !e.repeat) S.view.setHolding(true);
});
window.addEventListener('keyup', (e) => { if (e.key === '\\') S.view.setHolding(false); });

window.addEventListener('beforeunload', (e) => {
  if (S.history?.hasEdits() && S.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- start
(async () => {
  S.config = await getConfig();
  loadFaceModels().catch(() => {}); // warm up in the background
  renderTools();
})();

// Expose a tiny hook for automated tests.
window.__cs = { S, openFile };
