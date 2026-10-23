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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCatalog,
  getCatalogLoadedAt,
  fetchLiveBuses,
  type CatalogRouteDetail,
} from './tm_api.js';
import { isTrustedLiveAnswer, variantLiveNames } from './live_request.js';
import { isZonalService } from './route_type.js';
import { ON_ROUTE_MAX_PERP_M, PASSED_STOP_EPSILON_M, projectOntoPaths, traceToPaths } from '../../../shared/eta_geometry.js';
import {
  dayTypeFor,
  LIVE_TRONCAL_M_PER_MIN,
  LIVE_ZONAL_M_PER_MIN,
  prepareCalibration,
  rideSpeedMpm,
} from '../../../shared/calibration.js';
import type { PreparedCalibration } from '../../../shared/calibration.js';
import { isFestivo } from '../../../shared/festivos.js';
import { bogotaClock } from '../../../shared/bogota_clock.js';

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
//
// For a ZONAL route these are now only the fallback: where TRANSMILENIO has
// measured the stretches this route rides, the board uses that speed scaled by
// the hour and day type (spec §5.6.5), read through `shared/calibration.js` —
// the same module the website's planner and voice ETA read, so a board and a
// plan cannot disagree about the same bus.
// Held with that reading, so the board, the voice ETA and the planner's live
// wait (§5.6.6) cannot drift apart.
const TRONCAL_SPEED_M_PER_MIN = LIVE_TRONCAL_M_PER_MIN;
const ZONAL_SPEED_M_PER_MIN = LIVE_ZONAL_M_PER_MIN;
// The on-route tolerance, the passed-stop epsilon and the projection are
// `shared/eta_geometry.js`, the same module the app's voice ETA reads.
// Bound the live fan-out: a busy trunk station is served by many routes, but we
// must not fire an unbounded number of live requests per popup (spec §3.4).
// Sized to the busiest stop, not below it: the cut takes routes in catalog
// order, so at 24 it silently dropped 22 of Portal Sur's 46 route-directions
// (28 stops were over, every portal and Ricaurte among them) and the board said
// "Sin buses en aproximación" with their buses on the way. Repeat asks for one
// route share a call (`fetchLiveBuses`), and the board is cached for 30 s.
const MAX_FANOUT_ROUTES = 48;
// Fan the serving routes out in ONE wave (concurrency ≥ MAX_FANOUT) so the total
// time is ~one live call, not a stack of sequential waves. Serializing into
// small waves was the real cause of the multi-second stalls that surfaced as
// "Llegadas no disponibles" — one slow route in an early wave delayed the rest.
// The live host tolerates this burst (direct/relay), and the hard per-route cut
// below bounds any single laggard.
const FANOUT_CONCURRENCY = MAX_FANOUT_ROUTES;
// Per-route ceiling: a single slow route must not hold up the wave. On timeout
// that route is simply omitted from this response (it reappears once its live
// call is fast again / from cache). Below the 9 s direct live timeout so a
// stalled call is cut early rather than dragging the whole popup.
const ROUTE_BUDGET_MS = 8_500;
// Hard ceiling on the whole fan-out. MUST stay under the client's 15 s fetch
// timeout so the endpoint always answers (with whatever ETAs are ready — a
// PARTIAL result, never a transport error). Remaining routes resolve on the
// next open (the result cache below) rather than failing the popup.
const OVERALL_BUDGET_MS = 12_000;
// Cache computed arrivals so re-opening a popup (or a second client) is instant
// instead of re-running the whole ~9 s live fan-out. ETAs drift only slightly
// over this window (they're shown in whole minutes), so a modestly long TTL is
// the right trade for responsiveness.
const RESULT_CACHE_TTL_MS = 30_000;
// A TTL is only consulted on read, so entries for stops nobody opens again are
// never freed — one per stop code ever queried (~7500 possible) on a 512 MB
// instance (spec §5.1.3). Bound it, evicting the oldest computation.
const RESULT_CACHE_MAX = 200;

function parseCoordenada(coordenada: string | undefined): [number, number] | null {
  if (!coordenada || typeof coordenada !== 'string' || !coordenada.includes(',')) return null;
  const [latText, lngText] = coordenada.split(',');
  const lat = Number(latText);
  const lng = Number(lngText);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
}

// ─── Live buses ───────────────────────────────────────────

