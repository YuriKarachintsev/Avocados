import { mountChrome, $, $$, h, api, getConfig, toast, confirmDialog, fileToBase64, formatBytes, ApiError } from './ui.js';
import { listProjects, deleteAllProjects } from './store.js';
import { deleteServerSession, hasConsent, revokeConsent } from './editor/ai-client.js';

mountChrome('/profile');

const form = $('#contact-form');
const startedAt = Date.now();
let kind = 'enquiry';
let photoBlob = null;
let photoUrl = null;

// ------------------------------------------------------------ request type
for (const b of $$('[data-kind]', form)) {
  b.addEventListener('click', () => setKind(b.dataset.kind));
}
function setKind(k) {
  kind = k;
  for (const b of $$('[data-kind]', form)) b.setAttribute('aria-pressed', String(b.dataset.kind === k));
  for (const el of $$('[data-for]', form)) el.hidden = el.dataset.for !== k;
  $('#submit-label').textContent = k === 'application' ? 'Send application' : 'Send enquiry';
}
if (location.hash === '#apply') setKind('application');

// ------------------------------------------------------------ photo (separate opt-in)
function setPhoto(blob) {
  photoBlob = blob;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = blob ? URL.createObjectURL(blob) : null;
  const img = $('#photo-preview');
  img.hidden = !blob;
  if (blob) { img.src = photoUrl; img.style.maxWidth = '180px'; img.style.borderRadius = '14px'; }
  $('#photo-consent-row').hidden = !blob;
  $('#photo-clear').hidden = !blob;
  $('#f-photo-consent').checked = false; // consent is always given fresh for each photo
}
$('#pick-project').addEventListener('click', async () => {
  try {
    const items = await listProjects();
    if (!items.length) { toast('No saved photos yet. Save one from the editor first.'); return; }
    setPhoto(items[0].blob);
  } catch { toast('Browser storage is unavailable here.', { type: 'error' }); }
});
$('#f-photo').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (f.size > 8 * 1048576) { toast(`That photo is ${formatBytes(f.size)}; the limit is 8 MB.`, { type: 'error' }); e.target.value = ''; return; }
  setPhoto(f);
  e.target.value = '';
});
$('#photo-clear').addEventListener('click', () => setPhoto(null));

// ------------------------------------------------------------ submit
function showErrors(fields = {}) {
  for (const el of $$('[data-err]', form)) el.textContent = fields[el.dataset.err] || '';
  for (const inp of $$('input, textarea', form)) inp.removeAttribute('aria-invalid');
  for (const k of Object.keys(fields)) {
    const inp = form.querySelector(`[name="${k}"]`) || $(`#f-${k}`);
    inp?.setAttribute('aria-invalid', 'true');
  }
  const first = Object.keys(fields)[0];
  if (first) (form.querySelector(`[name="${first}"]`) || $(`#f-${first}`))?.focus();
}

function status(text, type = '') {
  const s = $('#form-status');
  s.hidden = !text;
  s.className = `notice ${type}`;
  s.textContent = text || '';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status('');
  const fd = new FormData(form);
  const body = {
    kind, name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), message: fd.get('message'),
    company: kind === 'enquiry' ? fd.get('company') : '', position: kind === 'application' ? fd.get('position') : '',
    consent: $('#f-consent').checked, website: fd.get('website'), startedAt,
    attachPhoto: Boolean(photoBlob), photoConsent: Boolean(photoBlob) && $('#f-photo-consent').checked,
  };
  const local = {};
  if (String(body.name || '').trim().length < 2) local.name = 'Enter your name.';
  if (!/^\S+@\S+\.\S+$/.test(String(body.email || ''))) local.email = 'Enter a valid email address.';
  if (kind === 'application' && String(body.position || '').trim().length < 2) local.position = "Tell us which role you're applying for.";
  if (String(body.message || '').trim().length < 5) local.message = 'Add a short message.';
  if (!body.consent) local.consent = 'Please confirm we may contact you about this request.';
  if (photoBlob && !body.photoConsent) local.photoConsent = 'Tick the photo-sharing box to send your photo, or remove the photo.';
  if (Object.keys(local).length) { showErrors(local); return; }
  showErrors({});

  const btn = $('#submit');
  btn.disabled = true;
  try {
    if (photoBlob && body.photoConsent) body.photo = await fileToBase64(photoBlob);
    const cvFile = kind === 'application' ? $('#f-cv').files?.[0] : null;
    if (cvFile) {
      if (cvFile.size > 5 * 1048576) { showErrors({ cv: 'Your CV must be 5 MB or smaller.' }); return; }
      body.cv = { name: cvFile.name, data: await fileToBase64(cvFile) };
    }
    status(kind === 'application' ? 'Sending your application…' : 'Sending your enquiry…');
    await api('/api/contact', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    form.reset();
    setPhoto(null);
    setKind(kind);
    status(`Sent. We'll reply to ${body.email}.`, 'ok');
  } catch (err) {
    if (err instanceof ApiError && err.fields) { showErrors(err.fields); status(err.message, 'error'); }
    else status(err.message || 'Sending failed. Please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ data controls
async function refreshData() {
  try { const items = await listProjects(); $('#data-projects').textContent = items.length ? `${items.length} on this device` : 'None'; } catch { $('#data-projects').textContent = 'Storage unavailable'; }
  $('#data-consent').textContent = hasConsent() ? 'Given' : 'Not given';
}
$('#delete-everything').addEventListener('click', async () => {
  if (!(await confirmDialog('Delete everything on this device?', 'Saved photos, settings and AI consent will be removed from this browser, and our server will discard any AI edit still running. This cannot be undone.', 'Delete everything', { danger: true }))) return;
  try { await deleteAllProjects(); } catch { /* storage unavailable */ }
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  try { await deleteServerSession(); } catch { /* offline */ }
  setPhoto(null);
  await refreshData();
  toast('Everything on this device has been deleted.');
});
$('#withdraw').addEventListener('click', async () => {
  revokeConsent();
  try { await deleteServerSession(); } catch { /* ignore */ }
  await refreshData();
  toast("AI consent withdrawn. You'll be asked again before any upload.");
});
refreshData();

// ------------------------------------------------------------ service status
getConfig().then((cfg) => {
  const rows = [
    ['On-device editing (retouch, light, adjust, background, crop)', true],
    ['AI editing (outfits, hair, smile, HD cut-out, AI offices)', cfg.ai?.enabled],
    ['Contact form', cfg.contact?.enabled],
  ];
  $('#services').replaceChildren(...rows.map(([label, on]) => h('li', {}, h('span', {}, label), h('span', { class: on ? 'status-on' : 'status-off' }, on ? 'Available' : 'Not set up'))));
  if (!cfg.contact?.enabled) {
    const off = $('#contact-off');
    off.hidden = false;
    off.textContent = 'The contact form is not set up on this server yet.';
    if (cfg.contact?.email) {
      off.append(' Email us instead: ', h('a', { href: `mailto:${cfg.contact.email}` }, cfg.contact.email));
    }
    $('#submit').disabled = true;
  }
});
