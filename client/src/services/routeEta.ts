/**
 * On-device route-proximity engine (spec §5.9) — "¿qué tan cerca está el F19?".
 *
 * Answers the inverse of `server/src/services/stop_arrivals.ts`. That module asks
 * *"at this stop, which routes are coming?"* and fans out over up to 24 routes on
 * the server. This one asks *"this route — where is it relative to me?"*: one
 * route, one live call, and it runs **in the app**, because the APK talks to no
 * web server of ours (spec §5.2.1b). Everything it needs ships in the APK: the
 * voice index and one ~5 KB geometry shard.
 *
 * ETA is the same absolute time-distance calculation as the server's, and the
 * tunables below are deliberately identical — the same bus must not be "4 min
 * away" in the app and "6 min away" on the website (spec §1.1 R2). The projection
 * is duplicated rather than shared because the two live in different packages;
 * any change to the constants or the projection belongs in BOTH files.
 *
 * Pure: no fetching, no clock reads. Buses, position and the Bogotá wall clock
 * are all inputs, so the whole thing is exercisable from Node with a fixed
 * scenario.
 */

import { haversineMeters, walkMinutes } from '../utils/geo';
import { toFiniteNumber } from '../utils/liveBus';
import {
  closingAfter,
  createServiceClock,
  dayOffsetSuffix,
  formatClockMinute,
  isOpenAt,
  MINUTES_PER_DAY,
  mergeServiceSpans,
  nextOpeningAt,
  parseServiceSpans,
  serviceIntervals,
  serviceMinutesOnPlanDay,
  type PlanTime,
  type ServiceSpan,
} from './schedule';
import type { VoiceIndexRoute, VoiceRouteGeo, VoiceStop } from '../types/voice';

// ─── Tunables ─────────────────────────────────────────────
// Cruising speeds, on-route tolerance and the passed-stop epsilon are the SAME
// numbers as server/src/services/stop_arrivals.ts. Change them together.
const TRONCAL_SPEED_M_PER_MIN = 400; // ~24 km/h
const ZONAL_SPEED_M_PER_MIN = 233; // ~14 km/h
const ON_ROUTE_MAX_PERP_M = 160;
const PASSED_STOP_EPSILON_M = 40;

// Voice-specific, no server counterpart:
// How far the rider is willing to be from a stop of this route before the honest
// answer is "you're not near the F19" rather than an ETA they cannot use. Matches
// the router's access radius (ACCESS_SEARCH_RADIUS_M, services/router.ts).
const ACCESS_MAX_M = 1500;
// A bus this much sooner than the walk is gone before the rider arrives. One
// minute of slack absorbs the ETA's own rounding rather than promising a bus
// that is already pulling away.
const CATCH_MARGIN_MINUTES = 1;
// Arriving within this much of the bus is "sal ya", not "you have time".
const SAL_YA_SLACK_MINUTES = 2;

const DEG2RAD = Math.PI / 180;
const EARTH_R = 6_371_000;

// ─── Result shapes ────────────────────────────────────────

export type ServiceVerdict = 'abierto' | 'fuera-de-servicio' | 'cerrado-hoy' | 'sin-horario';

export interface RouteServiceState {
  verdict: ServiceVerdict;
  /** Chip line for the screen: "Último servicio 10:00 p.m." / "Abre 4:30 a.m. (mañana)". */
  detail: string;
  /**
   * The opening (when closed) or last-service (when open) minute, in plan-day
   * minutes — so ≥ `MINUTES_PER_DAY` means tomorrow. The raw number is carried
   * because {@link detail} is written for the eye: its " (mañana)" parenthetical
   * is not something a rider should hear read out (services/voiceAnswer.ts).
   */
  boundaryMinute: number | null;
  /**
   * Whether this route runs at any point on the plan day. It is the difference
   * between "el F19 no presta servicio hoy" (a Sunday, for a route filed L-S)
   * and "el F19 ya terminó su servicio de hoy" (11 p.m. on a Wednesday) — both
   * are `cerrado-hoy`, and telling a rider the wrong one sends them to wait for
   * a bus that was never coming.
   */
  runsToday: boolean;
}