interface ServingVariant {
  routeCode: string;
  destino: string;
  color: string;
  type: 'troncal' | 'zonal';
  candidates: string[];
  paths: number[][][];
  stopAlong: number;
  /** This variant's stops in order — the stretches whose measured speed it rides. */
  stopCodes: string[];
}

// The calibration ships with the server data (spec §5.6.5) and is read once.
// Absent or malformed, the board simply keeps the constants above.
const CALIBRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'planner_calibration.json');
let calibrationCache: PreparedCalibration | null | undefined;

function calibration(): PreparedCalibration | null {
  if (calibrationCache !== undefined) return calibrationCache;
  try {
    calibrationCache = prepareCalibration(JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8')));
  } catch (error) {
    console.warn('[arrivals] calibration unavailable, using cruising constants:', error);
    calibrationCache = null;
  }
  return calibrationCache;
}

/** The day type and hour the calibration is read at, Bogotá time. */
function bogotaSlot(): { dayType: ReturnType<typeof dayTypeFor>; hour: number } {
  const { year, month, day, weekday, minute } = bogotaClock();
  return { dayType: dayTypeFor(weekday, isFestivo(year, month, day)), hour: Math.floor(minute / 60) };
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
        type: isZonalService(variant.sistema, variant.tipoServicio) ? 'zonal' : 'troncal',
        candidates: variantLiveNames(variant),
        paths,
        stopAlong: proj.along,
        stopCodes: (variant.stops || []).map((s) => String(s.codigo || '').trim()).filter(Boolean),
      });
    }
  }

  return Array.from(byKey.values());
}

/** Project a route's live buses onto its trace → nearest approaching-bus ETA,
 *  or null if none is inbound to this stop. Pure: no I/O. */
function etaFromBuses(sv: ServingVariant, buses: any[]): StopArrival | null {
  if (!Array.isArray(buses) || buses.length === 0) return null;

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

  const slot = bogotaSlot();
  const speed = sv.type === 'troncal'
    ? TRONCAL_SPEED_M_PER_MIN
    : rideSpeedMpm(calibration(), sv.stopCodes, slot.dayType, slot.hour, ZONAL_SPEED_M_PER_MIN);
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
 * Per-route live fetch + ETA.
 *
 * Uses `fetchLiveBuses` (its direct→CO-relay→proxy cascade, with internal name-
 * candidate expansion) — the proven path that reliably returns buses. Attempts
 * to skip the cascade and hit the relay directly (to shave the doomed direct
 * tier) were tried and measured WORSE on prod: the relay's generic `/forward`
 * shape returned near-empty for `/buses`, and the live host's per-IP concurrency
 * throttling — not the direct tier — is the real cold-latency floor. So the
 * cascade stays. ONE name candidate input is enough (fetchLiveBuses expands it
 * internally), and the trace projection handles direction, so we don't pass the
 * full candidate set (each extra one is another live request → relay swamp).
 *
 * `answered` says whether the route's null arrival is a fact ("no bus on its
 * way") or a gap ("could not ask"): the board may only say the first when at
 * least one route answered (`isTrustedLiveAnswer`).
 */
interface RouteEta {
  arrival: StopArrival | null;
  answered: boolean;
}
const NOT_ANSWERED: RouteEta = { arrival: null, answered: false };

async function computeRouteEta(sv: ServingVariant): Promise<RouteEta> {
  try {
    const res = await fetchLiveBuses(sv.routeCode, sv.candidates[0] || sv.destino, sv.type, []);
    return { arrival: etaFromBuses(sv, res.buses), answered: isTrustedLiveAnswer(res) };
  } catch {
    return NOT_ANSWERED; // live upstream down for this route
  }
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
  fn: (item: ServingVariant) => Promise<RouteEta>,
  out: RouteEta[]
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

/** Resolve `p`, or "not answered" if it takes longer than `ms` (the work keeps
 *  running in the background but no longer blocks the fan-out). */
function withTimeout(p: Promise<RouteEta>, ms: number): Promise<RouteEta> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(NOT_ANSWERED), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(NOT_ANSWERED); });
  });
}

// ─── Result cache ─────────────────────────────────────────

const resultCache = new Map<string, { at: number; catalogAt: number; result: StopArrivalsResult }>();

