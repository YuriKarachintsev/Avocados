// Minimal Replicate HTTP API client (https://replicate.com/docs/reference/http).
// Uses Node's built-in fetch, FormData and Blob — no SDK dependency.
import { HttpError } from './http-utils.js';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

export class ReplicateClient {
  constructor({ token, apiBase, outputHosts, timeoutMs, fetchImpl = fetch }) {
    this.token = token;
    this.apiBase = apiBase;
    this.outputHosts = outputHosts;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.versionCache = new Map();
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  async request(method, path, { body, headers, signal, expect = [200, 201] } = {}) {
    const res = await this.fetch(`${this.apiBase}${path}`, { method, body, headers: this.headers(headers), signal });
    if (!expect.includes(res.status)) {
      let detail = '';
      try { const j = await res.json(); detail = j.detail || j.title || JSON.stringify(j).slice(0, 300); } catch { /* ignore */ }
      const err = new HttpError(502, 'provider_error', providerMessage(res.status), { providerStatus: res.status });
      err.detail = detail;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // Upload an input file so large photos are passed by URL, not inline.
  async uploadFile(buffer, contentType, filename, signal) {
    const form = new FormData();
    form.append('content', new Blob([buffer], { type: contentType }), filename);
    form.append('filename', filename);
    form.append('type', contentType);
    const file = await this.request('POST', '/files', { body: form, signal });
    const url = file?.urls?.get;
    if (!file?.id || !url) throw new HttpError(502, 'provider_error', 'The AI service did not accept the upload.');
    return { id: file.id, url };
  }

  async deleteFile(id) {
    try {
      await this.request('DELETE', `/files/${encodeURIComponent(id)}`, { expect: [200, 202, 204, 404] });
      return true;
    } catch {
      return false;
    }
  }

  async resolveVersion(model) {
    if (this.versionCache.has(model)) return this.versionCache.get(model);
    const [owner, name] = model.split('/');
    const info = await this.request('GET', `/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    const id = info?.latest_version?.id;
    if (!id) throw new HttpError(502, 'provider_error', 'The AI model is not available right now.');
    this.versionCache.set(model, id);
    return id;
  }

  // model: "owner/name" (official model endpoint) or "owner/name:version".
  // community: true → resolve latest version and use /predictions.
  async run(model, input, { signal, community = false, onStatus } = {}) {
    const deadline = Date.now() + this.timeoutMs;
    let prediction;
    const headers = { 'Content-Type': 'application/json', Prefer: 'wait=55' };
    if (model.includes(':') || community) {
      const version = model.includes(':') ? model.split(':')[1] : await this.resolveVersion(model);
      prediction = await this.request('POST', '/predictions', { body: JSON.stringify({ version, input }), headers, signal });
    } else {
      const [owner, name] = model.split('/');
      prediction = await this.request('POST', `/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`,
        { body: JSON.stringify({ input }), headers, signal });
    }
    onStatus?.(prediction.status, prediction.id);
    try {
      while (!TERMINAL.has(prediction.status)) {
        if (Date.now() > deadline) throw new HttpError(504, 'timeout', 'The AI service took too long. Please try again.');
        await sleep(1500, signal);
        prediction = await this.request('GET', `/predictions/${encodeURIComponent(prediction.id)}`, { signal });
        onStatus?.(prediction.status, prediction.id);
      }
    } catch (err) {
      if (prediction?.id && !TERMINAL.has(prediction.status)) await this.cancel(prediction.id);
      throw err;
    }
    if (prediction.status === 'failed') {
      const msg = String(prediction.error || '');
      if (/nsfw|safety|flagged|moderat/i.test(msg)) {
        throw new HttpError(422, 'content_filtered', "The AI service declined this photo. Try a different photo or style.");
      }
      throw new HttpError(502, 'provider_failed', 'The AI service could not process this photo. Please try again.');
    }
    if (prediction.status === 'canceled') throw new HttpError(499, 'canceled', 'Canceled.');
    const url = firstUrl(prediction.output);
    if (!url) throw new HttpError(502, 'provider_error', 'The AI service returned no image.');
    return { url, predictionId: prediction.id };
  }

  async cancel(id) {
    try { await this.request('POST', `/predictions/${encodeURIComponent(id)}/cancel`, { expect: [200, 201, 202, 404, 409] }); } catch { /* ignore */ }
  }

  isAllowedOutputUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) return false;
    return this.outputHosts.some((h) => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h));
  }

  async download(url, { signal, maxBytes = 30 * 1024 * 1024 } = {}) {
    let res;
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!this.isAllowedOutputUrl(current)) throw new HttpError(502, 'provider_error', 'The AI service returned an unexpected location.');
      const needsAuth = current.startsWith(this.apiBase);
      res = await this.fetch(current, { signal, headers: needsAuth ? this.headers() : {}, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      break;
    }
    if (!res.ok) throw new HttpError(502, 'provider_error', 'Could not fetch the AI result.');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new HttpError(502, 'provider_error', 'The AI result was too large.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new HttpError(502, 'provider_error', 'The AI result was too large.');
    return { buffer: buf, contentType: res.headers.get('content-type') || 'application/octet-stream' };
  }
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function firstUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.find((o) => typeof o === 'string') || null;
  if (typeof output === 'object') {
    for (const v of Object.values(output)) {
      const u = firstUrl(v);
      if (u) return u;
    }
  }
  return null;
}

function providerMessage(status) {
  if (status === 401 || status === 403) return 'The AI service is not set up correctly on this server.';
  if (status === 402) return 'The AI service account has run out of credit.';
  if (status === 429) return 'The AI service is busy. Please try again in a minute.';
  if (status === 422) return 'The AI service could not use this photo.';
  return 'The AI service is unavailable right now. Please try again shortly.';
}
