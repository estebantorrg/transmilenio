/**
 * The other half of the voice question (spec §5.9): *this place — what serves it?*
 *
 * `routeEta.ts` answers "the F19, where is it relative to me". Standing at a
 * paradero, though, the daily question is the inverse — "¿qué buses pasan por
 * aquí?" — and it used to have no answer at all: the rider had to already know a
 * código before the feature could say anything. That made a tool for one habitual
 * route rather than one for getting around.
 *
 * It answers off `voice_stops.json` (stop → routes) plus the route index's
 * horarios, so it is **fully offline and needs no live call**: which routes serve
 * the stop, and which of them are actually running at this hour. The live ETA is
 * then one tap away on whichever route the rider cares about — breadth offline,
 * depth on demand, instead of a 12-way fan-out nobody can wait for.
 *
 * Pure: position, clock and the two indexes are all inputs.
 */

import { haversineMeters, walkMinutes } from '../utils/geo';
import { variantBase } from '../data/zones';
import { checkRouteService, type RouteServiceState } from './routeEta';
import { nameTokens } from './voiceSpanish';
import type { PlanTime } from './schedule';
import type { VoiceIndex, VoiceStopIndex, VoiceStopRecord } from '../types/voice';

/**
 * How far away a stop can be and still be answered as "aquí".
 *
 * Wider than it sounds deliberately: a coarse or stale fix (the norm indoors, and
 * what §5.9 accepts up to 30 minutes old) routinely lands a block or two off, and
 * refusing to name the paradero the rider is plainly standing at because the phone
 * says 400 m is the feature failing on its own terms. Past this the stop is still
 * named — with its distance, so the rider can judge it.
 */
export const HERE_RADIUS_M = 500;

/** Nothing beyond this is offered as "your stop" at all. Matches the ETA engine's
 *  access radius, so the two features agree on what is reachable on foot. */
export const STOP_SEARCH_RADIUS_M = 1500;

/** Most routes a single sentence can name before it stops being an answer. */
const HIGHLIGHT_MAX = 4;

export interface StopRoutes {
  code: string;
  name: string;
  coord: [number, number];
  /** Metres from the rider, or `null` when the stop was named rather than found. */
  meters: number | null;
  /** Walking minutes, `null` for the same reason. */
  walkMinutes: number | null;
  /** Every route the catalog files at this stop, códigos as bundled. */
  routes: string[];
  /**
   * Of those, the ones operating at `now`, **troncal first**.
   *
   * A trunk station files a couple of dozen routes and the códigos sort
   * alphabetically, so the first four used to be whichever alimentadores happened
   * to start with a digit — at Banderas, "la 5, la 8-1, la 8-2 y la 8-3". Troncal
   * services are the reason a rider is standing at a trunk station; ordering by
   * ASCII was a rendering of the data, not an answer.
   */
  running: string[];
  /**
   * Up to {@link HIGHLIGHT_MAX} running routes worth *saying*: troncal first and
   * one per variant family, so a spoken list is four different services rather
   * than four spellings of one. Real códigos, never a collapsed stand-in — the
   * rider has to be able to match what they hear to what is written on the bus
   * (spec §1).
   */
  highlights: string[];
  /** Filed at this stop but not running at this hour. */
  closed: string[];
  /** True when the rider is close enough that the stop is "aquí". */
  here: boolean;
  /**
   * The rider named this stop rather than it being found by proximity.
   *
   * It changes the sentence, not the data: "tu parada más cercana es Banderas" is
   * wrong for someone who *asked about* Banderas from across town, and being told
   * the nearest thing to a question you did not ask reads as the app not listening.
   */
  named: boolean;
}

