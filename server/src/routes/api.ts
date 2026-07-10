import { Router, Request, Response } from 'express';
import { queries } from '../services/arcgis.js';
import * as tmApi from '../services/tm_api.js';
import { CardBalanceError, fetchCardBalance, maskCardNumber } from '../services/card_balance.js';
import { geocodeAddress } from '../services/geocode.js';
import zlib from 'zlib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const router = Router();

/**
 * Simple in-memory cache with TTL.
 * Route/station data rarely changes — cache for 10 minutes.
 */
const cache = new Map<string, { data: any; timestamp: number }>();
const inFlightCache = new Map<string, Promise<any>>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Last-known live-bus positions per route. When every upstream path (direct,
 * relay, CO proxies) is momentarily down, we serve the most recent real fix
 * tagged `stale` instead of a blank map (spec §4.2 graceful degradation).
 */
const liveBusCache = new Map<string, { buses: any[]; at: number }>();
const LIVE_BUS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const LIVE_ROUTE_CODE_MAX_LENGTH = 32;
const LIVE_DESTINATION_MAX_LENGTH = 160;
const LIVE_NAME_CANDIDATE_LIMIT = 12;

function normalizeRequestText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeLiveNameCandidates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const item of value) {
    const name = normalizeRequestText(item, LIVE_DESTINATION_MAX_LENGTH);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    candidates.push(name);
    if (candidates.length >= LIVE_NAME_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

async function getCachedOrFetch(key: string, fetcher: () => Promise<any>): Promise<any> {
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
    .then((data) => {
      cache.set(key, { data, timestamp: Date.now() });
      return data;
    })
    .catch((error) => {
      if (cached) {
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

// ─── Troncal Endpoints ────────────────────────────────────

router.get('/troncal/routes', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-routes', queries.troncalRoutes);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal routes' });
  }
});

router.get('/troncal/stations', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-stations', queries.troncalStations);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal stations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal stations' });
  }
});

router.get('/troncal/corridors', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('troncal-corridors', queries.troncalCorridors);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching troncal corridors:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch troncal corridors' });
  }
});

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

    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // Stream the precomputed gzip body verbatim — no per-request stringify or
    // re-compression (spec §1.1 R2; the old path was the main OOM source under
    // concurrency). Every real browser accepts gzip; the identity fallback is
    // only for the odd client that opts out via `Accept-Encoding`.
    if (req.acceptsEncodings('gzip')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzip);
    } else {
      res.end(zlib.gunzipSync(gzip));
    }
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
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal routes' });
  }
});

router.get('/zonal/stops', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('zonal-stops', queries.zonalStops);
    res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 minutes cache for large stops payload
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal stops:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal stops' });
  }
});

router.get('/zonal/stop-routes', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('zonal-stop-routes', queries.zonalStopRoutes);
    res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 minutes cache for stop-route mappings
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching zonal stop routes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch zonal stop routes' });
  }
});

// ─── Recharge Points (tullave POIs) ───────────────────────
// Static POI catalog committed from a Colombian egress (spec §5.8, see
// `sync_recarga.ts`). Served read-only with no runtime geofence dependency.

let rechargePointsCache: any[] | null = null;
async function loadRechargePoints(): Promise<any[]> {
  if (rechargePointsCache) return rechargePointsCache;
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'recarga_points.json');
  rechargePointsCache = JSON.parse(await readFile(file, 'utf8'));
  return rechargePointsCache!;
}

router.get('/recarga-points', async (_req: Request, res: Response) => {
  try {
    const points = await loadRechargePoints();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ success: true, count: points.length, points });
  } catch (error) {
    console.error('Error loading recharge points:', error);
    res.status(500).json({ success: false, error: 'Failed to load recharge points' });
  }
});

// ─── Station Demand (Salidas ridership) ───────────────────
// Mean weekday entry/exit counts per troncal station, aggregated offline from
// the open "Salidas" dataset and committed (spec §5.8, see `sync_demand.ts`).
// Served read-only — no bulk download/parse on the hot path.

