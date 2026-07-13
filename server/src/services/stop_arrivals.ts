/**
 * Global stop-arrivals ETA engine (spec §5.8, §5.6).
 *
 * The official `/paradero/buses` (getLlegadas) endpoint only surfaces buses that
 * are already imminent, and only for zonal paraderos. This module instead
 * answers: for a given stop (paradero **or** troncal estación), which of the
 * routes that report a stop there — matched strictly BY CODE, never by name —
 * has a live bus approaching, and in how long.
 *
 * ETA is an absolute time-distance calculation: every live bus is projected onto
 * its route's official `trazado` polyline, the stop is projected onto the same
 * polyline, and the remaining along-track distance (stop − bus, forward only) is
 * divided by a per-system cruising speed. No reliance on upstream ETA labels.
 */

import {
  getCatalog,
  getCatalogLoadedAt,
  fetchLiveBuses,
  type CatalogRouteDetail,
} from './tm_api.js';

type RouteTrace = number[][] | number[][][];

export interface StopArrival {
  codigo: string;
  destino: string;
  color: string;
  type: 'troncal' | 'zonal';
  etaMinutes: number;
  distanceMeters: number;
  /** Buses of this route currently approaching the stop (before it, on-route). */
  busCount: number;
}

export interface StopArrivalsResult {
  arrivals: StopArrival[];
  /** Routes that report a stop here (by code), whether or not a bus is inbound. */
  routesServing: number;
}

// ─── Tunables ─────────────────────────────────────────────
// Cruising speeds used to turn remaining along-track distance into minutes.
// Deliberately conservative city averages incl. dwell (troncal runs faster on
// its exclusive lane than a zonal in mixed traffic).
const TRONCAL_SPEED_M_PER_MIN = 400; // ~24 km/h
const ZONAL_SPEED_M_PER_MIN = 233; // ~14 km/h
// A bus farther than this from the route polyline is not really on this trace
// (GPS drift / wrong-variant overlap) — don't let it fabricate an ETA.
const ON_ROUTE_MAX_PERP_M = 160;
// Ignore buses already at/after the stop (small epsilon absorbs GPS jitter).
const PASSED_STOP_EPSILON_M = 40;
// Bound the live fan-out: a busy trunk station is served by many routes, but we
// must not fire an unbounded number of live requests per popup (spec §3.4).
const MAX_FANOUT_ROUTES = 24;
// Fan the serving routes out in ONE wave (concurrency ≥ MAX_FANOUT) so the total
// time is ~one live call, not a stack of sequential waves. Serializing into
// small waves was the real cause of the multi-second stalls that surfaced as
// "Llegadas no disponibles" — one slow route in an early wave delayed the rest.
// The live host tolerates this burst (direct/relay), and the hard per-route cut
// below bounds any single laggard.
const FANOUT_CONCURRENCY = 24;
// Per-route ceiling: a single slow route must not hold up the wave. On timeout
// that route is simply omitted from this response (it reappears once its live
// call is fast again / from cache). Below the 9 s direct live timeout so a
// stalled call is cut early rather than dragging the whole popup.
const ROUTE_BUDGET_MS = 7_000;
// Hard ceiling on the whole fan-out. MUST stay under the client's 15 s fetch
// timeout so the endpoint always answers (with whatever ETAs are ready — a
// PARTIAL result, never a transport error). Remaining routes resolve on the
// next open (12 s result cache) rather than failing the popup.
const OVERALL_BUDGET_MS = 9_000;
// Cache computed arrivals briefly so re-opening a popup (or a second client)
// doesn't re-run the whole live fan-out; well under the 15 s poll window.
const RESULT_CACHE_TTL_MS = 12_000;

const DEG2RAD = Math.PI / 180;
const EARTH_R = 6_371_000;

// ─── Geometry helpers ─────────────────────────────────────

function haversine(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLat = (bLat - aLat) * DEG2RAD;
  const dLng = (bLng - aLng) * DEG2RAD;
  const la1 = aLat * DEG2RAD;
  const la2 = bLat * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isCoordPair(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]));
}

/** Normalize a LineString / MultiLineString trace to an array of [lng,lat] paths. */
function traceToPaths(trace: RouteTrace | undefined): number[][][] {
  if (!Array.isArray(trace) || trace.length === 0) return [];
  const first = trace[0];
  if (isCoordPair(first)) return [trace as number[][]];
  if (Array.isArray(first) && isCoordPair(first[0])) {
    return (trace as number[][][]).filter((p) => Array.isArray(p) && p.length > 1);
  }
  return [];
}

interface Projection {
  /** Distance from the query point to its nearest point on the polyline (m). */
  perp: number;
  /** Cumulative along-track distance of that nearest point from the origin (m). */
  along: number;
}

