/**
 * The live wait at a trip's first boarding (spec §5.6.6).
 *
 * The planner charges every boarding an ASSUMED wait — half the route's
 * scheduled headway, or a per-mode constant — so it cannot tell "the bus is one
 * minute away" from "you have just missed it". That is the one question a rider
 * standing at the origin actually has, and until now they answered it by
 * swiping between routes on the live map. This module answers it from the same
 * live positions: which bus of this route, in this direction, is the first one
 * the rider can really board, and how long that makes the wait.
 *
 * Every number here was measured, not chosen (two 22-minute runs following 99
 * and 127 buses to the stops they then reached, a Sunday night and a weekday
 * morning — `scratch/live-spike/`):
 *  · a position is ~45 s old when it arrives (p90 67 s), and the feed says when
 *    it was taken (`lasttime`), so the age is subtracted rather than ignored;
 *  · the estimate is right to ~1 min for a bus 2–5 min away and ~1.7 min at
 *    5–10 min, unbiased; past 10 min the error reaches 3–5 min;
 *  · the error grows with how far out the bus is, so the margin a promise
 *    needs does too (`catchMargin`). Replayed through this code — a third run
 *    at the Monday 18:00 peak included — a firm "alcanzas" was broken, the
 *    promised bus gone before the rider could be there, at most 0.8 % of the
 *    time on a troncal and 2.2 % on a zonal;
 *  · at peak the buses run LATE against these speeds (troncal ~300 m/min, not
 *    400): the minutes shown lean 1–3 early. Slowing the speeds to fit the peak
 *    was tried and broke promises off-peak (zonal 9–13 %), so they stay — an
 *    estimate that errs towards "the bus comes later" never strands anyone;
 *  · "no bus on its way" is NOT something the feed can say: near a route's
 *    first stops the next bus is still parked, or still filed under the
 *    direction it arrived on, and one came within ten minutes 36–100 % of the
 *    times nothing was in sight. So that reading changes nothing.
 *
 * Pure: no fetching and no clock reads. Buses, the moment and the projection are
 * all inputs, so the whole thing runs from Node against a recorded scenario.
 */

/** A rider must reach the stop this long before the bus is predicted there. Never
 *  more than the walk it protects: someone already at the stop needs no margin. */
export const CATCH_MARGIN_MIN = 2;
/** …and never less than this, so a bus "arriving now" is not promised. */
const CATCH_MARGIN_FLOOR_MIN = 0.5;
/** …and never less than this share of the bus's own predicted minutes: a bus
 *  eight minutes out is known to ±3, one two minutes out to ±1. With a flat two
 *  minutes a rider six minutes from the stop lost the promised bus 2.5–11 % of
 *  the time; at this share, under 1 % (troncal) and ~2 % (zonal). */
const CATCH_MARGIN_ETA_SHARE = 0.4;
/** A bus predicted further out than this is shown as approximate: the measured
 *  error past ten minutes (3–5 min) is too wide to promise a boarding on. */
export const LIVE_FIRM_HORIZON_MIN = 10;
/** …and one further out than this says nothing useful about the wait at all. */
export const LIVE_MAX_HORIZON_MIN = 25;
/** A bus further than this from the trace is not on it (GPS drift, another
 *  variant). The same number the arrivals board uses (`stop_arrivals.ts`). */
export const ON_ROUTE_MAX_ERROR_M = 160;
/** A bus this far past the stop has passed it; less than that is GPS jitter. */
export const PASSED_STOP_EPSILON_M = 40;
/** A fix older than this is a bus that has stopped reporting, not a position. */
const FIX_AGE_MAX_MIN = 5;
/** Age assumed when the feed's `lasttime` cannot be read: the measured median. */
const FIX_AGE_DEFAULT_MIN = 0.75;

export interface LiveBusFix {
  lng: number;
  lat: number;
  /** The direction the feed files the bus under (`destino_limpio`), folded. It
   *  is the catalog variant's own name — "Portal Tunal", "Gaviotas" — on every
   *  route measured, including the zonal ones whose two directions share a code. */
  destino: string;
  /** Minutes since the GPS fix; null when the feed does not say. */
  ageMin: number | null;
}

/** Accent- and case-folded, so "Portal Américas" and "PORTAL AMERICAS" agree. */
export function foldName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Minutes since a fix the feed stamps as Bogotá wall-clock (`"09:14:35 PM"`).
 * Bogotá is UTC−5 all year. Null when it cannot be read, or reads as the future
 * by more than a clock's worth of skew.
 */
export function fixAgeMinutes(lasttime: unknown, nowMs: number): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)$/i.exec(String(lasttime ?? '').trim());
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (/pm/i.test(match[4])) hour += 12;
  const fixSecond = hour * 3600 + Number(match[2]) * 60 + Number(match[3]);
  const bogota = new Date(nowMs - 5 * 3600_000);
  const nowSecond = bogota.getUTCHours() * 3600 + bogota.getUTCMinutes() * 60 + bogota.getUTCSeconds();
  let age = nowSecond - fixSecond;
  if (age < -12 * 3600) age += 24 * 3600; // the fix is from before midnight
  if (age < -90) return null;
  return Math.max(0, age) / 60;
}

