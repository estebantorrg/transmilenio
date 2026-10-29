/* TransMilenio Explorer — service worker.
 * Speeds up repeat loads without risking stale deploys:
 *   - /assets/* (Vite-fingerprinted, immutable)  → cache-first
 *   - /models, /draco, fonts (unhashed static)   → cache-first
 *   - /api/troncal/master-catalog (heavy JSON)    → network-first (fresh, cache = offline fallback)
 *   - navigations (index.html shell)              → network-first (cache fallback)
 * Everything else (live /api/*) is left to the network.
 */
// Bumped when the cached surface changes (spec §5.5.2). v5: the web fonts moved
// from fonts.gstatic.com to same-origin /fonts/*.woff2, so a v4 cache would keep
// serving a shell that asks a third party for type it now ships itself.
const VERSION = 'tm-cache-v5';
const CACHE = `${VERSION}`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// How many /assets/* files the cache keeps. A build is about five of them and
// every deploy fingerprints a new set; nothing ever removed the old ones, so a
// rider who opens the site daily kept every bundle they had ever loaded.
// shortcut: a count, not a build manifest — the oldest inserts go first, which
// are the previous builds; raise it if one build ever ships more files than this.
const MAX_ASSETS = 40;
const isBuildAsset = (req) => new URL(req.url).pathname.startsWith('/assets/');

async function trimAssets(cache) {
  const assets = (await cache.keys()).filter(isBuildAsset);
  await Promise.all(assets.slice(0, Math.max(0, assets.length - MAX_ASSETS)).map((req) => cache.delete(req)));
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const stored = cache.put(req, res.clone());
    if (isBuildAsset(req)) stored.then(() => trimAssets(cache)).catch(() => {});
  }
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
  // The catalog also comes from its edge cache on another origin (scripts/catalog-cdn):
  // keep the same offline copy of it.
  if (url.origin !== self.location.origin) {
    if (url.pathname === '/master-catalog') event.respondWith(networkFirstFresh(req));
    return; // otherwise only same-origin
  }

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
