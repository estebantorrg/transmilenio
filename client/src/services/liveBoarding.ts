/**
 * Keeping a set of itineraries on the live wait at their first boarding
 * (spec §5.6.6), for as long as the rider is looking at them.
 *
 * `router.ts` owns the arithmetic — which lookups a pool needs
 * (`liveBoardingTargets`) and what the answers do to it (`applyLiveBoarding`).
 * This is the part with a clock and a network in it: ask for those routes'
 * buses, hand back the re-ranked itineraries, ask again while the plan is on
 * screen. Shared by the website and the app, which differ only in how a lookup
 * reaches the feed (`api.getLiveBuses` routes that) and in how fast it answers:
 * ~0.3 s from a phone in Colombia, 9–24 s or nothing through the public proxies
 * the plain website falls back to. So nothing here may wait on the feed:
 *
 *  · the itineraries are already on screen before this starts;
 *  · a lookup that has not answered within the first budget is simply absent
 *    from that pass — the plan it belongs to keeps its assumed wait — and joins
 *    a later one when it lands;
 *  · a failed or low-confidence answer is "no reading", never "no buses".
 *
 * The other thing it must not do is hammer the feed. One lookup per route
 * direction boarded first (four to six for a typical pool), every 25 s, only
 * while the caller says the plan is still wanted, and never for longer than ten
 * minutes: a plan left open on a desk is not a rider about to leave.
 */

import { applyLiveBoarding, liveBoardingTargets, type JourneyPlan, type JourneyStep, type LiveBoardingTarget } from './router';
import type { LiveBoarding } from './liveWait';
import { bogotaNow } from './schedule';

/** Buses move ~150 m in this time; sooner would re-ask for the same picture. */
export const LIVE_BOARDING_REFRESH_MS = 25_000;
/** How long the first pass waits before showing what has answered so far. */
const FIRST_PASS_BUDGET_MS = 3_500;
/** A lookup slower than this is abandoned for the round. */
const LOOKUP_TIMEOUT_MS = 14_000;
/** A reading older than this is not shown as live: the buses have moved on. */
const READING_MAX_AGE_MS = 70_000;
/** A plan nobody has refreshed or replaced in this long stops being followed. */
const SESSION_MAX_MS = 10 * 60_000;
/** No pool needs more: it is one per first-boarded route direction, of ≤ 8 plans. */
const MAX_TARGETS = 8;

/** One route direction's live vehicles, or null when there is no usable answer. */
export type LiveBusFetcher = (target: LiveBoardingTarget) => Promise<unknown[] | null>;

/**
 * The feed through the client's own cascade. `api.ts` is imported on first use:
 * it reads `import.meta.env` at module scope, which the Node-run specs and the
 * planner bench cannot evaluate, and nothing here needs it until a lookup runs.
 */
const fetchThroughApi: LiveBusFetcher = async (target) => {
  const { api } = await import('./api');
  const result = await api.getLiveBuses(target.routeCode, target.nombre, target.routeType, target.nombreCandidates, { fresh: true });
  // Only positions the feed itself just gave: `stale` is a cached fix replayed
  // by a tier that could not reach it, and an empty answer through a public
  // proxy is `unverified` — neither says where the buses are now.
  return result.status === 'live' ? result.data : null;
};

export interface LiveBoardingWatch {
  /** Every itinerary that survived the walking pass, ranked (`resolveWalkingLegs`'
   *  `out.pool`). Mutated in place on each pass. */
  pool: JourneyPlan[];
  sortBy?: 'transfers' | 'time' | 'walk';
  /** The itineraries to show, after each pass that changed something. */
  onUpdate: (shown: JourneyPlan[]) => void;
  /** False once these itineraries are no longer what the rider is looking at
   *  (a newer search, another tab). The watch then ends for good. */
  isActive: () => boolean;
  /** True while the itineraries are still the rider's but out of sight (the
   *  planner panel behind another one): no lookups, and the watch resumes. */
  isPaused?: () => boolean;
  fetchBuses?: LiveBusFetcher;
}

/** What a pass shows, reduced to the parts a card prints — so a refresh that
 *  changed nothing a rider can see does not rebuild the cards under their thumb. */
function shownSignature(shown: JourneyPlan[]): string {
  return shown
    .map((plan) => {
      const ride = plan.steps.find((step) => step.type === 'ride');
      const live = ride?.live;
      const minute = (value: number | undefined): string => (value === undefined ? '-' : String(Math.round(value)));
      return [
        plan.departMinute ?? '',
        plan.totalTime,
        plan.transfers,
        ride?.routeId ?? '',
        ride?.fromCode ?? '',
        live ? `${live.status}:${minute(live.etaMin)}:${minute(live.missedEtaMin)}:${live.approx ? 'a' : live.firm ? 'f' : 't'}` : 'x',
      ].join('|');
    })
    .join('§');
}

/**
 * Starts following `pool` — itineraries planned to leave now — and returns the
 * function that stops it. Calls `onUpdate` whenever a pass changes what the
 * cards say: a live wait, the order, or simply the minute the trip starts at.
 */
