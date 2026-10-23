/**
 * Tiny IndexedDB key/value store for offline-first boot.
 *
 * The master catalog is the heavy, slow request (multi-MB). We persist it here
 * so a returning user paints instantly from cache while a fresh copy is fetched
 * in the background (stale-while-revalidate). All ops degrade to no-op/null when
 * IndexedDB is unavailable, so nothing here is load-bearing.
 */

import type { MasterCatalogResponse } from '@shared/types/catalog';

const DB_NAME = 'tmgo';
const STORE = 'kv';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

export async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * What a cached catalog is compared by. The content hash the server stamps on
 * the body, never the counts alone: a release that moves a service off a
 * platform changes no count, and a count signature kept the old catalog on
 * every phone that updated (spec §5.2.1b). A body cached before the hash
 * existed has only its counts, which differ from any hash, so it is replaced.
 */
export function catalogSignature(payload: MasterCatalogResponse): string {
  if (payload.version) return payload.version;
  const c = payload.data || { stations: {}, routes: {} };
  return `${payload.count}:${Object.keys(c.routes || {}).length}:${Object.keys(c.stations || {}).length}`;
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* cache write is best-effort */
  }
}
