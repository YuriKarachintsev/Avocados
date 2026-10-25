// Operation-based undo/redo. Results are rebuilt from the nearest cached
// snapshot, so memory stays bounded even for large photos.

export class History {
  constructor(engine, original, meta, { budgetBytes } = {}) {
    this.engine = engine;
    this.meta = meta; // { faces, fullWidth }
    this.entries = [{ op: null, label: 'Original' }];
    this.pointer = 0;
    this.snapshots = new Map([[0, original]]);
    this.lru = [];
    const bytes = original.width * original.height * 4;
    const budget = budgetBytes || 256 * 1024 * 1024;
    this.maxSnapshots = Math.max(2, Math.floor(budget / bytes));
    this.listeners = new Set();
  }

  get original() { return this.snapshots.get(0); }
  get canUndo() { return this.pointer > 0; }
  get canRedo() { return this.pointer < this.entries.length - 1; }
  get label() { return this.entries[this.pointer].label; }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  touch(i) {
    this.lru = this.lru.filter((x) => x !== i);
    this.lru.push(i);
    while (this.snapshots.size > this.maxSnapshots) {
      const victim = this.lru.find((x) => x !== 0 && x !== this.pointer);
      if (victim === undefined) break;
      this.lru = this.lru.filter((x) => x !== victim);
      this.snapshots.delete(victim);
    }
  }

  // Ops from the most recent reset (or start) up to index.
  async render(index = this.pointer) {
    if (this.snapshots.has(index)) { this.touch(index); return this.snapshots.get(index); }
    let j = index;
    while (j > 0 && !this.snapshots.has(j) && this.entries[j].op?.type !== 'reset') j--;
    let base;
    let from;
    if (this.entries[j].op?.type === 'reset') { base = this.original; from = j + 1; } else { base = this.snapshots.get(j); from = j + 1; }
    const ops = this.entries.slice(from, index + 1).map((e) => e.op).filter((o) => o && o.type !== 'reset');
    const img = await this.engine.run(base, ops, this.meta);
    this.snapshots.set(index, img);
    this.touch(index);
    return img;
  }

  current() { return this.render(this.pointer); }

  async push(op, label, result) {
    this.entries.length = this.pointer + 1;
    for (const k of [...this.snapshots.keys()]) if (k > this.pointer) this.snapshots.delete(k);
    this.lru = this.lru.filter((k) => k <= this.pointer);
    this.entries.push({ op, label });
    this.pointer++;
    if (result) { this.snapshots.set(this.pointer, result); this.touch(this.pointer); }
    const img = await this.render(this.pointer);
    this.emit();
    return img;
  }

  async undo() { if (!this.canUndo) return null; this.pointer--; const img = await this.render(); this.emit(); return img; }
  async redo() { if (!this.canRedo) return null; this.pointer++; const img = await this.render(); this.emit(); return img; }

  // Framing in effect at an index (framing is metadata, not pixels).
  frameAt(index = this.pointer) {
    for (let i = index; i > 0; i--) {
      const op = this.entries[i].op;
      if (op?.type === 'reset') return null;
      if (op?.type === 'frame') return op.params;
    }
    return null;
  }

  hasEdits() {
    for (let i = this.pointer; i > 0; i--) {
      const op = this.entries[i].op;
      if (op?.type === 'reset') return false;
      if (op) return true;
    }
    return false;
  }
}
