/** Minimal IndexedDB key-value store. CryptoKey objects are stored as non-extractable keys (structured clone). */
const DB = 'bw-link';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error ?? new Error('indexedDB unavailable'));
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((ok, bad) => { const r = db.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => ok(r.result as T | undefined); r.onerror = () => bad(r.error ?? new Error('read failed')); });
}

export async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((ok, bad) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(value, key); tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error ?? new Error('write failed')); });
}

export async function idbDel(key: string): Promise<void> {
  const db = await open();
  return new Promise((ok, bad) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(key); tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error ?? new Error('delete failed')); });
}
