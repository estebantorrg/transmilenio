/* TransMilenio Explorer — service worker.
 * Speeds up repeat loads without risking stale deploys:
 *   - /assets/* (Vite-fingerprinted, immutable)  → cache-first
 *   - /models, /draco, fonts (unhashed static)   → cache-first
 *   - /api/troncal/master-catalog (heavy JSON)    → network-first (fresh, cache = offline fallback)
 *   - navigations (index.html shell)              → network-first (cache fallback)
 * Everything else (live /api/*) is left to the network.
 */
const VERSION = 'tm-cache-v4';
const CACHE = `${VERSION}`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw new Error('offline and not cached');
  }
}

// Network-first for the heavy master catalog. Stale-while-revalidate was
// serving a cached copy first and revalidating in the background, which could
// pin a stale catalog in the SW cache across a deploy — the app kept rendering
// phantom route mappings even though the server was already fixed. Network-first
// always fetches fresh (`no-cache` forces an etag revalidation: a fast 304 when
// unchanged, full body when changed) and only falls back to the cached copy when
// offline, so a deployed catalog fix always lands on the next load.
async function networkFirstFresh(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw new Error('offline and not cached');
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only same-origin

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.includes('master-catalog')) event.respondWith(networkFirstFresh(req));
    return; // live endpoints: straight to network
  }

  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/models/') ||
    url.pathname.startsWith('/draco/') ||
    /\.(woff2?|ttf|png|jpg|jpeg|svg|glb|wasm)$/i.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  }
});