function toStop(record: VoiceStopRecord): { code: string; name: string; coord: [number, number]; routes: string[] } {
  return {
    code: String(record[0] ?? ''),
    name: String(record[1] ?? ''),
    coord: [Number(record[2]), Number(record[3])],
    routes: String(record[4] ?? '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean),
  };
}

/** The nearest stop to `pos` within `STOP_SEARCH_RADIUS_M`, or null. */
export function nearestStopRecord(index: VoiceStopIndex, pos: [number, number]): VoiceStopRecord | null {
  let best: { record: VoiceStopRecord; meters: number } | null = null;
  for (const record of index?.stops ?? []) {
    const lng = Number(record[2]);
    const lat = Number(record[3]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const meters = haversineMeters(pos, [lng, lat]);
    if (best === null || meters < best.meters) best = { record, meters };
  }
  return best && best.meters <= STOP_SEARCH_RADIUS_M ? best.record : null;
}

/**
 * Tokenised stop names, derived once per index.
 *
 * 7415 names re-tokenised per lookup cost ~13 ms, and a stop question does up to
 * two lookups; memoised on the (immutable) index it is ~1 ms. Same reasoning, and
 * same `WeakMap` shape, as the route matcher's haystacks.
 */
const stopTokens = new WeakMap<VoiceStopIndex, string[][]>();

function tokenizedNames(index: VoiceStopIndex): string[][] {
  const cached = stopTokens.get(index);
  if (cached) return cached;
  const built = (index?.stops ?? []).map((record) => nameTokens(String(record[1] ?? '')));
  stopTokens.set(index, built);
  return built;
}

/**
 * The stop the rider named, or null.
 *
 * Strict, like the route engine's anchor: every word of the hint must appear in
 * the stop's name. Ties break toward an **estación** first, then the shortest
 * name, then the most routes.
 *
 * The estación step is not a preference, it is what the rider said: names in this
 * network are given to the station and inherited by the SITP paraderos around it
 * ("Islandia" the estación, "Br. Islandia" the stop across the road, which files
 * more routes and therefore used to win). Someone standing at a station who names
 * it and is answered with the street stop's routes has been told about a
 * different place — and on the two newest stations, whose paradero twins predate
 * them by years, that was every time.
 */
export function findStopByName(index: VoiceStopIndex, hint: string): VoiceStopRecord | null {
  const needle = nameTokens(hint);
  if (needle.length === 0) return null;
  const names = tokenizedNames(index);
  let best: { record: VoiceStopRecord; station: boolean; length: number; routes: number } | null = null;
  const records = index?.stops ?? [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const haystack = names[i];
    if (!haystack || haystack.length === 0) continue;
    if (!needle.every((token) => haystack.includes(token))) continue;
    const routes = String(record[4] ?? '').split(',').length;
    const station = record[5] === 1;
    const better =
      best === null ||
      (station !== best.station ? station : haystack.length !== best.length ? haystack.length < best.length : routes > best.routes);
    if (better) best = { record, station, length: haystack.length, routes };
  }
  return best?.record ?? null;
}

/**
 * Split a stop's routes into "running now" and "not at this hour", off the route
 * index's own horarios.
 *
 * A stop with 28 routes filed and 3 running at 11 p.m. must not be reported as 28
 * options (§1, certainty) — that is how a rider ends up waiting for a bus that
 * stopped four hours ago. Routes the index does not know are dropped rather than
 * guessed at: the two files are built in the same pass, so that is a bug, not a
 * state to paper over.
 */
export function describeStopRoutes(
  record: VoiceStopRecord,
  routeIndex: VoiceIndex,
  now: PlanTime,
  userPos: [number, number] | null,
  named = false
): StopRoutes {
  const stop = toStop(record);
  const running: string[] = [];
  const closed: string[] = [];

  // Troncal before zonal, catalog order within each — see `running` above.
  const ranked = [...stop.routes].sort((a, b) => {
    const rank = (code: string): number => (routeIndex?.routes?.[code]?.tipo === 'z' ? 1 : 0);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  for (const code of ranked) {
    const route = routeIndex?.routes?.[code];
    if (!route) continue;
    const service: RouteServiceState = checkRouteService(route, now);
    if (service.verdict === 'abierto' || service.verdict === 'sin-horario') running.push(code);
    else closed.push(code);
  }

  // One per variant family: "F405" and "F405-2" are the same service to someone
  // standing at the kerb, and spending two of four spoken slots on them wastes the
  // answer.
  const highlights: string[] = [];
  const families = new Set<string>();
  for (const code of running) {
    const family = variantBase(code) || code;
    if (families.has(family)) continue;
    families.add(family);
    highlights.push(code);
    if (highlights.length >= HIGHLIGHT_MAX) break;
  }

  const meters = userPos ? haversineMeters(userPos, stop.coord) : null;
  return {
    ...stop,
    routes: [...running, ...closed],
    running,
    highlights,
    closed,
    meters: meters === null ? null : Math.round(meters),
    walkMinutes: meters === null ? null : walkMinutes(meters),
    here: meters !== null && meters <= HERE_RADIUS_M,
    named,
  };
}
