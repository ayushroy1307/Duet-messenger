const DB_NAME = 'duet';
const DB_VERSION = 1;
const STORES = ['kv', 'sealed', 'cache', 'media'];

let dbPromise = null;
let memoryFallback = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB failed'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  }).catch((error) => {
    console.warn('IndexedDB unavailable; using memory fallback', error.message);
    memoryFallback = new Map();
    return null;
  });
  return dbPromise;
}

function memoryGet(store, key) {
  return memoryFallback?.get(`${store}:${key}`);
}

function memorySet(store, key, value) {
  memoryFallback?.set(`${store}:${key}`, value);
}

function memoryDel(store, key) {
  memoryFallback?.delete(`${store}:${key}`);
}

function tx(db, store, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const objectStore = transaction.objectStore(store);
    let request;
    try {
      request = action(objectStore);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
  });
}

export async function dbGet(store, key) {
  const db = await openDatabase();
  if (!db) return memoryGet(store, key);
  return tx(db, store, 'readonly', (s) => s.get(key));
}

export async function dbPut(store, key, value) {
  const db = await openDatabase();
  if (!db) {
    memorySet(store, key, value);
    return;
  }
  return tx(db, store, 'readwrite', (s) => s.put(value, key));
}

export async function dbDelete(store, key) {
  const db = await openDatabase();
  if (!db) {
    memoryDel(store, key);
    return;
  }
  return tx(db, store, 'readwrite', (s) => s.delete(key));
}

export async function dbKeys(store) {
  const db = await openDatabase();
  if (!db) {
    return [...(memoryFallback?.keys() || [])]
      .filter((key) => key.startsWith(`${store}:`))
      .map((key) => key.slice(store.length + 1));
  }
  return tx(db, store, 'readonly', (s) => s.getAllKeys());
}

export async function dbEntries(store, prefix = '') {
  const db = await openDatabase();
  if (!db) {
    return [...(memoryFallback?.entries() || [])]
      .filter(([key]) => key.startsWith(`${store}:${prefix}`))
      .map(([key, value]) => [key.slice(store.length + 1), value]);
  }
  const keys = await tx(db, store, 'readonly', (s) => s.getAllKeys());
  const values = await tx(db, store, 'readonly', (s) => s.getAll());
  return keys
    .map((key, index) => [key, values[index]])
    .filter(([key]) => String(key).startsWith(prefix));
}

export async function dbDeletePrefix(store, prefix) {
  const keys = await dbKeys(store);
  const matching = keys.filter((key) => String(key).startsWith(prefix));
  await Promise.all(matching.map((key) => dbDelete(store, key)));
  return matching.length;
}

export async function dbClear(store) {
  const db = await openDatabase();
  if (!db) {
    if (!memoryFallback) return;
    for (const key of [...memoryFallback.keys()]) {
      if (key.startsWith(`${store}:`)) memoryFallback.delete(key);
    }
    return;
  }
  return tx(db, store, 'readwrite', (s) => s.clear());
}

export async function dbAvailable() {
  const db = await openDatabase();
  return Boolean(db);
}

export async function dbEstimate() {
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch { /* ignore */ }
  return { usage: 0, quota: 0 };
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}
