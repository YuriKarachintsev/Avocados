// Sends enquiries and applications to a Telegram chat via the Bot API.
// The bot token stays on the server; the browser never sees it.
import { HttpError, sniffImage, sniffDocument } from './http-utils.js';

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
const PHONE = /^[+()\-.\s0-9]{5,30}$/;

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clean(v, max) {
  if (v === undefined || v === null) return '';
  // strip control characters except newlines/tabs, collapse runaway whitespace
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function decodeBase64(b64, maxBytes, label) {
  if (typeof b64 !== 'string' || !b64) throw new HttpError(400, 'bad_file', `The ${label} could not be read.`);
  const s = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) throw new HttpError(400, 'bad_file', `The ${label} could not be read.`);
  const buf = Buffer.from(s, 'base64');
  if (buf.length > maxBytes) throw new HttpError(413, 'too_large', `The ${label} is too large (max ${Math.round(maxBytes / 1048576)} MB).`);
  return buf;
}

// Validate a submission. Returns a normalised object or throws HttpError(400).
export function validateSubmission(body, now = Date.now()) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'bad_request', 'The form could not be read.');
  const errors = {};
  const kind = body.kind === 'application' ? 'application' : 'enquiry';
  const name = clean(body.name, 100);
  const email = clean(body.email, 254);
  const phone = clean(body.phone, 30);
  const position = clean(body.position, 120);
  const company = clean(body.company, 120);
  const message = clean(body.message, 3000);

  if (name.length < 2) errors.name = 'Enter your name.';
  if (!EMAIL.test(email)) errors.email = 'Enter a valid email address.';
  if (phone && !PHONE.test(phone)) errors.phone = 'Use digits, spaces and + ( ) - only.';
  if (kind === 'application' && position.length < 2) errors.position = 'Tell us which role you are applying for.';
  if (message.length < 5) errors.message = 'Add a short message.';
  if (body.consent !== true) errors.consent = 'Please confirm we may contact you about this request.';

  // Bot protection: hidden honeypot field must stay empty, and a human takes a few seconds.
  const bot = Boolean(clean(body.website, 200)) ||
    !(Number(body.startedAt) > 0 && now - Number(body.startedAt) > 2500 && now - Number(body.startedAt) < 24 * 3600 * 1000);

  let photo = null;
  if (body.attachPhoto === true) {
    if (body.photoConsent !== true) {
      errors.photoConsent = 'Tick the photo-sharing box to attach your photo, or remove the photo.';
    } else if (body.photo) {
      const buf = decodeBase64(body.photo, 8 * 1024 * 1024, 'photo');
      const info = sniffImage(buf);
      if (!info || !['image/jpeg', 'image/png', 'image/webp'].includes(info.type)) {
        errors.photo = 'The photo must be a JPEG, PNG or WebP image.';
      } else {
        photo = { buffer: buf, type: info.type };
      }
    }
  }

  let cv = null;
  if (body.cv && kind === 'application') {
    const buf = decodeBase64(body.cv.data, 5 * 1024 * 1024, 'CV');
    const type = sniffDocument(buf);
    if (!type) errors.cv = 'Upload your CV as PDF or Word (.docx or .doc).';
    else {
      const ext = type === 'application/pdf' ? '.pdf' : type === 'application/msword' ? '.doc' : '.docx';
      const base = (clean(body.cv.name, 80).replace(/\.(pdf|docx?|)$/i, '').replace(/[^\w.\- ]+/g, '_') || 'cv') + ext;
      cv = { buffer: buf, type, name: base };
    }
  }

  if (Object.keys(errors).length) throw new HttpError(400, 'invalid', 'Please check the highlighted fields.', { fields: errors });
  return { kind, name, email, phone, position, company, message, photo, cv, bot };
}

export function formatMessage(s, brand) {
  const lines = [
    `<b>${escapeHtml(brand)} — new ${s.kind === 'application' ? 'application' : 'enquiry'}</b>`,
    '',
    `<b>Name:</b> ${escapeHtml(s.name)}`,
    `<b>Email:</b> ${escapeHtml(s.email)}`,
  ];
  if (s.phone) lines.push(`<b>Phone:</b> ${escapeHtml(s.phone)}`);
  if (s.company) lines.push(`<b>Company:</b> ${escapeHtml(s.company)}`);
  if (s.position) lines.push(`<b>Role:</b> ${escapeHtml(s.position)}`);
  lines.push('', escapeHtml(s.message));
  const extras = [];
  if (s.photo) extras.push('photo (shared with explicit opt-in)');
  if (s.cv) extras.push('CV');
  if (extras.length) lines.push('', `<i>Attached: ${extras.join(', ')}</i>`);
  return lines.join('\n').slice(0, 4000);
}

export class TelegramClient {
  constructor({ token, chatId, apiBase, fetchImpl = fetch }) {
    this.token = token;
    this.chatId = chatId;
    this.apiBase = apiBase;
    this.fetch = fetchImpl;
  }

  async call(method, body, isForm = false) {
    const url = `${this.apiBase}/bot${this.token}/${method}`;
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        body: isForm ? body : JSON.stringify(body),
        headers: isForm ? {} : { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new HttpError(502, 'delivery_failed', "We couldn't send your message right now. Please try again in a few minutes.");
    }
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    if (!res.ok || !json?.ok) {
      throw new HttpError(502, 'delivery_failed', "We couldn't send your message right now. Please try again in a few minutes.");
    }
    return json.result;
  }

  async send(submission, brand) {
    await this.call('sendMessage', {
      chat_id: this.chatId,
      text: formatMessage(submission, brand),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    const who = escapeHtml(submission.name).slice(0, 80);
    if (submission.photo) {
      const form = new FormData();
      form.append('chat_id', this.chatId);
      form.append('caption', `Photo from ${who} (shared with explicit opt-in)`);
      const ext = submission.photo.type === 'image/png' ? 'png' : submission.photo.type === 'image/webp' ? 'webp' : 'jpg';
      // sendDocument keeps full resolution (sendPhoto recompresses)
      form.append('document', new Blob([submission.photo.buffer], { type: submission.photo.type }), `photo.${ext}`);
      await this.call('sendDocument', form, true);
    }
    if (submission.cv) {
      const form = new FormData();
      form.append('chat_id', this.chatId);
      form.append('caption', `CV from ${who}`);
      form.append('document', new Blob([submission.cv.buffer], { type: submission.cv.type }), submission.cv.name);
      await this.call('sendDocument', form, true);
    }
  }
}