function cacheResult(key: string, catalogAt: number, result: StopArrivalsResult): void {
  // Re-inserting an existing key keeps its ORIGINAL position in a Map, so delete
  // first — otherwise a refreshed entry would still be evicted as "oldest".
  resultCache.delete(key);
  resultCache.set(key, { at: Date.now(), catalogAt, result });
  if (resultCache.size <= RESULT_CACHE_MAX) return;
  const oldest = resultCache.keys().next().value;
  if (oldest !== undefined) resultCache.delete(oldest);
}

/**
 * Real-time arrivals for a stop (paradero or estación), computed from live bus
 * positions projected onto each serving route's official trace.
 *
 * Never stalls past the client's fetch budget: the fan-out is
 * concurrency-bounded and capped by a hard overall deadline. When the deadline
 * hits, whatever ETAs are ready are returned (a PARTIAL result) rather than
 * failing the popup — the rest resolve on the next open via the result cache.
 * Rejects only when routes serve the stop and not one of them answered.
 */
export function computeStopArrivals(stopCode: string): Promise<StopArrivalsResult> {
  const code = String(stopCode || '').trim();
  if (!code) return Promise.resolve({ arrivals: [], routesServing: 0 });

  const cacheKey = code.toUpperCase();
  const catalogAt = getCatalogLoadedAt();
  const cached = resultCache.get(cacheKey);
  if (cached && cached.catalogAt === catalogAt && Date.now() - cached.at < RESULT_CACHE_TTL_MS) {
    return Promise.resolve(cached.result);
  }

  // The result is only cached once the whole fan-out has finished, so two riders
  // opening the same popup a second apart used to run it twice. They share it.
  let pending = fanOutsInFlight.get(cacheKey);
  if (!pending) {
    pending = fanOut(code, cacheKey, catalogAt).finally(() => fanOutsInFlight.delete(cacheKey));
    fanOutsInFlight.set(cacheKey, pending);
  }
  return pending;
}

const fanOutsInFlight = new Map<string, Promise<StopArrivalsResult>>();

async function fanOut(code: string, cacheKey: string, catalogAt: number): Promise<StopArrivalsResult> {
  const serving = findServingVariants(code);
  const fanned = serving.slice(0, MAX_FANOUT_ROUTES);
  // The cut is silent on the board, so it is not silent here.
  if (serving.length > fanned.length) {
    console.warn(`[arrivals] ${code}: ${serving.length} serving routes, only ${fanned.length} asked — raise MAX_FANOUT_ROUTES`);
  }
  if (fanned.length === 0) {
    const empty: StopArrivalsResult = { arrivals: [], routesServing: 0 };
    cacheResult(cacheKey, catalogAt, empty);
    return empty;
  }

  // Per-route fan-out: single wave (concurrency ≥ MAX_FANOUT) so total time is
  // ~one live call, not stacked waves; each route capped by ROUTE_BUDGET and the
  // whole thing by a hard overall deadline. A partial result on deadline is fine
  // (the rest resolve on the next open); it just isn't cached.
  const out: RouteEta[] = new Array(fanned.length).fill(NOT_ANSWERED);
  let complete = false;
  const pool = runPool(
    fanned,
    FANOUT_CONCURRENCY,
    (sv) => withTimeout(computeRouteEta(sv), ROUTE_BUDGET_MS),
    out
  ).then(() => { complete = true; });
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, OVERALL_BUDGET_MS));
  await Promise.race([pool, deadline]);

  // No route answered: an empty board would assert "no buses" about buses
  // nobody could see — the free proxies are down far more often than every
  // route at a stop is empty. Thrown, so nothing is cached and the next open asks.
  if (!out.some((eta) => eta.answered)) {
    throw new Error(`${code}: none of ${fanned.length} serving routes answered`);
  }

  const arrivals = out
    .map((eta) => eta.arrival)
    .filter((a): a is StopArrival => a !== null)
    .sort((a, b) => a.etaMinutes - b.etaMinutes || a.distanceMeters - b.distanceMeters);

  const result: StopArrivalsResult = { arrivals, routesServing: serving.length };
  // Only cache a COMPLETE result — a partial (deadline-cut) one must not be
  // pinned, or a slow first open would suppress the rest for the whole TTL.
  if (complete) {
    cacheResult(cacheKey, catalogAt, result);
  }
  return result;
}
