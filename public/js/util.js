// Small byte/encoding helpers shared by the browser client and the Node tests.
export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function b64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function concat(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
export function rand(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
export function ctEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export function hex(bytes) {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
}
export const randId = (n = 16) => hex(rand(n));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clone = (o) => JSON.parse(JSON.stringify(o));

export class CryptoError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'CryptoError';
    this.code = code;
  }
}

/** Per-key async mutex: operations on one conversation never interleave. */
export class KeyedLock {
  constructor() { this.tails = new Map(); }
  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

/**
 * Write-behind persister that is correct under concurrency (spec 7.10):
 * if a mutation lands while an async write is in flight, the write repeats.
 * The dirty flag is cleared BEFORE the snapshot is taken but a new mutation
 * during the await sets it again, so the newest state is never lost.
 */
export class Persister {
  constructor(snapshotFn, writeFn) {
    this.snapshotFn = snapshotFn;
    this.writeFn = writeFn;
    this.dirty = false;
    this.running = null;
  }
  mark() {
    this.dirty = true;
    if (!this.running) this.running = this._loop();
    return this.running;
  }
  async _loop() {
    try {
      while (this.dirty) {
        this.dirty = false;
        const snap = this.snapshotFn();
        await this.writeFn(snap);
      }
    } finally {
      this.running = null;
    }
  }
  flush() { return this.running || Promise.resolve(); }
}
