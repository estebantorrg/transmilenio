import { Router, Request, Response, RequestHandler } from 'express';
import { queries } from '../services/arcgis.js';
import * as tmApi from '../services/tm_api.js';
import { CardBalanceError, fetchCardBalance } from '../services/card_balance.js';
import { maskCardNumber } from '../../../shared/card_ledger.js';
import { computeStopArrivals } from '../services/stop_arrivals.js';
import { geocodeAddress } from '../services/geocode.js';
import { getNovedades } from '../services/novedades.js';
import { isWithinBogota } from '../services/bogota.js';
import { FOOT_HEADERS, FOOT_MIN_INTERVAL_MS, createPacer, footRouteUrl, readFootRoute, type FootRoute } from '../../../shared/osrm_foot.js';
import zlib from 'zlib';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { anyPublicProxyAllowed } from '../services/public_proxy_policy.js';
import { clientKey, createRateLimiter } from '../services/flow_control.js';
import {
  LIVE_DESTINATION_MAX_LENGTH,
  LIVE_NAME_CANDIDATE_LIMIT,
  LIVE_ROUTE_CODE_MAX_LENGTH,
  normalizeLiveText,
} from '../services/live_payload.js';
import { keepKnownLiveNames } from '../services/live_request.js';

const router = Router();
const gzipAsync = promisify(zlib.gzip);

/**
 * Simple in-memory cache with TTL.
 * Route/station data rarely changes — cache for 10 minutes.
 *
 * What is kept is the response itself, serialized and gzipped once, not the
 * features. Every page load asks for these layers — the paraderos alone are
 * 4 MB of JSON — and stringifying and compressing them again per request cost
 * 1–3 s of a 0.1-CPU instance each time, measured on the cached path (spec
 * §5.1.3). The master catalog is served the same way (`getCatalogLightGzip`).
 */
interface LayerBody {
  gzip: Buffer;
  count: number;
}
const cache = new Map<string, { data: LayerBody; timestamp: number }>();
const inFlightCache = new Map<string, Promise<LayerBody>>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
// While upstream is down we keep serving the last good payload. Re-attempting on
// every single request would put the full ArcGIS retry budget in front of each
// one; instead the stale entry buys this much quiet before the next attempt.
const STALE_REFRESH_COOLDOWN = 30 * 1000;
const UPSTREAM_RETRY_AFTER_S = 5;

/**
 * Last-known live-bus positions per route. When every upstream path (direct,
 * relay, CO proxies) is momentarily down, we serve the most recent real fix
 * tagged `stale` instead of a blank map (spec §4.2 graceful degradation).
 */
const liveBusCache = new Map<string, { buses: any[]; at: number }>();
const LIVE_BUS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
// The TTL alone never frees anything: it is only consulted on read, so an entry
// for a route nobody opens again stays resident forever. The catalog has ~1000
// route variants and each entry holds a full bus array — real memory on a 512 MB
// instance (spec §5.1.3). Bound it and evict the oldest fix when full.
const LIVE_BUS_CACHE_MAX = 120;

function rememberLiveBuses(key: string, buses: any[]): void {
  liveBusCache.set(key, { buses, at: Date.now() });
  if (liveBusCache.size <= LIVE_BUS_CACHE_MAX) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [k, entry] of liveBusCache) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) liveBusCache.delete(oldestKey);
}

