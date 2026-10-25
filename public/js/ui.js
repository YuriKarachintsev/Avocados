import { icons } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ------------------------------------------------------------- API
export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, signal, raw = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, body, signal, credentials: 'same-origin',
      headers: { ...(method !== 'GET' ? { 'X-CS-Request': '1' } : {}), ...headers },
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', navigator.onLine === false
      ? 'You appear to be offline. Check your connection and try again.'
      : 'Could not reach CAREer Studio. Check your connection and try again.');
  }
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    const e = payload?.error || {};
    throw new ApiError(res.status, e.code || 'error', e.message || `Request failed (${res.status}).`, e.fields);
  }
  if (raw) return res;
  const type = res.headers.get('content-type') || '';
  return type.includes('application/json') ? res.json() : res;
}

let configPromise = null;
export function getConfig() {
  if (!configPromise) {
    configPromise = api('/api/config').catch(() => ({
      brand: 'CAREer Studio', ai: { enabled: false, presets: {} }, contact: { enabled: false }, limits: {}, offline: true,
    }));
  }
  return configPromise;
}

// ------------------------------------------------------------- toast
let toastHost;
export function toast(message, { type = 'info', action, onAction, timeout = 5000 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast ${type === 'error' ? 'error' : ''}` }, h('span', {}, message));
  if (action) el.append(h('button', { type: 'button', onclick: () => { onAction?.(); el.remove(); } }, action));
  toastHost.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

// ------------------------------------------------------------- modal
export function modal({ title, body, actions = [], dismissible = true, labelledBy }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const id = labelledBy || `m-${Math.random().toString(36).slice(2)}`;
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id });
    box.append(h('h2', { id }, title));
    if (typeof body === 'string') box.append(h('p', {}, body)); else if (body) box.append(body);
    const row = h('div', { class: 'actions' });
    for (const a of actions) {
      row.append(h('button', {
        type: 'button', class: `btn ${a.primary ? 'btn-shine' : ''} ${a.danger ? 'btn-danger' : ''}`,
        onclick: () => close(a.value),
      }, a.primary ? h('span', {}, a.label) : a.label));
    }
    box.append(row);
    const backdrop = h('div', { class: 'modal-backdrop' }, box);
    function close(v) {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
      resolve(v);
    }
    function onKey(e) {
      if (e.key === 'Escape' && dismissible) close(undefined);
      if (e.key === 'Tab') {
        const f = $$('button, [href], input, textarea, select', box).filter((x) => !x.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop && dismissible) close(undefined); });
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    (box.querySelector('.actions .btn-shine') || box.querySelector('button'))?.focus();
    backdrop.close = close;
  });
}

export function confirmDialog(title, text, okLabel = 'Continue', { danger = false } = {}) {
  return modal({
    title, body: text,
    actions: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  }).then(Boolean);
}

// ------------------------------------------------------------- chrome
const NAV = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/projects', label: 'Projects', icon: 'image' },
  { href: '/editor', label: 'Tools', icon: 'tools' },
  { href: '/profile', label: 'Profile', icon: 'user' },
];

export function brandMark() {
  return `${icons.sparkle}<span class="brand-name">CAREer <span class="studio">Studio</span></span>`;
}

export function mountChrome(active) {
  const current = NAV.find((n) => n.href === active) || NAV[0];
  for (const host of $$('[data-top-links]')) {
    host.append(...NAV.map((n) => h('a', { href: n.href, 'aria-current': n === current ? 'page' : null }, n.label)));
  }
  for (const host of $$('[data-brand]')) host.innerHTML = brandMark();
  if (!document.querySelector('.bottom-nav') && !document.body.classList.contains('editor-body')) {
    const nav = h('nav', { class: 'bottom-nav', 'aria-label': 'Main' });
    for (const n of NAV) {
      const a = h('a', { href: n.href, 'aria-current': n === current ? 'page' : null });
      a.innerHTML = (n === current && n.icon === 'home' ? icons.homeFilled : icons[n.icon]) + `<span>${n.label}</span>`;
      nav.append(a);
    }
    document.body.append(nav);
  }
  for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icons[el.dataset.icon] || '');
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
