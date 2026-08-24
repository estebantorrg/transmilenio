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

import type { JourneyPlan, JourneyStep } from './router';
import { both, type Phrasing } from './voiceAnswer';

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
  /** Read aloud verbatim: letter names ("efe 19"), dashed names voiced as pauses. */
  spoken: string;
  /**
   * The same instruction for the eye: the código painted on the bus ("F19"), the
   * place name exactly as the catalog files it.
   *
   * Composed separately rather than reused from {@link Cue.spoken}, for the same
   * reason every voice answer is (spec §5.9): es-CO TTS reads a bare `F` as
   * English, so the speaker has to be told "efe 19" — while a rider glancing at a
   * banner in a moving bus has to see the código they can match against the
   * windscreen. Showing the spoken form is the exact defect that shape exists to
   * prevent.
   */
  written: string;
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
  /**
   * Distance along the current step at the last **usable** fix, in metres.
   *
   * Kept so a fix too vague to place the rider (see {@link MAX_USABLE_ACCURACY_M})
   * reports the progress that still holds instead of resetting the leg to zero — a
   * banner that jumps from "faltan 2 paradas" back to the boarding stop every time
   * the phone loses sky is worse than one that simply does not move.
   */
  along: number;
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
/**
 * Upper bound on how far from the alighting point "prepare" may fire. Stop
 * counting alone is not enough: a ride with no intermediate stops has the
 * alighting stop next from the moment it starts, so on a long direct hop the cue
 * would fire the instant the rider boarded. Roughly one troncal inter-station gap.
 */
const PREPARE_MAX_REMAINING_M = 1200;
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
  return { stepIndex: 0, emitted: [], strayCount: 0, along: 0 };
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/** Vagón per stop code, when the caller can resolve platforms (§5.5.6). */
export type WagonLookup = (code: string) => string | undefined;

/**
 * Turns a planned itinerary into something guidable.
 *
 * Coordinates come from the router's `fromCoord`/`toCoord`/`stopPoints` (§5.6),
 * falling back to the drawn path's endpoints — the shape a leg is drawn along
 * starts and ends at the points it joins (§5.7 #8), so the ends are the stops
 * even when the explicit fields are absent on an older cached plan.
 *
 * A step with no usable geometry **ends** the guidable journey rather than being
 * skipped over. Splicing one out of the middle silently rewrites the trip: drop
 * the walk between two rides and the engine announces a transfer where the rider
 * was meant to get off and walk two blocks. Guiding as far as the geometry
 * reaches and then falling silent is the honest form of the same limitation (§1).
 */
export function buildGuideJourney(plan: JourneyPlan, wagonFor?: WagonLookup): GuideJourney {
  const steps: GuideStep[] = [];
  for (const step of plan.steps as JourneyStep[]) {
    const path = (step.path ?? []) as LngLat[];
    const from = step.fromCoord ?? path[0];
    const to = step.toCoord ?? path[path.length - 1];
    if (!from || !to || path.length < 2) break;

    steps.push({
      type: step.type,
      routeCode: step.routeCode,
      routeType: step.routeType,
      from: { name: step.fromName, code: step.fromCode, coord: from, wagon: wagonFor?.(step.fromCode) },
      to: { name: step.toName, code: step.toCode, coord: to, wagon: wagonFor?.(step.toCode) },
      via: (step.stopPoints ?? []).map((p) => ({ name: p.name, code: p.code, coord: p.coord })),
      path,
      time: step.time,
      distance: step.distance,
    });
  }
  return { steps };
}

// ── Phrasing ────────────────────────────────────────────────────────────────
// Every cue is composed **twice**, through the same `Phrasing` tables the voice
// answers use (`voiceAnswer.ts`): once for the speaker, once for the screen. A
// second set of tables would drift, and a single string is the defect that puts
// "el efe 19" in front of a rider's eyes (spec §5.9, §1.1 R2).

/** ", vagón C" — lower case because it is always mid-sentence (§5.5.6). */
function withWagon(point: GuidePoint): string {
  return point.wagon ? `, vagón ${point.wagon}` : '';
}

