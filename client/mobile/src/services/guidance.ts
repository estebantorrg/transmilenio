/**
 * In-journey guidance, wired for the APK (spec §5.10).
 *
 * The engine (`@shared/services/journeyGuide`) is pure: positions and a plan in,
 * "what to say now" out. This is the part that is not — it owns the GPS watch,
 * the speech, and the one piece of state a rider would lose if the app were
 * killed mid-trip.
 *
 * Design notes:
 *
 *  - **`watchPosition`, not polling.** The OS already coalesces fixes; a timer
 *    on top of it would burn battery to learn nothing new.
 *  - **Speech is fire-and-forget.** `speak()` resolves when the utterance ends,
 *    which can be seconds; awaiting it inside the fix handler would queue cues
 *    behind each other and announce a stop after the rider had passed it.
 *  - **The journey survives a reload.** `GuideState` is plain JSON and is
 *    persisted whenever it moves, so an app killed in the background resumes
 *    without re-announcing what the rider already heard (spec §4.2).
 *  - **One snapshot, broadcast on the app's own bus.** Guidance outlives the
 *    screen that started it — the rider switches to Mapa, or the app is
 *    relaunched mid-trip — so no view owns it. Everything that shows guidance
 *    (the banner, the per-plan button) reads {@link guidanceSnapshot} and
 *    subscribes to `bus.on('guidance', …)` rather than holding callbacks of its
 *    own (§1.1 R2).
 */

import {
  advanceGuide,
  buildGuideJourney,
  describeGuideStep,
  initialGuideState,
  prepareGuide,
  type Cue,
  type GuideProgress,
  type GuideState,
  type PreparedGuide,
} from '@shared/services/journeyGuide';
import type { JourneyPlan } from '@shared/services/router';
import { speak } from '../voice/bridge';
import { bus, state } from '../state';
import { loadJSON, saveJSON, removeKey } from '../lib/storage';

const STORAGE_KEY = 'tmgo.guidance.v1';

/**
 * Rejects fixes the browser reports as older than this — a stale cache fix places
 * the rider where they were, not where they are.
 */
const MAX_FIX_AGE_MS = 30_000;

/**
 * How long a stored journey is still the trip the rider is on.
 *
 * Longer than any Bogotá itinerary the router will produce, and short enough that
 * opening the app the next morning does not resume yesterday's commute and start
 * announcing stops for it.
 */
const MAX_RESUME_AGE_MS = 3 * 60 * 60 * 1000;

/** Why guidance cannot run, when it cannot. Each is a different sentence. */
export type GuidanceProblem =
  /** No geolocation at all on this device. */
  | 'sin-gps'
  /** Location permission denied — guidance can never advance until it is granted. */
  | 'sin-permiso'
  /** The plan carries no usable geometry, so there is nothing to guide along. */
  | 'sin-trazado'
  /** No fix right now (indoors, tunnel). Transient: the watch keeps trying. */
  | 'sin-senal';

/** Everything a screen needs to render guidance, in one value. */
export interface GuidanceSnapshot {
  /** True while the position watch is running. */
  active: boolean;
  /** The itinerary being guided, or the one just finished. */
  plan: JourneyPlan | null;
  /**
   * The newest instruction. Kept after the journey ends so the arrival line stays
   * on screen — clearing it the instant the last cue fired showed "Llegaste a…"
   * for a single frame.
   */
  cue: Cue | null;
  /**
   * What the rider is doing right now ("En el F19 hasta Av. Chile"), for the
   * stretches between cues — which is most of a journey — and for a trip resumed
   * mid-ride, which has no cue to show until the next threshold.
   */
  standing: { spoken: string; written: string } | null;
  progress: GuideProgress | null;
  problem: GuidanceProblem | null;
}

interface Persisted {
  plan: JourneyPlan;
  state: GuideState;
  savedAt: number;
}

let watchId: number | null = null;
let prepared: PreparedGuide | null = null;
let guideState: GuideState = initialGuideState();
let snapshot: GuidanceSnapshot = {
  active: false,
  plan: null,
  cue: null,
  standing: null,
  progress: null,
  problem: null,
};

export function guidanceSnapshot(): GuidanceSnapshot {
  return snapshot;
}