let stationDemandCache: any | null = null;
async function loadStationDemand(): Promise<any> {
  if (stationDemandCache) return stationDemandCache;
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'station_demand.json');
  stationDemandCache = JSON.parse(await readFile(file, 'utf8'));
  return stationDemandCache!;
}

router.get('/station-demand', async (_req: Request, res: Response) => {
  try {
    const demand = await loadStationDemand();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ success: true, ...demand });
  } catch (error) {
    console.error('Error loading station demand:', error);
    res.status(500).json({ success: false, error: 'Failed to load station demand' });
  }
});

// ─── TransMiBici (bike-parking POIs) ──────────────────────
// Secure bike-parking facilities at stations, with capacity/occupancy (spec
// §5.3, see `sync_transmibici.ts`). Static committed catalog.

let transmibiciCache: any[] | null = null;
async function loadTransmibici(): Promise<any[]> {
  if (transmibiciCache) return transmibiciCache;
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'transmibici.json');
  transmibiciCache = JSON.parse(await readFile(file, 'utf8'));
  return transmibiciCache!;
}

router.get('/transmibici', async (_req: Request, res: Response) => {
  try {
    const points = await loadTransmibici();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ success: true, count: points.length, points });
  } catch (error) {
    console.error('Error loading transmibici:', error);
    res.status(500).json({ success: false, error: 'Failed to load transmibici' });
  }
});

// ─── Cable Endpoints ──────────────────────────────────────

router.get('/cable/stations', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('cable-stations', queries.cableStations);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching cable stations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch cable stations' });
  }
});

router.get('/cable/trazado', async (_req: Request, res: Response) => {
  try {
    const features = await getCachedOrFetch('cable-traces', queries.cableTraces);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({ success: true, count: features.length, features });
  } catch (error) {
    console.error('Error fetching cable traces:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch cable traces' });
  }
});