/** The feed's vehicles as positions, dropping the ones with no usable fix. */
export function readLiveBuses(raw: unknown, nowMs: number): LiveBusFix[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveBusFix[] = [];
  for (const bus of raw as Array<Record<string, unknown>>) {
    if (!bus || typeof bus !== 'object') continue;
    const lat = Number(bus.latitude ?? bus.lat);
    const lng = Number(bus.longitude ?? bus.lng ?? bus.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const ageMin = fixAgeMinutes(bus.lasttime, nowMs);
    if (ageMin !== null && ageMin > FIX_AGE_MAX_MIN) continue;
    out.push({ lng, lat, destino: foldName(bus.destino_limpio), ageMin });
  }
  return out;
}

/**
 * The buses running THIS direction of the route.
 *
 * A route code is often both directions at once (every zonal, the rutas
 * fáciles), and a bus going the other way rides the same street: projected on
 * this direction's trace it looks "on route and approaching" while it is in fact
 * leaving. The feed names each bus's direction, and that name is the variant's.
 * Where no bus carries this variant's name, a feed that names ONE direction is
 * taken as already filtered (a troncal lookup is made by destination); one that
 * names several is not ours to guess between, and yields nothing.
 */
export function busesOfVariant(buses: LiveBusFix[], variantNames: string[]): LiveBusFix[] {
  const wanted = new Set(variantNames.map(foldName).filter(Boolean));
  const named = buses.filter((bus) => bus.destino);
  if (named.length === 0) return buses;
  const matched = buses.filter((bus) => wanted.has(bus.destino));
  if (matched.length > 0) return matched;
  return new Set(named.map((bus) => bus.destino)).size === 1 ? buses : [];
}

export interface ApproachInput {
  buses: LiveBusFix[];
  /** A point's metres along the ridden trace and its distance from it, or null. */
  project: (point: [number, number]) => { along: number; error: number } | null;
  /** The boarding stop's metres along the same trace. */
  stopAlong: number;
  /** Cruising speed for this route at this hour, metres per minute. */
  speedMpm: number;
}

/**
 * Minutes from now until each approaching bus reaches the stop, soonest first.
 * Remaining metres over the cruising speed, less the age of the position: a bus
 * seen 600 m out 45 s ago is not 600 m out any more.
 */
export function approachingEtas(input: ApproachInput): number[] {
  const etas: number[] = [];
  for (const bus of input.buses) {
    const at = input.project([bus.lng, bus.lat]);
    if (!at || at.error > ON_ROUTE_MAX_ERROR_M) continue;
    const remaining = input.stopAlong - at.along;
    if (remaining < -PASSED_STOP_EPSILON_M) continue;
    const eta = Math.max(0, remaining) / input.speedMpm - (bus.ageMin ?? FIX_AGE_DEFAULT_MIN);
    if (eta > LIVE_MAX_HORIZON_MIN) continue;
    etas.push(Math.max(0, eta));
  }
  return etas.sort((a, b) => a - b);
}

export type LiveBoardingStatus =
  /** The rider boards the next bus in sight. */
  | 'catch'
  /** A nearer bus is predicted at the stop before the rider; this is the one after. */
  | 'next'
  /** Every bus in sight is predicted at the stop before the rider. */
  | 'missed'
  /** No bus of this direction is in sight of the stop. Says nothing about the
   *  wait (see the header): the caller keeps its own assumption. */
  | 'none';

export interface LiveBoarding {
  status: LiveBoardingStatus;
  /** Minutes from now until the bus the rider boards is at the stop. */
  etaMin?: number;
  /** Minutes from now until the nearer bus the rider cannot reach is there. */
  missedEtaMin?: number;
  /** Minutes waited AT the stop for the boarded bus; null = no live figure, the
   *  caller keeps its own assumption. */
  waitMin: number | null;
  /** The rider is at the stop at least the margin before the boarded bus: a
   *  boarding to count on. False is "vas justo" — the bus is predicted after
   *  the rider arrives, but by less than the estimate is good for. */
  firm: boolean;
  /** The boarded bus is past the firm horizon: a guide, not a promise. */
  approx: boolean;
}

/** How long before a bus predicted `etaMin` out the rider must be at the stop,
 *  for a walk of `readyMin`. */
export function catchMargin(readyMin: number, etaMin: number): number {
  const forTheWalk = Math.min(CATCH_MARGIN_MIN, Math.max(CATCH_MARGIN_FLOOR_MIN, readyMin));
  return Math.max(forTheWalk, CATCH_MARGIN_ETA_SHARE * etaMin);
}

/**
 * Which bus the rider boards, given when they can be at the stop.
 *
 * `readyMin` is minutes from now until the rider reaches the stop (the walk
 * before the first ride). The rider boards the first bus predicted there no
 * earlier than they are — and that boarding is FIRM only when the bus is its
 * margin later still (`catchMargin`); inside the margin it is "vas justo".
 *
 * Three answers and not two, because the recordings say so. A bus inside the
 * margin was first treated as lost ("no alcanzas"): replayed, the rider would
 * have made 73–94 % of those, at every hour measured. So it is boarded, and
 * said to be tight. Only a bus predicted BEFORE the rider is there is passed
 * over — and it is reported, because "it passes in one minute, before you get
 * there" is exactly what a rider wants to know before running for it. (Even
 * that is not certain: buses run late at peak, and 25–59 % of those were still
 * at the stop when the rider would have arrived. Hence the wording.)
 */
export function chooseBoarding(etas: number[], readyMin: number): LiveBoarding {
  if (etas.length === 0) return { status: 'none', waitMin: null, firm: false, approx: false };
  const gone = etas.find((eta) => eta < readyMin);
  const boarded = etas.find((eta) => eta >= readyMin);
  if (boarded === undefined) {
    return { status: 'missed', missedEtaMin: gone, waitMin: null, firm: false, approx: true };
  }
  return {
    status: gone === undefined ? 'catch' : 'next',
    etaMin: boarded,
    ...(gone === undefined ? {} : { missedEtaMin: gone }),
    waitMin: boarded - readyMin,
    firm: boarded - catchMargin(readyMin, boarded) >= readyMin,
    approx: boarded > LIVE_FIRM_HORIZON_MIN,
  };
}