export function isGuiding(): boolean {
  return snapshot.active;
}

function publish(patch: Partial<GuidanceSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  bus.emit('guidance', snapshot);
}

/** Which vagón `routeCode` boards from at `stationCode`, when the catalog knows. */
function wagonAt(stationCode: string, routeCode: string | undefined): string | undefined {
  if (!routeCode) return undefined;
  const station = state.stations.find((s) => s.code === stationCode);
  return station?.wagonByRoute?.[routeCode];
}

/**
 * Builds the guidable journey, resolving each boarding point's vagón against the
 * station it belongs to. The vagón is looked up per *step* rather than per point
 * because the answer depends on which service is being boarded, not only on where
 * the rider is standing.
 */
function toGuideJourney(plan: JourneyPlan) {
  const wagonByStop = new Map<string, string>();
  for (const step of plan.steps) {
    if (step.type !== 'ride') continue;
    const boarding = wagonAt(step.fromCode, step.routeCode);
    if (boarding) wagonByStop.set(step.fromCode, boarding);
  }
  return buildGuideJourney(plan, (code) => wagonByStop.get(code));
}

/**
 * Same origin, destination and services — enough to call it the same trip.
 *
 * Structural, never reference identity: the planner re-renders its cards after
 * the real walking legs land (§5.6.4), so the object a button closes over is not
 * the object guidance was started with, and comparing references left one card
 * offering to end a journey while another offered to start it.
 */
export function isGuidedPlan(plan: JourneyPlan): boolean {
  return snapshot.plan !== null && samePlan(snapshot.plan, plan);
}

function samePlan(a: JourneyPlan, b: JourneyPlan): boolean {
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, i) => {
    const other = b.steps[i];
    return (
      step.type === other.type &&
      step.fromCode === other.fromCode &&
      step.toCode === other.toCode &&
      step.routeCode === other.routeCode
    );
  });
}

/**
 * Starts guiding `plan`, resuming this journey's progress when it is the one the
 * app was last killed on. Returns false when the device will not give a position
 * at all, or the plan has no geometry to guide along — the snapshot names which.
 */
export function startGuidance(plan: JourneyPlan): boolean {
  // Read before tearing anything down: `stopGuidance` clears the store, so
  // loading afterwards always found nothing and every resume silently restarted
  // the trip from its first instruction.
  const saved = loadJSON<Persisted>(STORAGE_KEY);
  const resumable =
    saved && samePlan(saved.plan, plan) && Date.now() - (saved.savedAt ?? 0) < MAX_RESUME_AGE_MS;

  stopWatch();

  // A start that cannot run ends whatever was running, storage included — the
  // watch is already down, and leaving a journey on disk would have the next
  // launch resume a trip the rider had visibly just replaced.
  const refuse = (problem: GuidanceProblem): false => {
    removeKey(STORAGE_KEY);
    publish({ active: false, plan, cue: null, standing: null, progress: null, problem });
    return false;
  };

  if (!navigator.geolocation) return refuse('sin-gps');

  const journey = toGuideJourney(plan);
  if (journey.steps.length === 0) return refuse('sin-trazado');

  prepared = prepareGuide(journey);
  guideState = resumable ? saved!.state : initialGuideState();
  publish({
    active: true,
    plan,
    cue: null,
    standing: standingAt(guideState.stepIndex),
    progress: null,
    problem: null,
  });
  persist(plan);

  watchId = navigator.geolocation.watchPosition(onFix, onWatchError, {
    enableHighAccuracy: true,
    maximumAge: 10_000,
    timeout: 20_000,
  });
  return true;
}

/**
 * Resume the journey the app was killed on, if there is one and it is still
 * plausibly the trip the rider is making. Called once the catalog is loaded, so
 * the vagón lookup has something to read (§5.5.6).
 */
export function resumeGuidance(): boolean {
  const saved = loadJSON<Persisted>(STORAGE_KEY);
  if (!saved?.plan || Date.now() - (saved.savedAt ?? 0) >= MAX_RESUME_AGE_MS) {
    if (saved) removeKey(STORAGE_KEY);
    return false;
  }
  return startGuidance(saved.plan);
}