router.post('/buses', async (req: Request, res: Response) => {
  const ruta = normalizeRequestText(req.body?.ruta, LIVE_ROUTE_CODE_MAX_LENGTH);
  const nombre = normalizeRequestText(req.body?.Nombre ?? req.body?.nombre, LIVE_DESTINATION_MAX_LENGTH);
  const nombreCandidates = normalizeLiveNameCandidates(req.body?.nombreCandidates);
  const routeType: 'troncal' | 'zonal' = req.body?.type === 'zonal' ? 'zonal' : 'troncal';

  if (!ruta) {
    res.status(400).json({ success: false, error: 'ruta is required' });
    return;
  }

  const cacheKey = `${routeType}:${ruta}`;
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
      liveBusCache.set(cacheKey, { buses, at: Date.now() });
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
router.post('/arrivals', async (req: Request, res: Response) => {
  const paradero = normalizeRequestText(
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

// ─── Approximate Geolocation (IP fallback) ────────────────
// Used when the browser's native geolocation is unavailable (e.g. the OS/
// network location provider is blocked, returning POSITION_UNAVAILABLE).
// Resolves the *client's* IP to an approximate coordinate. Nothing is stored
// (spec §3.3 — zero PII storage); the client only calls /api/* (spec §2.3).

router.post('/card/read', async (req: Request, res: Response) => {
  const rawCardNumber = req.body?.numero_tarjeta ?? req.body?.numeroTarjeta ?? req.body?.cardNumber;
  const consultar = req.body?.consultar ?? 'false';
  const masked = rawCardNumber ? maskCardNumber(String(rawCardNumber)) : '(missing)';

  try {
    console.log(`[/card/read] Request: numero_tarjeta="${masked}" consultar="${consultar}"`);
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

const GEOIP_TIMEOUT_MS = 5_000;
const WALKING_ROUTE_TIMEOUT_MS = 9_000;
// Pedestrian speed used to derive walking time from the routed path distance.
// We recompute time from distance rather than trusting upstream `duration` so
// the value matches the client router's WALK_SPEED_M_PER_MINUTE exactly —
// totals stay consistent before and after walking-geometry enrichment.
const WALK_SPEED_M_PER_MINUTE = 75;
const PRIVATE_IP_RE = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i;
const BOGOTA_WALKING_BOUNDS = {
  west: -74.25,
  south: 4.4,
  east: -73.95,
  north: 4.85,
};

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
  return lng >= BOGOTA_WALKING_BOUNDS.west &&
    lng <= BOGOTA_WALKING_BOUNDS.east &&
    lat >= BOGOTA_WALKING_BOUNDS.south &&
    lat <= BOGOTA_WALKING_BOUNDS.north;
}

function getClientIp(req: Request): string | null {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ips = (Array.isArray(xForwardedFor) ? xForwardedFor : String(xForwardedFor).split(','))
      .map((ip) => ip.trim())
      .filter(Boolean);
    for (const ip of ips) {
      if (!PRIVATE_IP_RE.test(ip)) return ip;
    }
  }

  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp && typeof xRealIp === 'string') {
    const ip = xRealIp.trim();
    if (!PRIVATE_IP_RE.test(ip)) return ip;
  }

  const ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '').trim();
  if (!ip || PRIVATE_IP_RE.test(ip)) return null;
  return ip;
}

router.get('/geoip', async (req: Request, res: Response) => {
  const ip = getClientIp(req);
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

router.get('/geocode', async (req: Request, res: Response) => {
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

router.get('/walking-route', async (req: Request, res: Response) => {
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WALKING_ROUTE_TIMEOUT_MS);
  // FOSSGIS routing service — a real OSRM `foot` profile (the public
  // router.project-osrm.org demo only ships the car profile, so its `/foot/`
  // routes follow one-way streets and miss pedestrian shortcuts). This instance
  // routes true pedestrian geometry, so the path returned is the fastest walk.
  const url =
    `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from[0]},${from[1]};${to[0]},${to[1]}` +
    '?overview=full&geometries=geojson';

  try {
    const upstream = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TransMilenioExplorer/1.0',
      },
      signal: controller.signal,
    });

    if (!upstream.ok) throw new Error(`OSRM HTTP ${upstream.status}`);

    const data = await upstream.json() as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: number[][] };
      }>;
    };
    const route = data.routes?.[0];
    const coordinates = route?.geometry?.coordinates;
    if (
      data.code !== 'Ok' ||
      !route ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !Number.isFinite(route.distance)
    ) {
      res.status(502).json({ success: false, error: 'Walking route upstream returned no usable route' });
      return;
    }
    const distance = Number(route.distance);
    const normalizedCoordinates = coordinates.map(([lng, lat]) => [Number(lng), Number(lat)] as LngLat);
    if (normalizedCoordinates.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat))) {
      res.status(502).json({ success: false, error: 'Walking route upstream returned invalid coordinates' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: {
        coordinates: normalizedCoordinates,
        distance,
        // Derive from distance, not OSRM's duration (driving-speed on the demo
        // server — see WALK_SPEED_M_PER_MINUTE note above).
        time: distance / WALK_SPEED_M_PER_MINUTE,
        source: 'osrm',
      },
    });
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

router.get('/debug-buses', async (req: Request, res: Response) => {
  const diagnostics: any = {};
  try {
    diagnostics.success = true;
    diagnostics.config = {
      relayConfigured: Boolean(process.env.TRANSMILENIO_COLOMBIA_RELAY_URL),
      publicProxyEnabled: process.env.TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY === '1',
      renderRuntime: Boolean(process.env.RENDER)
    };

    console.log('[/debug-buses] Attempting live fetch...');
    try {
      const live = await tmApi.fetchLiveBuses('1', 'Universidades', 'troncal');
      diagnostics.live = { success: true, count: live.buses.length, source: live.source };
    } catch (err: any) {
      diagnostics.live = { success: false, error: 'Live fetch failed', code: err.code };
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(diagnostics);
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Debug buses failed', diagnostics });
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
    memory: (() => {
      const m = process.memoryUsage();
      const mb = (n: number) => Math.round(n / 1048576);
      return { rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal), externalMB: mb(m.external) };
    })(),
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
