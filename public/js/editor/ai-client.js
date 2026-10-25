// Talks to CAREer Studio's server, which relays to the AI service.
// The browser never holds any API key.
import { api, ApiError, modal, h } from '../ui.js';

const CONSENT_KEY = 'cs-ai-consent-v1';

export function hasConsent() {
  try { return sessionStorage.getItem(CONSENT_KEY) === 'yes'; } catch { return false; }
}

export async function ensureConsent(feature) {
  if (hasConsent()) return true;
  const body = h('div', { class: 'stack' },
    h('p', {}, `To ${feature}, a resized copy of your photo (or the part being edited) is sent from this page to our server and on to Replicate, Inc. (USA), which runs the AI model.`),
    h('ul', {},
      h('li', {}, 'Our server keeps the photo in memory only while the edit runs. It is not saved to disk or logged.'),
      h('li', {}, 'The upload to Replicate is deleted as soon as the edit finishes; Replicate removes remaining prediction data automatically after about an hour.'),
      h('li', {}, 'Your original stays on this device. Skin, Face, Makeup, Light, Adjust, Passport, Crop and the standard background cut-out work without uploading anything.'),
      h('li', {}, 'Only upload photos of yourself, or of people who have agreed to it.'),
    ),
    h('p', {}, h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Read the privacy notice')),
  );
  const ok = await modal({
    title: 'Send this photo for AI editing?', body,
    actions: [{ label: 'Not now', value: false }, { label: 'Agree and continue', value: true, primary: true }],
  });
  if (ok) { try { sessionStorage.setItem(CONSENT_KEY, 'yes'); } catch { /* ignore */ } }
  return Boolean(ok);
}

export function revokeConsent() {
  try { sessionStorage.removeItem(CONSENT_KEY); } catch { /* ignore */ }
}

// Start a job and wait for its result. onStage(text) reports progress.
export async function runAiJob({ feature, preset, blob, aspect, onStage, signal }) {
  const qs = new URLSearchParams({ feature });
  if (preset) qs.set('preset', preset);
  if (aspect) qs.set('aspect', aspect);
  onStage?.(blob ? 'Sending your photo securely' : 'Starting');
  const job = await api(`/api/ai/jobs?${qs}`, {
    method: 'POST', body: blob || null, headers: blob ? { 'Content-Type': blob.type } : {}, signal,
  });
  const id = job.id;
  const cancel = () => { api(`/api/ai/jobs/${id}`, { method: 'DELETE' }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const started = Date.now();
    let delay = 900;
    for (;;) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      const st = await api(`/api/ai/jobs/${id}`, { signal });
      if (st.stage) onStage?.(st.stage);
      if (st.status === 'succeeded') break;
      if (st.status === 'failed') throw new ApiError(502, st.error?.code || 'failed', st.error?.message || 'The AI edit failed. Please try again.');
      if (st.status === 'canceled') throw new DOMException('Canceled', 'AbortError');
      if (Date.now() - started > 180000) throw new ApiError(504, 'timeout', 'The AI service took too long. Please try again.');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(2000, delay + 200);
    }
    onStage?.('Downloading the result');
    const res = await api(`/api/ai/jobs/${id}/result`, { raw: true, signal });
    return await res.blob();
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function deleteServerSession() {
  revokeConsent();
  return api('/api/session/delete', { method: 'POST' });
}