function normalizeLiveNameCandidates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const item of value) {
    const name = normalizeLiveText(item, LIVE_DESTINATION_MAX_LENGTH);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    candidates.push(name);
    if (candidates.length >= LIVE_NAME_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

// ─── Per-client budgets (spec §3.4) ───────────────────────
// Each of these endpoints turns one request into calls to someone else's host,
// so each has a budget per client per minute. They are sized for a network full
// of riders behind one address (carrier NAT, a campus), not for one person: a
// script is what they stop. `req.ip` is the real client — see `trust proxy` in
// index.ts.
const RATE_WINDOW_MS = 60_000;
const RATE_BUDGETS = {
  buses: 90,
  arrivals: 60,
  'stop-arrivals': 60,
  card: 10,
  geoip: 60,
  geocode: 120,
  'walking-route': 240,
} as const;
const rateLimiter = createRateLimiter(RATE_WINDOW_MS);

function rateLimit(name: keyof typeof RATE_BUDGETS): RequestHandler {
  return (req, res, next) => {
    if (rateLimiter.allow(`${name}|${clientKey(req.ip ?? '')}`, RATE_BUDGETS[name])) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(rateLimiter.retryAfterSeconds()));
    res.status(429).json({ success: false, error: 'Too many requests' });
  };
}

async function getCachedOrFetch(key: string, fetcher: () => Promise<any[]>): Promise<LayerBody> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[Cache] HIT: ${key}`);
    return cached.data;
  }

  const pending = inFlightCache.get(key);
  if (pending) {
    console.log(`[Cache] WAIT: ${key}`);
    return pending;
  }

  console.log(`[Cache] MISS: ${key} — fetching from ArcGIS...`);
  const request = fetcher()
    .then(async (features) => {
      const body = JSON.stringify({ success: true, count: features.length, features });
      const data = { gzip: await gzipAsync(body), count: features.length };
      cache.set(key, { data, timestamp: Date.now() });
      return data;
    })
    .catch((error) => {
      if (cached) {
        // Keep the last good payload alive and pace the next attempt.
        cached.timestamp = Date.now() - CACHE_TTL + STALE_REFRESH_COOLDOWN;
        console.warn(`[Cache] STALE: ${key} after ArcGIS failure`, error);
        return cached.data;
      }
      throw error;
    })
    .finally(() => {
      inFlightCache.delete(key);
    });

  inFlightCache.set(key, request);
  return request;
}

// ─── ArcGIS-backed feature endpoints ──────────────────────
// One handler for every layer endpoint: identical shape, only the cache key,
// upstream query and max-age differ (spec §1.1 R2 — no duplicated logic).
//
// An upstream failure answers **503 + Retry-After**, not 500: the layer is
// momentarily unreachable, not broken. The distinction is load-bearing — a 500
// is terminal to the client's backoff ladder (spec §3.4), which is exactly how a
// single flaky ArcGIS response used to leave a default-on layer (troncal
// trazado, station pins) empty for the whole session.

/** Sends a precomputed gzip JSON body verbatim — no per-request stringify or
 *  re-compression. Every real browser accepts gzip; the identity fallback is
 *  only for the odd client that opts out via `Accept-Encoding`. */
function sendGzipJson(req: Request, res: Response, gzip: Buffer): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.acceptsEncodings('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(gzip);
  } else {
    res.end(zlib.gunzipSync(gzip));
  }
}

function featureEndpoint(
  key: string,
  fetcher: () => Promise<any[]>,
  label: string,
  maxAgeSeconds: number
): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const { gzip } = await getCachedOrFetch(key, fetcher);
      res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
      sendGzipJson(req, res, gzip);
    } catch (error) {
      console.error(`Error fetching ${label}:`, error);
      res.setHeader('Retry-After', String(UPSTREAM_RETRY_AFTER_S));
      res.status(503).json({ success: false, error: `${label} temporarily unavailable upstream` });
    }
  };
}

/**
 * Warms the caches of the layers the map turns on by default, so the first
 * visitor after a cold start (Render spins the instance down) is served from
 * memory instead of racing five concurrent ArcGIS queries on a shared CPU —
 * the burst that made a random default-on layer time out and vanish.
 *
 * Best-effort and non-blocking: a failure just leaves the cache cold, and the
 * request path (retries + stale reuse) still covers it. Deliberately limited to
 * the two small payloads (~190 KB combined) — the heavy ones stay lazy so boot
 * memory is untouched (spec §5.1.3).
 */
export function prewarmArcgisLayers(): void {
  const warm: Array<[string, () => Promise<any[]>]> = [
    ['troncal-stations', queries.troncalStations],
    ['troncal-corridors', queries.troncalCorridors],
  ];
  for (const [key, fetcher] of warm) {
    getCachedOrFetch(key, fetcher)
      .then(({ count }) => console.log(`[Prewarm] ${key}: ${count} features cached`))
      .catch((error) => console.warn(`[Prewarm] ${key} failed (will load on demand):`, error?.message || error));
  }
}

// ─── Troncal Endpoints ────────────────────────────────────

router.get('/troncal/routes', featureEndpoint('troncal-routes', queries.troncalRoutes, 'troncal routes', 600));
router.get('/troncal/stations', featureEndpoint('troncal-stations', queries.troncalStations, 'troncal stations', 600));
router.get('/troncal/corridors', featureEndpoint('troncal-corridors', queries.troncalCorridors, 'troncal corridors', 600));

// ─── Master Catalog (from TransMi App API) ────────────────

router.get('/troncal/master-catalog', async (req: Request, res: Response) => {
  try {
    const { gzip, count, etag } = await tmApi.getCatalogLightGzip();

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 minutes cache
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('X-Catalog-Count', String(count));

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    // The precomputed gzip body, verbatim (spec §1.1 R2; the old per-request
    // stringify was the main OOM source under concurrency).
    sendGzipJson(req, res, gzip);
  } catch (error) {
    console.error('Error fetching master catalog:', error);
    res.status(500).json({ success: false, error: 'Failed to load master catalog' });
  }
});

router.get('/troncal/route/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const catalog = tmApi.getCatalog();
    // Own keys only: `constructor` is a property of every object, and it is not a route.
    const routeVariants = Object.hasOwn(catalog.routes, code) ? catalog.routes[code] : undefined;
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

// ─── Zonal Endpoints ──────────────────────────────────────

router.get('/zonal/routes', featureEndpoint('zonal-routes', queries.zonalRoutes, 'zonal routes', 600));
// 30-minute cache for the two large zonal payloads (stops + stop-route mappings).
router.get('/zonal/stops', featureEndpoint('zonal-stops', queries.zonalStops, 'zonal stops', 1800));
router.get('/zonal/stop-routes', featureEndpoint('zonal-stop-routes', queries.zonalStopRoutes, 'zonal stop routes', 1800));

// ─── Committed POI / demand datasets ──────────────────────
// Four static catalogues aggregated offline and committed, because none of them
// can be served from a US host at request time: the two tullave POI sets —
// recharge + personalization — are on the CO-geofenced live host
// (`sync_tullave_points.ts`, spec §5.8), and per-station weekday demand
// (`sync_demand.ts`, spec §5.8) and TransMiBici bike parking
// (`sync_transmibici.ts`, spec §5.3) have no single official endpoint at all.
// They are read from disk once and served read-only — no bulk download or parse
// on the hot path, and no runtime geofence dependency.
//
// ONE loader for all three: the read + memo + concurrent-first-hit sharing is
// identical, only the filename differs (spec §1.1 R2).

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const dataFileCache = new Map<string, unknown>();
const dataFileInFlight = new Map<string, Promise<unknown>>();

function loadDataFile<T>(filename: string): Promise<T> {
  const cached = dataFileCache.get(filename);
  if (cached !== undefined) return Promise.resolve(cached as T);

  const pending = dataFileInFlight.get(filename);
  if (pending) return pending as Promise<T>;

  const request = readFile(join(DATA_DIR, filename), 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text);
      dataFileCache.set(filename, parsed);
      return parsed;
    })
    .finally(() => {
      dataFileInFlight.delete(filename);
    });

  dataFileInFlight.set(filename, request);
  return request as Promise<T>;
}

/** Serves one committed dataset. `shape` turns the parsed file into the response
 *  body, which is the only thing that differs between the three endpoints. */
function dataFileEndpoint<T>(filename: string, label: string, shape: (data: T) => object): RequestHandler {
  return async (_req: Request, res: Response) => {
    try {
      const data = await loadDataFile<T>(filename);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.json({ success: true, ...shape(data) });
    } catch (error) {
      console.error(`Error loading ${label}:`, error);
      res.status(500).json({ success: false, error: `Failed to load ${label}` });
    }
  };
}

router.get('/recarga-points', dataFileEndpoint<any[]>(
  'recarga_points.json', 'recharge points', (points) => ({ count: points.length, points })
));
router.get('/personalizacion-points', dataFileEndpoint<any[]>(
  'personalizacion_points.json', 'personalization points', (points) => ({ count: points.length, points })
));
router.get('/station-demand', dataFileEndpoint<object>(
  'station_demand.json', 'station demand', (demand) => demand
));
router.get('/transmibici', dataFileEndpoint<any[]>(
  'transmibici.json', 'transmibici', (points) => ({ count: points.length, points })
));
// Measured speeds and scheduled headways the journey planner is calibrated
// against (spec §5.6.5). Served whole: the client holds it for the session, and
// the mobile app ships the same file as an offline asset.
router.get('/planner-calibration', dataFileEndpoint<object>(
  'planner_calibration.json', 'planner calibration', (calibration) => calibration
));
// The printed ruteros of the zonal routes (código, destino, corredor/hito rows),
// read off TRANSMILENIO's final artwork by scripts/ocr/ruteros.mjs. ~90 KB,
// fetched once by the route page.
router.get('/ruteros-tradicionales', dataFileEndpoint<object>(
  'ruteros_tradicionales.json', 'ruteros tradicionales', (ruteros) => ruteros
));
// First and last scheduled departure of each urban zonal route from its own
// cabecera, per day type — TRANSMILENIO's schedule, built by
// scripts/calibration/cabeceras.mjs. ~40 KB, fetched once by the route page.
router.get('/horarios-cabecera', dataFileEndpoint<object>(
  'horarios_cabecera.json', 'horarios por cabecera', (horarios) => horarios
));

// ─── Cable Endpoints ──────────────────────────────────────

router.get('/cable/stations', featureEndpoint('cable-stations', queries.cableStations, 'cable stations', 600));
router.get('/cable/trazado', featureEndpoint('cable-traces', queries.cableTraces, 'cable traces', 600));

router.post('/buses', rateLimit('buses'), async (req: Request, res: Response) => {
  const ruta = normalizeLiveText(req.body?.ruta, LIVE_ROUTE_CODE_MAX_LENGTH);
  const routeType: 'troncal' | 'zonal' = req.body?.type === 'zonal' ? 'zonal' : 'troncal';

  if (!ruta) {
    res.status(400).json({ success: false, error: 'ruta is required' });
    return;
  }
  // The route is free text the server would forward as written, so only a
  // código the catalog files is asked upstream (spec §3.4).
  if (!tmApi.isCatalogRouteCode(ruta)) {
    res.status(404).json({ success: false, error: `Route ${ruta} not found in catalog` });
    return;
  }

  // …and only under a name the catalog files it by: the names are free text
  // too, and they decide who shares an answer (`keepKnownLiveNames`). A zonal
  // request carries no name at all. With no catalog loaded there is nothing to
  // check against, and the names go as sent.
  const sent = [
    ...normalizeLiveNameCandidates(req.body?.nombreCandidates),
    normalizeLiveText(req.body?.Nombre ?? req.body?.nombre, LIVE_DESTINATION_MAX_LENGTH),
  ].filter(Boolean);
  const variants = tmApi.catalogRouteVariants(ruta);
  const nombreCandidates = routeType === 'zonal' ? [] : variants.length ? keepKnownLiveNames(sent, variants) : sent;
  const nombre = nombreCandidates[0] ?? '';

  // Last-known positions are kept per direction. One código runs both ways on
  // 68 troncal services (1–8, the feeders), and a key without the destination
  // handed one direction's buses to a rider watching the other — which the
  // client's heading filter, finding no match, then drew in full.
  const cacheKey = `${routeType}:${ruta}:${nombre}`.toLowerCase();
  const freshCache = (): { buses: any[]; at: number } | null => {
    const cached = liveBusCache.get(cacheKey);
    return cached && Date.now() - cached.at < LIVE_BUS_CACHE_TTL ? cached : null;
  };

  // The live endpoint NEVER hard-fails (spec §4: "a request never fails again").
  // It always answers HTTP 200 with a `status` discriminator so the client can
  // tell a verified absence of buses apart from a silent/unreachable upstream:
  //   live       — buses present (any transport).
  //   no-buses    — verified empty from a CO egress (direct/co-relay): trustworthy.
  //   unverified  — empty from a free public CO proxy: low confidence, NOT "no buses".
  //   stale       — upstream silent/down; serving the last real fix (with asOf).
  //   unreachable — no transport reached upstream and no cache to fall back on.
  try {
    console.log(`[/buses] Request: ruta="${ruta}" nombre="${nombre}" type=${routeType}`);
    const { buses, source } = await tmApi.fetchLiveBuses(ruta, nombre, routeType, nombreCandidates);
    console.log(`[/buses] Response: ${buses.length} buses for ruta="${ruta}" via=${source}`);

    if (buses.length > 0) {
      rememberLiveBuses(cacheKey, buses);
      res.json({ success: true, status: 'live', confidence: 'high', count: buses.length, data: buses, source });
      return;
    }

    // Verified empty from a Colombian egress IP is a genuine "no buses now".
    if (source === 'direct' || source === 'co-relay') {
      res.json({ success: true, status: 'no-buses', confidence: 'high', count: 0, data: [], source });
      return;
    }

    // Empty from a free public proxy is unreliable. If we have a recent real fix,
    // show it as stale rather than asserting an absence we can't confirm.
    const cached = freshCache();
    if (cached) {
      res.json({ success: true, status: 'stale', confidence: 'low', count: cached.buses.length, data: cached.buses, source: 'cache', asOf: cached.at });
      return;
    }
    res.json({ success: true, status: 'unverified', confidence: 'low', count: 0, data: [], source });
  } catch (error: any) {
    console.error('[/buses] Error fetching live buses:', error?.message || error);

    // Graceful degradation: serve the last known positions if still fresh.
    const cached = freshCache();
    if (cached) {
      const ageS = Math.round((Date.now() - cached.at) / 1000);
      console.log(`[/buses] Serving last-known ${cached.buses.length} buses for "${cacheKey}" (stale ${ageS}s)`);
      res.json({ success: true, status: 'stale', confidence: 'low', count: cached.buses.length, data: cached.buses, source: 'cache', asOf: cached.at });
      return;
    }
    res.json({ success: true, status: 'unreachable', confidence: 'low', count: 0, data: [], source: null });
  }
});

// ─── Arrivals (llegadas at a paradero) ────────────────────
// Real-time bus arrivals/ETAs at a stop (spec §5.8). Rides the same CO live
// transport as /buses; like it, never hard-fails — empty list on any outage.
router.post('/arrivals', rateLimit('arrivals'), async (req: Request, res: Response) => {
  const paradero = normalizeLiveText(
    req.body?.paradero ?? req.body?.cenefa ?? req.body?.codigo,
    LIVE_ROUTE_CODE_MAX_LENGTH
  );
  if (!paradero) {
    res.status(400).json({ success: false, error: 'paradero is required' });
    return;
  }
  try {
    const { arrivals, source } = await tmApi.fetchArrivals(paradero);
    res.json({ success: true, count: arrivals.length, arrivals, source });
  } catch (error: any) {
    console.error('[/arrivals] Error:', error?.message || error);
    res.json({ success: true, count: 0, arrivals: [], source: null });
  }
});

// ─── Stop arrivals (global ETA per serving route) ─────────
// For a paradero OR estación: which routes reporting a stop here (matched BY
// CODE) have a live bus approaching, and in how long. Computed from live bus
// positions projected onto each route's official trace (spec §5.8, §5.6).
// Never hard-fails — empty list on any outage.
router.post('/stop-arrivals', rateLimit('stop-arrivals'), async (req: Request, res: Response) => {
  const code = normalizeLiveText(
    req.body?.code ?? req.body?.codigo ?? req.body?.cenefa ?? req.body?.paradero,
    LIVE_ROUTE_CODE_MAX_LENGTH
  );
  if (!code) {
    res.status(400).json({ success: false, error: 'code is required' });
    return;
  }
  try {
    const { arrivals, routesServing } = await computeStopArrivals(code);
    res.json({ success: true, count: arrivals.length, routesServing, arrivals });
  } catch (error: any) {
    console.error('[/stop-arrivals] Error:', error?.message || error);
    res.json({ success: true, count: 0, routesServing: 0, arrivals: [] });
  }
});

// ─── Lectura de saldo (tullave card ledger) ───────────────
// Reproduces the official app's `POST /lectura_tarjeta` (spec §5.5.1a). The card
// number is never logged in full and never cached.

router.post('/card/read', rateLimit('card'), async (req: Request, res: Response) => {
  const rawCardNumber = req.body?.numero_tarjeta ?? req.body?.numeroTarjeta ?? req.body?.cardNumber;
  const consultar = req.body?.consultar ?? 'false';
  // Digits only, and nothing else of the body: this line is written before
  // anything has been validated, so whatever else was sent stays out of the log.
  const masked = maskCardNumber(String(rawCardNumber ?? '').replace(/\D/g, '')) || '(missing)';

  try {
    console.log(`[/card/read] Request: numero_tarjeta="${masked}"`);
    const data = await fetchCardBalance(rawCardNumber, consultar);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data });
  } catch (error: any) {
    const status = error instanceof CardBalanceError ? error.statusCode : 500;
    console.error(`[/card/read] Error for "${masked}":`, error?.message || error);
    res.status(status).json({
      success: false,
      error: status === 400
        ? error.message
        : status === 504
          ? 'Card balance lookup timed out'
          : 'Failed to read card balance',
    });
  }
});

// ─── Approximate Geolocation (IP fallback) ────────────────
// Used when the browser's native geolocation is unavailable (e.g. the OS/
// network location provider is blocked, returning POSITION_UNAVAILABLE).
// Resolves the *client's* IP to an approximate coordinate. Nothing is stored
// (spec §3.3 — zero PII storage); the client only calls /api/* (spec §2.3).

const GEOIP_TIMEOUT_MS = 5_000;
// Queue wait + upstream must stay inside the client's 10 s budget for one leg,
// past which it keeps the estimate anyway.
const WALKING_ROUTE_TIMEOUT_MS = 6_000;
const WALKING_QUEUE_MAX_MS = 3_000;
// Every rider on the website reaches FOSSGIS from this one address, so the one
// request a second it allows is shared by all of them (`shared/osrm_foot.js`),
// and a leg one rider already walked is answered from here for the next.
const footPacer = createPacer(FOOT_MIN_INTERVAL_MS, WALKING_QUEUE_MAX_MS);
const WALKING_CACHE_MAX = 2_000; // ~1 KB each
const walkingCache = new Map<string, FootRoute>();
const PRIVATE_IP_RE = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i;

type LngLat = [number, number];

function parseLngLatQuery(value: unknown): LngLat | null {
  if (typeof value !== 'string') return null;
  const [lngText, latText] = value.split(',');
  const lng = Number(lngText);
  const lat = Number(latText);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function isWithinWalkingBounds([lng, lat]: LngLat): boolean {
  return isWithinBogota(lng, lat);
}

// Read from memory only — the poller (`services/novedades.ts`) is what talks to
// X, on its own clock, so no request here reaches anyone else's host.
router.get('/novedades', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ success: true, ...getNovedades() });
});

router.get('/geoip', rateLimit('geoip'), async (req: Request, res: Response) => {
  // `req.ip` and nothing else: it is the real client (`trust proxy`, index.ts).
  // This used to read the forwarding headers itself, leftmost entry first — the
  // one the caller types — which made the endpoint a lookup of any address for
  // anyone, with no budget. A private address is this box's own network (local
  // dev), so geojs is asked about the server's address instead.
  const address = (req.ip || '').replace(/^::ffff:/, '').trim();
  const ip = address && !PRIVATE_IP_RE.test(address) ? address : null;
  console.log(`[/geoip] Request received; clientIpPresent=${Boolean(ip)}`);
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

router.get('/geocode', rateLimit('geocode'), async (req: Request, res: Response) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
    return;
  }
  if (query.length > 120) {
    res.status(400).json({ success: false, error: 'Query parameter "q" is too long' });
    return;
  }

  try {
    const candidates = await geocodeAddress(query);
    res.json({ success: true, count: candidates.length, candidates });
  } catch (error: any) {
    console.error(`[/geocode] Error for queryLength=${query.length}:`, error?.message || error);
    res.status(500).json({ success: false, error: 'Failed to geocode address' });
  }
});

// ─── Walking Route Geometry ───────────────────────────────

router.get('/walking-route', rateLimit('walking-route'), async (req: Request, res: Response) => {
  const from = parseLngLatQuery(req.query.from);
  const to = parseLngLatQuery(req.query.to);

  if (!from || !to) {
    res.status(400).json({ success: false, error: 'Query parameters "from" and "to" must be lng,lat pairs' });
    return;
  }

  if (!isWithinWalkingBounds(from) || !isWithinWalkingBounds(to)) {
    res.status(422).json({ success: false, error: 'Walking route coordinates must be within Bogota bounds' });
    return;
  }

  const key = `${from[0].toFixed(5)},${from[1].toFixed(5)}|${to[0].toFixed(5)},${to[1].toFixed(5)}`;
  const send = (route: FootRoute): void => {
    // A walk between two fixed points never changes, so the answer is worth
    // caching for anyone between here and the rider.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ success: true, data: route });
  };
  const known = walkingCache.get(key);
  if (known) {
    send(known);
    return;
  }

  const wait = footPacer();
  if (wait === null) {
    // Busier than FOSSGIS's one-a-second allows: the client keeps its estimate
    // for this leg and asks again on the next search.
    res.setHeader('Retry-After', '2');
    res.status(503).json({ success: false, error: 'Walking route queue is full' });
    return;
  }
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WALKING_ROUTE_TIMEOUT_MS);
  try {
    // FOSSGIS's real OSRM `foot` profile — the router.project-osrm.org demo only
    // ships the car profile, whose `/foot/` routes follow one-way streets.
    const upstream = await fetch(footRouteUrl(from, to), { headers: FOOT_HEADERS, signal: controller.signal });
    if (!upstream.ok) throw new Error(`OSRM HTTP ${upstream.status}`);
    const route = readFootRoute(await upstream.json());
    if (!route) {
      res.status(502).json({ success: false, error: 'Walking route upstream returned no usable route' });
      return;
    }
    walkingCache.set(key, route);
    if (walkingCache.size > WALKING_CACHE_MAX) walkingCache.delete(walkingCache.keys().next().value!);
    send(route);
  } catch (error: any) {
    const timedOut = error?.name === 'AbortError';
    console.error('[/walking-route] Error:', error?.message || error);
    res.status(timedOut ? 504 : 502).json({
      success: false,
      error: timedOut ? 'Walking route lookup timed out' : 'Walking route lookup failed',
    });
  } finally {
    clearTimeout(timeout);
  }
});

// ─── Health Check ─────────────────────────────────────────

router.get('/health', async (_req: Request, res: Response) => {
  const body: Record<string, any> = {
    status: 'ok',
    cacheEntries: cache.size,
    liveCacheEntries: liveBusCache.size,
    rateLimitKeys: rateLimiter.size(),
    catalogStations: Object.keys(tmApi.getCatalog().stations || {}).length,
    catalogStale: tmApi.isCatalogStale(),
    liveTrackingVersion: tmApi.LIVE_TRACKING_VERSION,
    syncInProgress: tmApi.isSyncInProgress(),
    uptime: process.uptime(),
    memory: (() => {
      const m = process.memoryUsage();
      const mb = (n: number) => Math.round(n / 1048576);
      return { rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal), externalMB: mb(m.external) };
    })(),
  };

  // Surface the proxy pool only when the fallback is enabled (importing it boots
  // the background scraper, so we don't load it otherwise).
  if (anyPublicProxyAllowed()) {
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
