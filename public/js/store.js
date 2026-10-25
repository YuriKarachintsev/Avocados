// Saved photos live only in this browser (IndexedDB). Nothing is synced anywhere.
const DB = 'careerstudio';
const STORE = 'projects';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(store)).then((v) => { out = v; });
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

export async function saveProject(blob, width, height) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await tx('readwrite', (s) => s.put({ id, created: Date.now(), blob, width, height, type: blob.type }));
  return id;
}

export function listProjects() {
  return tx('readonly', (s) => new Promise((resolve) => {
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.created - a.created));
  }));
}

export function deleteProject(id) {
  return tx('readwrite', (s) => { s.delete(id); });
}

export function deleteAllProjects() {
  return tx('readwrite', (s) => { s.clear(); });
}
