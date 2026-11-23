// IndexedDB wrapper exposing the same get/put/del/keys/clear shape as the engine's MemoryDB.
// One database per signed-in user. Everything except `meta` is stored sealed with the master key.
const BUCKETS = ['meta', 'keystore', 'sessions', 'convmeta', 'plain', 'outbox', 'rowcache', 'convcache'];

export class IDBStore {
  constructor(db, name) { this.db = db; this.name = name; }
  _tx(bucket, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(bucket, mode);
      const os = tx.objectStore(bucket);
      let out;
      try { out = fn(os); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  get(bucket, key) { return this._tx(bucket, 'readonly', (os) => os.get(key)); }
  put(bucket, key, val) { return this._tx(bucket, 'readwrite', (os) => os.put(val, key)); }
  del(bucket, key) { return this._tx(bucket, 'readwrite', (os) => os.delete(key)); }
  keys(bucket) { return this._tx(bucket, 'readonly', (os) => os.getAllKeys()); }
  clear(bucket) { return this._tx(bucket, 'readwrite', (os) => os.clear()); }
  /** Erase everything on this device for this user. */
  destroy() {
    this.db.close();
    return new Promise((resolve) => { const r = indexedDB.deleteDatabase(this.name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  }
}

export function openStore(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { for (const b of BUCKETS) if (!req.result.objectStoreNames.contains(b)) req.result.createObjectStore(b); };
    req.onsuccess = () => resolve(new IDBStore(req.result, name));
    req.onerror = () => reject(req.error);
  });
}

/** Adapter for VaultCore's tiny KV (unsealed `meta` bucket). */
export const metaKV = (store) => ({ get: (k) => store.get('meta', k), put: (k, v) => store.put('meta', k, v) });