/**
 * Project a lng/lat point onto a multi-path polyline. Distances are computed on
 * a local equirectangular plane anchored at the query point (sub-0.3% error at
 * city scale). Inter-path gaps are NOT counted toward along-track distance, so a
 * MultiLineString's disjoint segments don't inflate the cumulative measure.
 */
function projectOntoPaths(paths: number[][][], pLng: number, pLat: number): Projection | null {
  const cosLat = Math.cos(pLat * DEG2RAD);
  const toXY = (lng: number, lat: number): [number, number] => [
    (lng - pLng) * DEG2RAD * EARTH_R * cosLat,
    (lat - pLat) * DEG2RAD * EARTH_R,
  ];

  let best: Projection | null = null;
  let base = 0; // along-track distance accumulated by fully-traversed prior paths

  for (const path of paths) {
    if (path.length < 2) continue;
    let cum = 0; // distance within this path up to segment start
    let prev = toXY(Number(path[0][0]), Number(path[0][1]));

    for (let i = 1; i < path.length; i++) {
      const curr = toXY(Number(path[i][0]), Number(path[i][1]));
      const dx = curr[0] - prev[0];
      const dy = curr[1] - prev[1];
      const segLen2 = dx * dx + dy * dy;
      const segLen = Math.sqrt(segLen2);

      // Query point is at the local origin (0,0) by construction.
      const t = segLen2 > 0 ? Math.max(0, Math.min(1, -(prev[0] * dx + prev[1] * dy) / segLen2)) : 0;
      const footX = prev[0] + t * dx;
      const footY = prev[1] + t * dy;
      const perp = Math.hypot(footX, footY);
      if (best === null || perp < best.perp) {
        best = { perp, along: base + cum + t * segLen };
      }

      cum += segLen;
      prev = curr;
    }
    base += cum;
  }

  return best;
}

function parseCoordenada(coordenada: string | undefined): [number, number] | null {
  if (!coordenada || typeof coordenada !== 'string' || !coordenada.includes(',')) return null;
  const [latText, lngText] = coordenada.split(',');
  const lat = Number(latText);
  const lng = Number(lngText);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
}

// ─── Route classification & live buses ────────────────────

function routeIsZonal(variant: CatalogRouteDetail): boolean {
  const service = `${variant.sistema || ''} ${variant.tipoServicio || ''}`.toUpperCase();
  return service.includes('ZONAL') || service.includes('TRANSMIZONAL') || service.includes('ALIMENTADOR');
}

/** Destination-first name candidates for the troncal live lookup (spec §5.2.4). */
function liveNameCandidates(variant: CatalogRouteDetail): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const t = String(v || '').trim();
    if (t && !out.some((c) => c.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  const stops = variant.stops || [];
  push(variant.destination);
  push(variant.nombre);
  push(variant.origin);
  if (stops.length) push(stops[stops.length - 1].nombre);
  if (stops.length) push(stops[0].nombre);
  return out;
}

interface ServingVariant {
  routeCode: string;
  destino: string;
  color: string;
  type: 'troncal' | 'zonal';
  candidates: string[];
  paths: number[][][];
  stopAlong: number;
}

/**
 * Every route variant that reports a stop with `stopCode` (matched BY CODE) and
 * carries a usable trace + a resolvable stop position on it. Deduped by
 * route code + destination so both directions of a ruta fácil stay distinct but
 * a route filed twice doesn't fan out twice.
 */
function findServingVariants(stopCode: string): ServingVariant[] {
  const catalog = getCatalog();
  const target = stopCode.trim().toUpperCase();
  const byKey = new Map<string, ServingVariant>();

  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    for (const variant of variants) {
      const stop = (variant.stops || []).find(
        (s) => String(s.codigo || '').trim().toUpperCase() === target
      );
      if (!stop) continue;

      const stopCoord = parseCoordenada(stop.coordenada);
      const paths = traceToPaths(variant.trazado);
      if (!stopCoord || paths.length === 0) continue;

      const proj = projectOntoPaths(paths, stopCoord[0], stopCoord[1]);
      if (!proj) continue;

      const destino = variant.destination || variant.nombre || code;
      const key = `${code.toUpperCase()}|${destino.toUpperCase()}`;
      if (byKey.has(key)) continue;

      byKey.set(key, {
        routeCode: code,
        destino,
        color: variant.color || '',
        type: routeIsZonal(variant) ? 'zonal' : 'troncal',
        candidates: liveNameCandidates(variant),
        paths,
        stopAlong: proj.along,
      });
    }
  }

  return Array.from(byKey.values());
}