function cueText(kind: CueKind, step: GuideStep, next: GuideStep | undefined, p: Phrasing): string {
  switch (kind) {
    case 'walk':
      return `Camina ${p.distance(step.distance)} hasta ${p.place(step.to.name)}${withWagon(step.to)}.`;
    case 'board':
      return `Sube al ${p.code(step.routeCode ?? '')} en ${p.place(step.from.name)}${withWagon(step.from)}.`;
    case 'prepare':
      return `Próxima: ${p.place(step.to.name)}. Prepárate para bajar.`;
    case 'alight':
      return `Bájate aquí, en ${p.place(step.to.name)}.`;
    case 'transfer': {
      if (next && next.type === 'ride' && next.routeCode) {
        return `Bájate aquí. Transbordo al ${p.code(next.routeCode)}${withWagon(next.from)}.`;
      }
      return `Bájate aquí, en ${p.place(step.to.name)}.`;
    }
    case 'arrived':
      // The last leg of a plan is regularly a ride, and "llegaste" on its own is
      // not an instruction to someone still sitting down — the actionable half is
      // that this is the door to use.
      return step.type === 'ride'
        ? `Bájate aquí. Llegaste a ${p.place(step.to.name)}.`
        : `Llegaste a ${p.place(step.to.name)}.`;
    case 'offRoute':
      return 'Parece que te saliste de la ruta. Vuelve a planear el viaje.';
  }
}

/**
 * What the rider is doing on this leg, for the long stretches between cues.
 *
 * A cue is a moment; a ride is twenty minutes. A surface that carries only the
 * last cue spends most of a journey showing an instruction the rider carried out
 * a quarter of an hour ago, which reads as an app that stopped working — and a
 * rider resuming mid-trip (§5.10) has no cue to show at all until the next
 * threshold. Composed through the same {@link Phrasing} pair as every cue.
 */
export function describeGuideStep(step: GuideStep): { spoken: string; written: string } {
  return both((p) =>
    step.type === 'ride' && step.routeCode
      ? `En el ${p.code(step.routeCode)} hasta ${p.place(step.to.name)}.`
      : `Caminando hasta ${p.place(step.to.name)}.`,
  );
}

function makeCue(
  kind: CueKind,
  stepIndex: number,
  step: GuideStep,
  next: GuideStep | undefined,
  point?: GuidePoint,
): Cue {
  const { spoken, written } = both((p) => cueText(kind, step, next, p));
  return { kind, stepIndex, id: `${stepIndex}:${kind}`, spoken, written, point };
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
    // `?? 0` rather than a bare read: this resumes from persisted JSON, which a
    // client may have written before the field existed.
    along: prev.along ?? 0,
  };
  const steps = prepared.steps;

  // A fix too vague to place the rider tells us nothing; hold the previous state
  // rather than letting a 500 m circle advance the journey (§1 certainty). What
  // is reported is the progress that still holds, not zero — the rider has not
  // moved back to the boarding stop just because their phone lost sky.
  if (fix.accuracy !== undefined && fix.accuracy > MAX_USABLE_ACCURACY_M) {
    const held = steps[state.stepIndex];
    return { progress: heldProgress(state, held), state };
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
  state.along = projection.along;

  const stopsRemaining = stopsLeft(active, projection.along);

  const cue = selectCue({ index, step, next, active, projection, remaining, stopsRemaining, state });
  if (cue) state.emitted.push(cue.id);

  return {
    progress: { stepIndex: index, fraction, metresToStepEnd: remaining, stopsRemaining, cue },
    state,
  };
}

/**
 * Stops the rider has still to pass on a ride, the alighting stop included.
 * `undefined` on a walk, where the notion does not apply.
 */
function stopsLeft(active: PreparedStep, along: number): number | undefined {
  if (active.step.type !== 'ride') return undefined;
  const passed = active.viaAlong.filter((a) => a <= along).length;
  return active.step.via.length - passed + 1; // + the alighting stop itself
}

/**
 * What to report when a fix is too vague to move the rider: everything derived
 * from the last usable position, and no cue. Silence is correct here — the
 * engine has learned nothing since the previous fix.
 */
function heldProgress(state: GuideState, held: PreparedStep | undefined): GuideProgress {
  const length = held ? held.length : 0;
  const along = Math.min(state.along, length);
  return {
    stepIndex: state.stepIndex,
    fraction: length > 0 ? along / length : 1,
    metresToStepEnd: Math.max(0, length - along),
    stopsRemaining: held ? stopsLeft(held, along) : undefined,
    cue: null,
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
    remaining <= PREPARE_MAX_REMAINING_M &&
    unspoken('prepare')
  ) {
    return makeCue('prepare', index, step, next, step.to);
  }

  return null;
}