/**
 * End the journey.
 *
 * `keepCue` is what arrival uses: the trip is over, but the instruction that
 * ended it must stay on screen. Clearing it in the same tick it was published
 * showed "Llegaste a…" for a single frame and then nothing.
 */
export function stopGuidance(opts: { keepCue?: boolean } = {}): void {
  stopWatch();
  removeKey(STORAGE_KEY);
  publish({
    active: false,
    plan: opts.keepCue ? snapshot.plan : null,
    cue: opts.keepCue ? snapshot.cue : null,
    standing: null,
    progress: opts.keepCue ? snapshot.progress : null,
    problem: null,
  });
}

function stopWatch(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  prepared = null;
  guideState = initialGuideState();
}

function persist(plan: JourneyPlan): void {
  saveJSON<Persisted>(STORAGE_KEY, { plan, state: guideState, savedAt: Date.now() });
}

/**
 * A fix's own timestamp, sanitised.
 *
 * The Geolocation API specifies epoch milliseconds, but Android WebViews have
 * shipped builds that report uptime instead. Taken at face value that value is
 * decades in the "past", every fix fails the freshness check, and guidance sits
 * there never advancing with nothing on screen to say why. A timestamp that is
 * not plausibly a wall clock is therefore treated as "now" — this fix arrived
 * through the watch, so it is current by construction.
 */
function fixAge(timestamp: number): number {
  const age = Date.now() - timestamp;
  return Number.isFinite(age) && age > -60_000 && age < 24 * 60 * 60 * 1000 ? age : 0;
}

function onFix(pos: GeolocationPosition): void {
  if (!prepared || !snapshot.plan) return;
  if (fixAge(pos.timestamp) > MAX_FIX_AGE_MS) return;

  const previousStep = guideState.stepIndex;
  const previousStops = snapshot.progress?.stopsRemaining;
  const { progress, state: next } = advanceGuide(
    prepared,
    {
      coord: [pos.coords.longitude, pos.coords.latitude],
      accuracy: pos.coords.accuracy,
      at: pos.timestamp,
    },
    guideState,
  );
  guideState = next;

  // A fix that arrives is proof the transient "no signal" state is over.
  const problem = snapshot.problem === 'sin-senal' ? null : snapshot.problem;
  publish({
    progress,
    cue: progress.cue ?? snapshot.cue,
    standing: standingAt(progress.stepIndex),
    problem,
  });

  // Persisted whenever the journey actually moved — a cue, a stop passed, or a
  // leg completed. Every fix would rewrite localStorage a few times a minute for
  // nothing; only a cue would leave the stored `along` pinned at the boarding
  // stop for the whole ride, so a resumed trip would open on the progress it had
  // twenty minutes ago until the next fix corrected it.
  const passedAStop = progress.stopsRemaining !== undefined && progress.stopsRemaining !== previousStops;
  if (progress.cue || passedAStop || next.stepIndex !== previousStep) persist(snapshot.plan);

  if (!progress.cue) return;
  // Not awaited: `speak` resolves when the utterance finishes, and blocking the
  // fix handler on it would announce stops after the rider had passed them.
  void speak(progress.cue.spoken);
  if (progress.cue.kind === 'arrived') stopGuidance({ keepCue: true });
}

/**
 * A position error.
 *
 * A denied permission is terminal — the watch will never produce a fix, and
 * leaving a banner that says "guiando el viaje" over a journey that can never
 * advance is the failure this branch exists to prevent. Everything else (indoors,
 * in a tunnel, no sky) is transient: the watch keeps trying and the rider is told
 * why the instructions have stopped, not that the trip has ended.
 */
function onWatchError(error: GeolocationPositionError): void {
  if (error.code === error.PERMISSION_DENIED) {
    stopWatch();
    removeKey(STORAGE_KEY);
    publish({ active: false, cue: null, standing: null, progress: null, problem: 'sin-permiso' });
    return;
  }
  publish({ problem: 'sin-senal' });
}

/** The leg the rider is on, phrased for both surfaces. */
function standingAt(stepIndex: number): { spoken: string; written: string } | null {
  const step = prepared?.journey.steps[stepIndex];
  return step ? describeGuideStep(step) : null;
}