export type EtaVerdict =
  /** The bus lands about when the rider would — leave now. */
  | 'sal-ya'
  /** The rider gets there with time to spare. */
  | 'alcanzas'
  /** It passes before the rider can walk there. */
  | 'no-alcanzas'
  /** Route is running but no bus is inbound to this stop on this direction. */
  | 'sin-buses';

export interface RouteEtaDirection {
  dir: string;
  origin: string;
  destination: string;
  stopCode: string;
  stopName: string;
  walkMeters: number;
  walkMinutes: number;
  /** `null` when no live bus is inbound — never 0 as a stand-in. */
  etaMinutes: number | null;
  /** Along-track metres from the nearest inbound bus to the stop. */
  distanceMeters: number | null;
  busCount: number;
  verdict: EtaVerdict;
}

export type RouteEtaVerdict =
  | 'ok'
  /** Every reachable direction is running but empty of inbound buses. */
  | 'sin-buses'
  /** No stop of this route within `ACCESS_MAX_M`. */
  | 'lejos'
  /** Route is in the index but shipped no usable trace. */
  | 'sin-geometria'
  | 'fuera-de-servicio'
  | 'cerrado-hoy';

export interface RouteEtaAnswer {
  code: string;
  nombre: string;
  type: 'troncal' | 'zonal';
  color: string;
  verdict: RouteEtaVerdict;
  service: RouteServiceState;
  /** Most actionable first. Empty unless the verdict is `ok` or `sin-buses`. */
  directions: RouteEtaDirection[];
  /** This route's nearest stop, whatever the verdict — what makes "lejos"
   *  answerable as "su parada más cercana, Banderas, está a 3,2 km" rather than
   *  a shrug. Null only when the route ships no geometry at all. */
  nearest: { code: string; name: string; meters: number } | null;
}

// ─── Geometry (mirrors stop_arrivals.ts) ──────────────────

function isCoordPair(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]));
}

