/**
 * In-journey guidance — the plan does not end when the rider boards (§5.6, §5.9).
 *
 * The planner renders an itinerary and then goes quiet, so a rider standing on a
 * bus has to surface and re-read a map to answer "was that my stop?". This module
 * turns a rendered plan into a **running** one: given where the rider is, it says
 * what — if anything — should be announced right now.
 *
 * Two rules shape the whole design:
 *
 *  1. **Silence is the default.** A 40-minute trip should produce roughly six
 *     utterances. `advanceGuide` returns `cue: null` on the overwhelming majority
 *     of fixes, and every cue is emitted at most once (`GuideState.emitted`).
 *  2. **Pure and synchronous.** No GPS, no clock, no network, no DOM — position
 *     comes in as a `RiderFix` and everything else is derived. That keeps it
 *     testable with synthetic positions walked along a real `trazado`, and lets
 *     both clients share it through `@shared/services/journeyGuide` (§1.1 R2).
 *
 * Vagón is carried on the waypoints rather than looked up here: `buildPlatform`
 * (§5.5.6) already resolves which services board from which vagón, and it is the
 * one thing this guidance can say that no general-purpose transit app can.
 */

import { speakDistance, speakPlace, speakRouteCode } from './voiceSpanish';

export type LngLat = [number, number];

// ── Input model ─────────────────────────────────────────────────────────────
// Deliberately independent of `JourneyStep` (`router.ts`): the router's step
// carries stop *names* only, while guidance needs their coordinates to know
// which one the rider has reached. The caller resolves names → coordinates from
// the catalog it already holds and hands over the enriched shape.

/** A point along the journey the rider can be told about. */
export interface GuidePoint {
  name: string;
  code: string;
  coord: LngLat;
  /** Vagón to board from / alight at, when the platform is known (§5.5.6). */
  wagon?: string;
}

export interface GuideStep {
  type: 'walk' | 'ride';
  routeCode?: string;
  routeType?: 'troncal' | 'zonal' | 'cable';
  from: GuidePoint;
  to: GuidePoint;
  /** Intermediate stops in travel order, boarding and alighting excluded. */
  via: GuidePoint[];
  /** The leg's drawn geometry, in travel order. */
  path: LngLat[];
  /** Planned duration in minutes, as the router charged it. */
  time: number;
  /** Planned length in metres, as the router charged it (`JourneyStep.distance`). */
  distance: number;
}

export interface GuideJourney {
  steps: GuideStep[];
}

/** One position report. `accuracy` is the radius in metres, when the source knows it. */
export interface RiderFix {
  coord: LngLat;
  accuracy?: number;
  at: number;
}

// ── Output model ────────────────────────────────────────────────────────────

export type CueKind =
  | 'walk'      // start of a walking leg
  | 'board'     // the rider is at the boarding point of a ride
  | 'prepare'   // one stop out from alighting
  | 'alight'    // get off here, journey continues on foot
  | 'transfer'  // get off here and change to another service
  | 'arrived'   // final destination reached
  | 'offRoute'; // the rider is nowhere near the plan

export interface Cue {
  kind: CueKind;
  stepIndex: number;
  /** Stable identity, so a client never repeats a cue across fixes or reloads. */
  id: string;
  /** Spanish, ready to speak or show. */
  say: string;
  point?: GuidePoint;
}

/**
 * Everything the engine needs to remember between fixes. Plain JSON so a client
 * can persist it across a reload or a backgrounded app and resume mid-journey.
 */
export interface GuideState {
  stepIndex: number;
  emitted: string[];
  /** Consecutive fixes that projected far from the plan; drives `offRoute`. */
  strayCount: number;
}

export interface GuideProgress {
  stepIndex: number;
  /** 0..1 along the current step. */
  fraction: number;
  metresToStepEnd: number;
  /** Ride steps: stops still to pass, the alighting stop included. */
  stopsRemaining?: number;
  cue: Cue | null;
}

export interface GuideUpdate {
  progress: GuideProgress;
  state: GuideState;
}

// ── Thresholds ──────────────────────────────────────────────────────────────
// Named rather than inlined: these are the whole behaviour of the feature, and
// they are the first thing to tune once it has been ridden in the real city.

/** Within this of the alighting point, the alight/transfer cue fires. */
const ALIGHT_RADIUS_M = 150;
/**
 * Within this of the end of a walk leg, arrival fires. Much tighter than
 * `ALIGHT_RADIUS_M`: a bus needs warning before the doors, but announcing
 * "llegaste" 150 m from the door is simply wrong.
 */
const ARRIVE_RADIUS_M = 40;
/** Within this of the boarding point, the board cue fires. */
const BOARD_RADIUS_M = 80;
/**
 * Stops still to pass when "prepare" fires. At 1 the alighting stop is genuinely
 * the next one, which is the only point at which "Próxima: X" is a true sentence
 * — at 2 the cue names the alighting stop while a different stop comes first.
 */
