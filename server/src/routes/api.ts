import { Router, Request, Response } from 'express';
import { queries } from '../services/arcgis.js';
import * as tmApi from '../services/tm_api.js';

const router = Router();

/**
 * Simple in-memory cache with TTL.
 * Route/station data rarely changes — cache for 10 minutes.
 */
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Last-known live-bus positions per route. When every upstream path (direct,
 * relay, CO proxies) is momentarily down, we serve the most recent real fix
 * tagged `stale` instead of a blank map (spec §4.2 graceful degradation).
 */
const liveBusCache = new Map<string, { buses: any[]; at: number }>();
const LIVE_BUS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getCachedOrFetch(key: string, fetcher: () => Promise<any>): Promise<any> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[Cache] HIT: ${key}`);
    return cached.data;
  }

  console.log(`[Cache] MISS: ${key} — fetching from ArcGIS...`);
  const data = await fetcher();
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

// ─── Troncal Endpoints ────────────────────────────────────

router.get('/troncal/routes', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-routes', queries.troncalRoutes);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal routes' });
  }
});

router.get('/troncal/stations', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-stations', queries.troncalStations);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal stations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal stations' });
  }
});

router.get('/troncal/corridors', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-corridors', queries.troncalCorridors);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal corridors:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal corridors' });
  }
});

// ─── Master Catalog (from TransMi App API) ────────────────

router.get('/troncal/master-catalog', async (_req: Request, res: Response) => {
  try {
    const catalog = tmApi.getCatalogLight();
    const count = Object.keys(catalog.stations || {}).length;
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      success: true,
      data: catalog,
      count,
      stale: tmApi.isCatalogStale()
    });
  } catch (error) {
    console.error('Error fetching master catalog:', error);
    res.status(500).json({ success: false, error: 'Failed to load master catalog' });
  }
});

router.get('/troncal/route/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const catalog = tmApi.getCatalog();
    const routeVariants = catalog.routes[code];
    if (routeVariants && routeVariants.length > 0) {
      const enrichedVariants = routeVariants.map(variant => {
        if (!variant.stops) return variant;
        const enrichedStops = variant.stops.map(stop => {
          const station = catalog.stations[stop.codigo];
          return {
            ...stop,
            direccion: station?.direccion || ''
          };
        });
        return {
          ...variant,
          stops: enrichedStops
        };
      });
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.json({ success: true, data: enrichedVariants });
    } else {
      res.status(404).json({ success: false, error: `Route ${code} not found in catalog` });
    }
  } catch (error) {
    console.error(`Error fetching route detail for ${req.params.code}:`, error);
    res.status(500).json({ success: false, error: 'Failed to load route detail' });
  }
});

router.get('/troncal/station/:code', async (req: Request, res: Response) => {
  const { code } = req.params;
  const station = tmApi.getStationByCode(code);
  if (station) {
    res.json({ success: true, data: station });
  } else {
    res.status(404).json({ success: false, error: 'Station not found in catalog' });
  }
});

// Sync trigger
router.post('/troncal/sync', async (_req: Request, res: Response) => {
  if (tmApi.isSyncInProgress()) {
    res.json({ success: true, message: 'Sync already in progress' });
    return;
  }
  // Run in background
  tmApi.syncMasterCatalog().catch((err) => console.error('[Sync Error]', err));
  res.json({ success: true, message: 'Sync started in background' });
});

// ─── Zonal Endpoints ──────────────────────────────────────

router.get('/zonal/routes', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('zonal-routes', queries.zonalRoutes);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal routes' });
  }
});

router.get('/zonal/stops', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('zonal-stops', queries.zonalStops);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal stops:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal stops' });
  }
});

router.get('/zonal/stop-routes', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('zonal-stop-routes', queries.zonalStopRoutes);
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal stop routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal stop routes' });
  }
});

router.post('/buses', async (req: Request, res: Response) => {
  const ruta = req.body.ruta;
  const nombre = req.body.Nombre ?? req.body.nombre ?? '';
  const nombreCandidates = Array.isArray(req.body.nombreCandidates) ? req.body.nombreCandidates : [];
  const routeType: 'troncal' | 'zonal' = req.body.type === 'zonal' ? 'zonal' : 'troncal';
  const cacheKey = `${routeType}:${ruta}`;

  if (!ruta) {
    res.status(400).json({ success: false, error: 'ruta is required' });
    return;
  }

  try {
    console.log(`[/buses] Request: ruta="${ruta}" nombre="${nombre}" type=${routeType}`);
    const buses = await tmApi.fetchLiveBuses(ruta, nombre, routeType, nombreCandidates);
    console.log(`[/buses] Response: ${buses.length} buses for ruta="${ruta}"`);
    // Cache only non-empty fixes; an empty result is a valid "no buses now".
    if (buses.length > 0) liveBusCache.set(cacheKey, { buses, at: Date.now() });
    res.json({ success: true, count: buses.length, data: buses, stale: false });
  } catch (error: any) {
    console.error('[/buses] Error fetching live buses:', error);

    // Graceful degradation: serve the last known positions if still fresh.
    const cached = liveBusCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LIVE_BUS_CACHE_TTL) {
      const ageS = Math.round((Date.now() - cached.at) / 1000);
      console.log(`[/buses] Serving last-known ${cached.buses.length} buses for "${cacheKey}" (stale ${ageS}s)`);
      res.json({ success: true, count: cached.buses.length, data: cached.buses, stale: true, asOf: cached.at });
      return;
    }

    const msg = error.message || '';
    const payload: Record<string, any> = { success: false };
    if (req.query.debug === '1') {
      payload.detail = msg;
      payload.code = error.code;
    }

    if (msg.includes('timed out')) {
      res.status(504).json({ ...payload, error: 'Gateway Timeout connecting to live tracking API' });
    } else if (
      msg.includes('Live tracking unavailable') ||
      msg.includes('Status: 401') ||
      msg.includes('Unauthorized') ||
      error.code === 'ECONNRESET'
    ) {
      res.status(503).json({ ...payload, error: 'Live tracking service temporarily unavailable' });
    } else {
      res.status(500).json({ ...payload, error: 'Failed to fetch live buses due to internal error' });
    }
  }
});

// ─── Approximate Geolocation (IP fallback) ────────────────
// Used when the browser's native geolocation is unavailable (e.g. the OS/
// network location provider is blocked, returning POSITION_UNAVAILABLE).
// Resolves the *client's* IP to an approximate coordinate. Nothing is stored
// (spec §3.3 — zero PII storage); the client only calls /api/* (spec §2.3).

const GEOIP_TIMEOUT_MS = 5_000;
const PRIVATE_IP_RE = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i;

function getClientIp(req: Request): string | null {
  const ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '').trim();
  // Loopback / private ranges can't be geolocated — let the upstream fall back
  // to the request source IP instead of sending a useless private address.
  if (!ip || PRIVATE_IP_RE.test(ip)) return null;
  return ip;
}

router.get('/geoip', async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const url = ip
    ? `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`
    : 'https://get.geojs.io/v1/ip/geo.json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOIP_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { signal: controller.signal });
    if (!upstream.ok) throw new Error(`geojs status ${upstream.status}`);

    const data = await upstream.json() as { latitude?: string; longitude?: string; city?: string };
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      res.status(502).json({ success: false, error: 'Could not resolve approximate location' });
      return;
    }

    res.json({
      success: true,
      source: 'ip',
      latitude,
      longitude,
      city: typeof data.city === 'string' ? data.city : undefined,
    });
  } catch (error: any) {
    const timedOut = error?.name === 'AbortError';
    console.error('[/geoip] Error:', error?.message || error);
    res.status(timedOut ? 504 : 502).json({
      success: false,
      error: timedOut ? 'Geolocation lookup timed out' : 'Geolocation lookup failed',
    });
  } finally {
    clearTimeout(timeout);
  }
});

// ─── Health Check ─────────────────────────────────────────

router.get('/debug-buses', async (req: Request, res: Response) => {
  const diagnostics: any = {};
  try {
    diagnostics.env = {
      TRANSMILENIO_API_URL: process.env.TRANSMILENIO_API_URL,
      TRANSMILENIO_COLOMBIA_RELAY_URL: process.env.TRANSMILENIO_COLOMBIA_RELAY_URL,
      TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY: process.env.TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY,
      RENDER: process.env.RENDER
    };

    console.log('[/debug-buses] Attempting live fetch...');
    try {
      const live = await tmApi.fetchLiveBuses('1', 'Universidades', 'troncal');
      diagnostics.live = { success: true, count: live.length };
    } catch (err: any) {
      diagnostics.live = { success: false, message: err.message, code: err.code };
    }

    res.json(diagnostics);
  } catch (err: any) {
    res.status(500).json({ error: err.message, diagnostics });
  }
});

router.get('/health', async (_req: Request, res: Response) => {
  const body: Record<string, any> = {
    status: 'ok',
    cacheEntries: cache.size,
    liveCacheEntries: liveBusCache.size,
    catalogStations: Object.keys(tmApi.getCatalog().stations || {}).length,
    catalogStale: tmApi.isCatalogStale(),
    liveTrackingVersion: tmApi.LIVE_TRACKING_VERSION,
    syncInProgress: tmApi.isSyncInProgress(),
    uptime: process.uptime(),
  };

  // Surface the proxy pool only when the fallback is enabled (importing it boots
  // the background scraper, so we don't load it otherwise).
  if (process.env.TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY === '1') {
    try {
      const { ProxyManager } = await import('../services/proxy_manager.js');
      body.proxyPool = ProxyManager.getStats();
    } catch {
      /* pool stats are best-effort */
    }
  }

  res.json(body);
});

export default router;