/** Nearest approaching bus for one route → its ETA, or null if none inbound. */
async function computeRouteEta(sv: ServingVariant): Promise<StopArrival | null> {
  let buses: any[];
  try {
    const res = await fetchLiveBuses(sv.routeCode, sv.candidates[0] || sv.destino, sv.type, sv.candidates);
    buses = Array.isArray(res.buses) ? res.buses : [];
  } catch {
    return null; // live upstream down for this route — skip, never hard-fail
  }
  if (buses.length === 0) return null;

  let bestRemaining = Infinity;
  let approaching = 0;

  for (const bus of buses) {
    const lat = Number((bus as any).latitude ?? (bus as any).lat);
    const lng = Number((bus as any).longitude ?? (bus as any).lng ?? (bus as any).lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const proj = projectOntoPaths(sv.paths, lng, lat);
    if (!proj || proj.perp > ON_ROUTE_MAX_PERP_M) continue;

    const remaining = sv.stopAlong - proj.along;
    if (remaining < -PASSED_STOP_EPSILON_M) continue; // already passed the stop
    approaching++;
    const clamped = Math.max(0, remaining);
    if (clamped < bestRemaining) bestRemaining = clamped;
  }

  if (!Number.isFinite(bestRemaining) || approaching === 0) return null;

  const speed = sv.type === 'troncal' ? TRONCAL_SPEED_M_PER_MIN : ZONAL_SPEED_M_PER_MIN;
  const etaMinutes = Math.round(bestRemaining / speed);

  return {
    codigo: sv.routeCode,
    destino: sv.destino,
    color: sv.color,
    type: sv.type,
    etaMinutes,
    distanceMeters: Math.round(bestRemaining),
    busCount: approaching,
  };
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight, writing each
 * result into a shared array as it lands. Returns the array. Bounding the
 * in-flight count keeps the live host from throttling a big fan-out, so each
 * call stays fast and the overall deadline is rarely hit.
 */
function runPool(
  items: ServingVariant[],
  concurrency: number,
  fn: (item: ServingVariant) => Promise<StopArrival | null>,
  out: (StopArrival | null)[]
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  return Promise.all(workers).then(() => undefined);
}

/** Resolve `p`, or `null` if it takes longer than `ms` (the work keeps running
 *  in the background but no longer blocks the fan-out). */
function withTimeout(p: Promise<StopArrival | null>, ms: number): Promise<StopArrival | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

// ─── Result cache ─────────────────────────────────────────

const resultCache = new Map<string, { at: number; catalogAt: number; result: StopArrivalsResult }>();

/**
 * Real-time arrivals for a stop (paradero or estación), computed from live bus
 * positions projected onto each serving route's official trace.
 *
 * Never throws and never stalls past the client's fetch budget: the fan-out is
 * concurrency-bounded and capped by a hard overall deadline. When the deadline
 * hits, whatever ETAs are ready are returned (a PARTIAL result) rather than
 * failing the popup — the rest resolve on the next open via the result cache.
 */
export async function computeStopArrivals(stopCode: string): Promise<StopArrivalsResult> {
  const code = String(stopCode || '').trim();
  if (!code) return { arrivals: [], routesServing: 0 };

  const cacheKey = code.toUpperCase();
  const catalogAt = getCatalogLoadedAt();
  const cached = resultCache.get(cacheKey);
  if (cached && cached.catalogAt === catalogAt && Date.now() - cached.at < RESULT_CACHE_TTL_MS) {
    return cached.result;
  }

  const serving = findServingVariants(code);
  const fanned = serving.slice(0, MAX_FANOUT_ROUTES);

  // Shared results buffer, filled as each route lands. Read after the overall
  // deadline so a slow tail can't hold up the whole response.
  const out: (StopArrival | null)[] = new Array(fanned.length).fill(null);
  let poolDone = false;
  const pool = runPool(
    fanned,
    FANOUT_CONCURRENCY,
    (sv) => withTimeout(computeRouteEta(sv), ROUTE_BUDGET_MS),
    out
  ).then(() => { poolDone = true; });
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, OVERALL_BUDGET_MS));
  await Promise.race([pool, deadline]);

  const arrivals = out
    .filter((a): a is StopArrival => a !== null)
    .sort((a, b) => a.etaMinutes - b.etaMinutes || a.distanceMeters - b.distanceMeters);

  const result: StopArrivalsResult = { arrivals, routesServing: serving.length };
  // Only cache once the full fan-out settled — a partial (deadline-cut) result
  // must not be pinned for 12 s, or a slow first open would suppress the rest.
  if (poolDone) {
    resultCache.set(cacheKey, { at: Date.now(), catalogAt, result });
  }
  return result;
}