/** Normalize a LineString / MultiLineString trace to an array of [lng,lat] paths. */
export function traceToPaths(trace: number[][] | number[][][] | undefined): number[][][] {
  if (!Array.isArray(trace) || trace.length === 0) return [];
  const first = trace[0];
  if (isCoordPair(first)) return [trace as number[][]];
  if (Array.isArray(first) && isCoordPair(first[0])) {
    return (trace as number[][][]).filter((path) => Array.isArray(path) && path.length > 1);
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
 * city scale). Inter-path gaps are NOT counted toward along-track distance.
 *
 * Bus and stop are projected onto the SAME simplified trace, so the shard's
 * Ramer–Douglas–Peucker corner-cutting largely cancels in their difference.
 */
export function projectOntoPaths(paths: number[][][], pLng: number, pLat: number): Projection | null {
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

// ─── Schedule (no geometry, no network) ───────────────────

function routeSpans(route: VoiceIndexRoute): ServiceSpan[] | undefined {
  const dirs = Object.values(route.dirs || {});
  if (dirs.length === 0) return undefined;
  // `mergeServiceSpans` returns undefined as soon as one side is unknown, which
  // is the §5.6.2 rule: an unreadable schedule means "always operating" and must
  // never let a parse gap hide a running service.
  return dirs
    .map((dir) => parseServiceSpans(dir.horarios))
    .reduce((acc: ServiceSpan[] | undefined, spans, i) => (i === 0 ? spans : mergeServiceSpans(acc, spans)));
}

/**
 * Is this route running at all right now — answerable from the index alone, with
 * no geometry shard and no live call.
 *
 * The voice flow calls this FIRST and short-circuits on a closed route: "el F19
 * no presta servicio los domingos" is both the correct answer and ~1.5 s faster
 * than one that waits on the live host to confirm there are no buses.
 */
export function checkRouteService(route: VoiceIndexRoute, now: PlanTime): RouteServiceState {
  const spans = routeSpans(route);
  if (!spans || spans.length === 0) {
    return { verdict: 'sin-horario', detail: '', boundaryMinute: null, runsToday: true };
  }

  const clock = createServiceClock(now);
  const intervals = serviceIntervals(spans, clock);
  const minute = clock.departMinute;
  const runsToday = serviceMinutesOnPlanDay(intervals) > 0;

  if (isOpenAt(intervals, minute)) {
    const closes = closingAfter(intervals, minute);
    return {
      verdict: 'abierto',
      detail: closes === null ? '' : `Último servicio ${formatClockMinute(closes)}${dayOffsetSuffix(closes)}`,
      boundaryMinute: closes,
      runsToday,
    };
  }

  const opens = nextOpeningAt(intervals, minute);
  if (opens === null) {
    return { verdict: 'cerrado-hoy', detail: 'No opera hoy', boundaryMinute: null, runsToday };
  }
  // Intervals run over plan days −1/0/+1, so an opening at or past midnight is
  // tomorrow's — that is a different sentence ("no opera hoy") from "abre más
  // tarde", and the rider needs to hear which one it is.
  const verdict: ServiceVerdict = opens >= MINUTES_PER_DAY ? 'cerrado-hoy' : 'fuera-de-servicio';
  return {
    verdict,
    detail: `Abre ${formatClockMinute(opens)}${dayOffsetSuffix(opens)}`,
    boundaryMinute: opens,
    runsToday,
  };
}

// ─── ETA ──────────────────────────────────────────────────

function nearestStop(stops: VoiceStop[], userPos: [number, number]): { stop: VoiceStop; meters: number } | null {
  let best: { stop: VoiceStop; meters: number } | null = null;
  for (const stop of stops) {
    const meters = haversineMeters(userPos, [stop[2], stop[3]]);
    if (best === null || meters < best.meters) best = { stop, meters };
  }
  return best;
}

/** Nearest inbound bus to `stopAlong`, or null when none is on-route and before it. */
function inboundBuses(
  paths: number[][][],
  stopAlong: number,
  buses: unknown[]
): { remainingMeters: number; count: number } | null {
  let bestRemaining = Infinity;
  let approaching = 0;

  for (const bus of buses) {
    if (!bus || typeof bus !== 'object') continue;
    const raw = bus as Record<string, unknown>;
    const lat = toFiniteNumber(raw.latitude ?? raw.lat);
    const lng = toFiniteNumber(raw.longitude ?? raw.lng ?? raw.lon);
    if (lat === null || lng === null) continue;

    const proj = projectOntoPaths(paths, lng, lat);
    if (!proj || proj.perp > ON_ROUTE_MAX_PERP_M) continue;

    const remaining = stopAlong - proj.along;
    if (remaining < -PASSED_STOP_EPSILON_M) continue; // already passed the stop
    approaching++;
    const clamped = Math.max(0, remaining);
    if (clamped < bestRemaining) bestRemaining = clamped;
  }

  if (approaching === 0 || !Number.isFinite(bestRemaining)) return null;
  return { remainingMeters: bestRemaining, count: approaching };
}

function etaVerdict(etaMinutes: number | null, walk: number): EtaVerdict {
  if (etaMinutes === null) return 'sin-buses';
  if (etaMinutes + CATCH_MARGIN_MINUTES < walk) return 'no-alcanzas';
  if (etaMinutes <= walk + SAL_YA_SLACK_MINUTES) return 'sal-ya';
  return 'alcanzas';
}

/** Most actionable first: a bus you can catch, soonest; then the one you can't;
 *  then directions with nothing running. */
const VERDICT_RANK: Record<EtaVerdict, number> = { 'sal-ya': 0, alcanzas: 0, 'no-alcanzas': 1, 'sin-buses': 2 };

function compareDirections(a: RouteEtaDirection, b: RouteEtaDirection): number {
  const rank = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
  if (rank !== 0) return rank;
  if (a.etaMinutes !== null && b.etaMinutes !== null && a.etaMinutes !== b.etaMinutes) {
    return a.etaMinutes - b.etaMinutes;
  }
  return a.walkMeters - b.walkMeters;
}

export interface RouteEtaInput {
  code: string;
  /** The route's `voice_index.json` entry. */
  index: VoiceIndexRoute;
  /** Its `voice/<CODE>.json` shard, or null when the route ships no trace. */
  geo: VoiceRouteGeo | null;
  /** Live vehicles for this route (any tier's payload shape). */
  buses: unknown[];
  /** Rider position as `[lng, lat]`. */
  userPos: [number, number];
  /** Bogotá wall clock — pass `bogotaNow()`; never read here, so this is testable. */
  now: PlanTime;
  maxAccessMeters?: number;
}

/**
 * "How close is the F19?" — for every direction the rider can reach, the nearest
 * stop, the walk to it, and the nearest inbound bus's ETA.
 *
 * Both directions are returned rather than guessed between. A route filed with
 * two sentidos is genuinely ambiguous from a bare route code, and answering the
 * wrong one is worse than answering both (the composer says "hacia Banderas en
 * 4, hacia Portal Suba en 9" — one extra clause, no follow-up question).
 *
 * Never throws: every failure mode is a verdict the rider can act on.
 */
export function computeRouteEta(input: RouteEtaInput): RouteEtaAnswer {
  const { code, index, geo, buses, userPos, now } = input;
  const maxAccess = input.maxAccessMeters ?? ACCESS_MAX_M;
  const type: 'troncal' | 'zonal' = index.tipo === 'z' ? 'zonal' : 'troncal';
  const speed = type === 'troncal' ? TRONCAL_SPEED_M_PER_MIN : ZONAL_SPEED_M_PER_MIN;
  const service = checkRouteService(index, now);

  const base = {
    code,
    nombre: index.nombre || code,
    type,
    color: index.color || '',
    service,
  };

  const geoDirs = geo?.dirs || {};
  if (Object.keys(geoDirs).length === 0) {
    return { ...base, verdict: 'sin-geometria', directions: [], nearest: null };
  }

  const directions: RouteEtaDirection[] = [];
  let nearest: RouteEtaAnswer['nearest'] = null;

  for (const [dir, dirGeo] of Object.entries(geoDirs)) {
    const stops = dirGeo.stops || [];
    if (stops.length === 0) continue;

    const near = nearestStop(stops, userPos);
    if (!near) continue;
    if (nearest === null || near.meters < nearest.meters) {
      nearest = { code: String(near.stop[0]), name: String(near.stop[1]), meters: Math.round(near.meters) };
    }
    if (near.meters > maxAccess) continue;

    const meta = index.dirs?.[dir];
    const paths = traceToPaths(dirGeo.trazado);
    const stopProj = paths.length > 0 ? projectOntoPaths(paths, near.stop[2], near.stop[3]) : null;
    // The stop's own `posicion` is deliberately not used as the along-track
    // anchor: it is the operator's chainage on the FULL trace, while buses are
    // projected onto the shipped simplified one. Mixing the two scales would
    // bias every ETA by the simplification error instead of cancelling it.
    const inbound = stopProj ? inboundBuses(paths, stopProj.along, buses) : null;

    const walk = walkMinutes(near.meters);
    const etaMinutes = inbound ? Math.round(inbound.remainingMeters / speed) : null;

    directions.push({
      dir,
      origin: meta?.origin || '',
      destination: meta?.destination || index.nombre || code,
      stopCode: String(near.stop[0]),
      stopName: String(near.stop[1]),
      walkMeters: Math.round(near.meters),
      walkMinutes: walk,
      etaMinutes,
      distanceMeters: inbound ? Math.round(inbound.remainingMeters) : null,
      busCount: inbound?.count ?? 0,
      verdict: etaVerdict(etaMinutes, walk),
    });
  }

  directions.sort(compareDirections);

  // Closed outranks everything below it, including "you are not near this
  // route". Both can be true at once, and being 2 km away does not matter when
  // nothing is running — the rider needs the hour it opens, not the walk to a
  // stop no bus will reach. It also holds when the live feed still shows a
  // vehicle: those are deadheading buses finishing a run, not a boardable
  // service. Any reachable directions ride along so the UI can still draw them.
  if (service.verdict === 'cerrado-hoy' || service.verdict === 'fuera-de-servicio') {
    return { ...base, verdict: service.verdict, directions, nearest };
  }

  if (directions.length === 0) {
    return { ...base, verdict: 'lejos', directions: [], nearest };
  }

  const anyBus = directions.some((d) => d.etaMinutes !== null);
  return { ...base, verdict: anyBus ? 'ok' : 'sin-buses', directions, nearest };
}