export function watchLiveBoarding(watch: LiveBoardingWatch): () => void {
  const targets = liveBoardingTargets(watch.pool).slice(0, MAX_TARGETS);
  if (targets.length === 0) return () => undefined;

  const fetchBuses = watch.fetchBuses ?? fetchThroughApi;
  const readings = new Map<string, { buses: unknown[]; at: number }>();
  const startedAt = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastShown = shownSignature(watch.pool.slice(0, 4));

  const alive = (): boolean => !stopped && watch.isActive();

  const apply = (): void => {
    if (!alive()) return;
    const now = Date.now();
    const fresh = new Map<string, unknown[] | null>();
    for (const [routeId, reading] of readings) {
      if (now - reading.at <= READING_MAX_AGE_MS) fresh.set(routeId, reading.buses);
      else readings.delete(routeId);
    }
    // These itineraries leave NOW, and now has moved since the search: the
    // clock times on the cards are re-counted from this moment on every pass.
    const shown = applyLiveBoarding(watch.pool, fresh, { nowMs: now, sortBy: watch.sortBy, departAt: bogotaNow(new Date(now)) });
    const signature = shownSignature(shown);
    if (signature === lastShown) return;
    lastShown = signature;
    watch.onUpdate(shown);
  };

  const lookup = async (target: LiveBoardingTarget): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const buses = await Promise.race([
        fetchBuses(target),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
        }),
      ]);
      // A failed round does not erase a reading that is still young: the buses
      // it describes are still roughly where it put them, and `apply` ages it out.
      if (buses) readings.set(target.routeId, { buses, at: Date.now() });
    } catch {
      /* no reading this round */
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  const round = async (first: boolean): Promise<void> => {
    if (!alive()) return;
    // A hidden page is not a rider reading a plan; skip the lookups, keep the beat.
    const hidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden') || watch.isPaused?.() === true;
    if (!hidden) {
      const all = Promise.all(targets.map(lookup));
      if (first) {
        // Show what the fast lookups say without waiting for the slow ones…
        await Promise.race([all, new Promise((resolve) => setTimeout(resolve, FIRST_PASS_BUDGET_MS))]);
        apply();
      }
      // …and take the rest when they land.
      await all;
      apply();
    }
    if (!alive() || Date.now() - startedAt > SESSION_MAX_MS) {
      // Past the session: hand the plan back to its assumptions rather than
      // leave a "pasa en 3 min" on screen that nobody is updating.
      if (alive()) {
        readings.clear();
        apply();
      }
      stopped = true;
      return;
    }
    timer = setTimeout(() => void round(false), LIVE_BOARDING_REFRESH_MS);
  };

  void round(true);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** How a card says it. `tone` picks the colour: a boarding the rider can count
 *  on, one that is tight, a bus that goes before they get there, or one too
 *  far out to promise anything about. */
export interface LiveBoardingLine {
  text: string;
  tone: 'catch' | 'tight' | 'missed' | 'approx';
}

/** "3 min", or "menos de 1 min" — a rounded 0 reads as "it is not coming". */
function minutesText(minutes: number): string {
  const whole = Math.round(minutes);
  return whole < 1 ? 'menos de 1 min' : `${whole} min`;
}

/**
 * The live line of an itinerary's first ride, or null when there is no reading.
 *
 * Worded from the rider's side — whether they make it — because the minutes
 * alone leave them to do the walk-against-bus arithmetic this feature exists
 * to do for them.
 */
export function describeLiveBoarding(step: Pick<JourneyStep, 'routeCode' | 'live'>): LiveBoardingLine | null {
  const live: LiveBoarding | undefined = step.live;
  if (!live || live.status === 'none') return null;
  const code = step.routeCode ?? 'El bus';

  // The bus predicted at the stop before the rider. "Antes de que llegues" and
  // not "no alcanzas": it states the prediction, and at peak a quarter to a half
  // of those buses were still there when the rider would have arrived.
  const gone =
    live.missedEtaMin === undefined
      ? ''
      : live.missedEtaMin < 1
      ? `${code} está pasando ahora`
      : `${code} pasa en ${minutesText(live.missedEtaMin)}, antes de que llegues`;

  if (live.status === 'missed') return { text: gone, tone: 'missed' };
  const eta = live.etaMin ?? 0;
  // Past the firm horizon the minutes are a guide; inside it, whether the rider
  // makes it comfortably or only just is the thing to say.
  const minutes = `${live.approx ? 'unos ' : ''}${minutesText(eta)}`;
  if (live.status === 'next') {
    return {
      text: `${gone} · el siguiente, en ${minutes}${live.approx || live.firm ? '' : ' (justo)'}`,
      tone: live.approx ? 'approx' : 'missed',
    };
  }
  const verdict = live.approx ? '' : live.firm ? ' · alcanzas' : ' · vas justo';
  return {
    text: `${code} pasa en ${minutes}${verdict}`,
    tone: live.approx ? 'approx' : live.firm ? 'catch' : 'tight',
  };
}