const PREPARE_LEAD_STOPS = 1;
/** Beyond this from the plan, a fix counts as stray. */
const STRAY_M = 400;
/** Consecutive stray fixes before `offRoute` is announced — one bad fix is not lost. */
const STRAY_FIXES_BEFORE_OFF_ROUTE = 3;
/** Fixes worse than this are ignored outright rather than moving the rider. */
const MAX_USABLE_ACCURACY_M = 100;

// ── Geometry ────────────────────────────────────────────────────────────────
// Local and deliberately minimal. `trace.ts` projects onto a route's `trazado`
// via an ordinal-keyed `TraceIndex` built for drawing whole rides; this needs a
// plain point-to-polyline projection over an already-cut leg, which that index
// does not expose. Kept small enough not to be a second implementation of it.

const EARTH_RADIUS_M = 6371008.8;

function haversineMeters(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Local planar approximation, good to well under a metre at city scale. */
function toPlane(origin: LngLat, p: LngLat): [number, number] {
  const toRad = Math.PI / 180;
  const x = (p[0] - origin[0]) * toRad * EARTH_RADIUS_M * Math.cos(origin[1] * toRad);
  const y = (p[1] - origin[1]) * toRad * EARTH_RADIUS_M;
  return [x, y];
}

interface Projection {
  /** Distance from the fix to the polyline, metres. */
  offset: number;
  /** Distance travelled along the polyline to the projected point, metres. */
  along: number;
}

function projectOntoPath(path: LngLat[], cumulative: number[], coord: LngLat): Projection {
  if (path.length === 0) return { offset: Infinity, along: 0 };
  if (path.length === 1) return { offset: haversineMeters(path[0], coord), along: 0 };

  let best: Projection = { offset: Infinity, along: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const origin = path[i];
    const [bx, by] = toPlane(origin, path[i + 1]);
    const [px, py] = toPlane(origin, coord);
    const lenSq = bx * bx + by * by;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
    const dx = px - bx * t;
    const dy = py - by * t;
    const offset = Math.sqrt(dx * dx + dy * dy);
    if (offset < best.offset) {
      const segment = cumulative[i + 1] - cumulative[i];
      best = { offset, along: cumulative[i] + segment * t };
    }
  }
  return best;
}

// ── Preparation ─────────────────────────────────────────────────────────────

interface PreparedStep {
  step: GuideStep;
  cumulative: number[];
  length: number;
  /** `via` distances along the path, travel order, so stop counting is O(n). */
  viaAlong: number[];
}

export interface PreparedGuide {
  journey: GuideJourney;
  steps: PreparedStep[];
}

/**
 * Precomputes per-step cumulative path distances and projects each intermediate
 * stop onto its leg once. Done up front so `advanceGuide` stays cheap enough to
 * run on every GPS fix without touching the event loop budget (§1.1 R2).
 */
export function prepareGuide(journey: GuideJourney): PreparedGuide {
  const steps = journey.steps.map((step) => {
    const cumulative: number[] = [0];
    for (let i = 1; i < step.path.length; i++) {
      cumulative.push(cumulative[i - 1] + haversineMeters(step.path[i - 1], step.path[i]));
    }
    const length = cumulative.length ? cumulative[cumulative.length - 1] : 0;
    const viaAlong = step.via.map((p) => projectOntoPath(step.path, cumulative, p.coord).along);
    return { step, cumulative, length, viaAlong };
  });
  return { journey, steps };
}

export function initialGuideState(): GuideState {
  return { stepIndex: 0, emitted: [], strayCount: 0 };
}

// ── Phrasing ────────────────────────────────────────────────────────────────
// Route codes, distances and place names go through `voiceSpanish` so guidance
// sounds like the rest of the voice surface rather than a second dialect.

function withWagon(point: GuidePoint): string {
  return point.wagon ? `, ${/^\d/.test(point.wagon) ? 'vagón' : 'Vagón'} ${point.wagon}` : '';
}

function cueText(kind: CueKind, step: GuideStep, next: GuideStep | undefined): string {
  const route = step.routeCode ? speakRouteCode(step.routeCode) : '';
  switch (kind) {
    case 'walk':
      return `Camina ${speakDistance(step.distance)} hasta ${speakPlace(step.to.name)}${withWagon(step.to)}.`;
    case 'board':
      return `Sube al ${route} en ${speakPlace(step.from.name)}${withWagon(step.from)}.`;
    case 'prepare':
      return `Próxima: ${speakPlace(step.to.name)}. Prepárate para bajar.`;
    case 'alight':
      return `Bájate aquí, en ${speakPlace(step.to.name)}.`;
    case 'transfer': {
      if (next && next.type === 'ride' && next.routeCode) {
        return `Bájate aquí. Transbordo al ${speakRouteCode(next.routeCode)}${withWagon(next.from)}.`;
      }
      return `Bájate aquí, en ${speakPlace(step.to.name)}.`;
    }
    case 'arrived':
      return `Llegaste a ${speakPlace(step.to.name)}.`;
    case 'offRoute':
      return 'Parece que te saliste de la ruta. Vuelve a planear el viaje.';
  }
}

function makeCue(
  kind: CueKind,
  stepIndex: number,
  step: GuideStep,
  next: GuideStep | undefined,
  point?: GuidePoint,
): Cue {
  return { kind, stepIndex, id: `${stepIndex}:${kind}`, say: cueText(kind, step, next), point };
}

// ── The engine ──────────────────────────────────────────────────────────────

/**
 * Advances the journey by one position fix.
 *
 * Step selection only ever moves forward, and only to the immediately following
 * step: a rider whose fix lands near a later leg (two legs of one trip often run
 * within metres of each other) must not be teleported past a transfer they have
 * not made yet.
 */
export function advanceGuide(
  prepared: PreparedGuide,
  fix: RiderFix,
  prev: GuideState = initialGuideState(),
): GuideUpdate {
  const state: GuideState = {
    stepIndex: prev.stepIndex,
    emitted: [...prev.emitted],
    strayCount: prev.strayCount,
  };
  const steps = prepared.steps;

  // A fix too vague to place the rider tells us nothing; hold the previous state
  // rather than letting a 500 m circle advance the journey (§1 certainty).
  if (fix.accuracy !== undefined && fix.accuracy > MAX_USABLE_ACCURACY_M) {
    const held = steps[state.stepIndex];
    return {
      progress: {
        stepIndex: state.stepIndex,
        fraction: 0,
        metresToStepEnd: held ? held.length : 0,
        cue: null,
      },
      state,
    };
  }

  const current = steps[state.stepIndex];
  if (!current) {
    return {
      progress: { stepIndex: state.stepIndex, fraction: 1, metresToStepEnd: 0, cue: null },
      state,
    };
  }

  let index = state.stepIndex;
  let projection = projectOntoPath(current.step.path, current.cumulative, fix.coord);

  const ahead = steps[index + 1];
  if (ahead) {
    const aheadProjection = projectOntoPath(ahead.step.path, ahead.cumulative, fix.coord);
    const nearlyDone = current.length - projection.along < ALIGHT_RADIUS_M;
    if (aheadProjection.offset < projection.offset && nearlyDone) {
      index += 1;
      projection = aheadProjection;
      state.stepIndex = index;
    }
  }

  const active = steps[index];
  const step = active.step;
  const next = steps[index + 1]?.step;
  const remaining = Math.max(0, active.length - projection.along);
  const fraction = active.length > 0 ? Math.min(1, projection.along / active.length) : 1;

  state.strayCount = projection.offset > STRAY_M ? state.strayCount + 1 : 0;

  let stopsRemaining: number | undefined;
  if (step.type === 'ride') {
    const passed = active.viaAlong.filter((a) => a <= projection.along).length;
    stopsRemaining = step.via.length - passed + 1; // + the alighting stop itself
  }

  const cue = selectCue({ index, step, next, active, projection, remaining, stopsRemaining, state });
  if (cue) state.emitted.push(cue.id);

  return {
    progress: { stepIndex: index, fraction, metresToStepEnd: remaining, stopsRemaining, cue },
    state,
  };
}

interface CueContext {
  index: number;
  step: GuideStep;
  next: GuideStep | undefined;
  active: PreparedStep;
  projection: Projection;
  remaining: number;
  stopsRemaining: number | undefined;
  state: GuideState;
}

/** Picks at most one cue, newest-need-first, and never one already spoken. */
function selectCue(ctx: CueContext): Cue | null {
  const { index, step, next, projection, remaining, stopsRemaining, state } = ctx;
  const unspoken = (kind: CueKind) => !state.emitted.includes(`${index}:${kind}`);

  if (state.strayCount >= STRAY_FIXES_BEFORE_OFF_ROUTE && unspoken('offRoute')) {
    return makeCue('offRoute', index, step, next);
  }

  // Arrival, alighting and transfers all fire on proximity to the step's end,
  // at the radius appropriate to how the rider is travelling.
  const endRadius = step.type === 'walk' ? ARRIVE_RADIUS_M : ALIGHT_RADIUS_M;
  if (remaining <= endRadius) {
    const last = !next;
    if (last && unspoken('arrived')) return makeCue('arrived', index, step, next, step.to);
    if (!last && step.type === 'ride') {
      const kind: CueKind = next.type === 'ride' ? 'transfer' : 'alight';
      if (unspoken(kind)) return makeCue(kind, index, step, next, step.to);
    }
  }

  // Boarding is checked before preparing to alight: on a short leg both can be
  // satisfied by the same fix, and being told to get ready to get off before
  // being told to get on is nonsense.
  if (step.type === 'ride' && projection.along <= BOARD_RADIUS_M && unspoken('board')) {
    return makeCue('board', index, step, next, step.from);
  }

  if (step.type === 'walk' && projection.along <= BOARD_RADIUS_M && unspoken('walk')) {
    return makeCue('walk', index, step, next, step.to);
  }

  if (
    step.type === 'ride' &&
    stopsRemaining !== undefined &&
    stopsRemaining <= PREPARE_LEAD_STOPS &&
    projection.along > BOARD_RADIUS_M &&
    remaining > ALIGHT_RADIUS_M &&
    unspoken('prepare')
  ) {
    return makeCue('prepare', index, step, next, step.to);
  }

  return null;
}
