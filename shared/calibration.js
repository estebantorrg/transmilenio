/**
 * Reading TRANSMILENIO's measured speeds (spec §5.6.5), shared by everything
 * that turns metres into minutes: the planner's graph (`services/router.ts`),
 * the voice ETA (`services/routeEta.ts`) and the server's arrivals board
 * (`services/stop_arrivals.ts`). Those three used to hold their own cruising
 * constants with a comment asking future editors to keep them in step; the
 * measurement is one dataset, so the reading of it is one module.
 *
 * The data is `server/src/data/planner_calibration.json`, built offline by
 * `scripts/calibration/build.mjs`. Pure functions over a prepared form: no
 * state, no I/O — each consumer holds its own prepared copy.
 */

/** Nothing on the street may be charged faster than the troncal cruise (34 km/h). */
export const SPEED_CAP_M_PER_MIN = 570;
/** Below this a stretch's median is a GPS artefact, not a bus (4 km/h). */
export const SPEED_FLOOR_M_PER_MIN = 67;

/** `H` hábil, `S` sábado, `F` domingo/festivo. */
export const DAY_TYPES = ['H', 'S', 'F'];

const HOURS = 24;

function hourTable(hours) {
  const table = new Float64Array(HOURS);
  for (let h = 0; h < HOURS; h++) table[h] = Number(hours?.[h]) || 0;
  return table;
}

/**
 * Turns the shipped JSON into lookup form. Tolerates a missing or malformed
 * field everywhere: an absent multiplier is the neutral 1, an absent stretch
 * simply has no measurement and the caller keeps its own constant.
 */
export function prepareCalibration(data) {
  if (!data) return null;
  const factor = {};
  for (const dayType of DAY_TYPES) {
    const table = hourTable(data.speeds?.factor?.[dayType]);
    for (let h = 0; h < HOURS; h++) if (!(table[h] > 0)) table[h] = 1;
    factor[dayType] = table;
  }

  const pairSpeed = new Map();
  for (const [from, next] of Object.entries(data.speeds?.pairs ?? {})) {
    for (const [to, kmh] of Object.entries(next ?? {})) {
      if (kmh > 0) pairSpeed.set(`${from}>${to}`, (Number(kmh) * 1000) / 60);
    }
  }

  const headways = new Map();
  for (const [code, byDay] of Object.entries(data.headways ?? {})) {
    headways.set(code, { H: hourTable(byDay?.H), S: hourTable(byDay?.S), F: hourTable(byDay?.F) });
  }

  return { factor, pairSpeed, headways };
}

/** `H`/`S`/`F` for a date. Sunday and festivos share one programme. */
export function dayTypeFor(weekday, festivo) {
  if (festivo || weekday === 0) return 'F';
  if (weekday === 6) return 'S';
  return 'H';
}

/** The citywide multiplier on a stretch's base speed at that day type and hour. */
export function hourFactor(prepared, dayType, hour) {
  const table = prepared?.factor?.[dayType];
  const value = table ? table[((hour % HOURS) + HOURS) % HOURS] : 1;
  return value > 0 ? value : 1;
}

export function clampSpeedMpm(mpm) {
  return Math.min(SPEED_CAP_M_PER_MIN, Math.max(SPEED_FLOOR_M_PER_MIN, mpm));
}

/** Measured base speed (m/min) of one stretch between consecutive stops, or null. */
export function pairSpeedMpm(prepared, fromCode, toCode) {
  if (!prepared || !fromCode || !toCode) return null;
  const speed = prepared.pairSpeed.get(`${fromCode}>${toCode}`);
  return speed === undefined ? null : clampSpeedMpm(speed);
}

/**
 * One speed for a whole ride: the median of the measured stretches along an
 * ordered stop list, or null when none of them was measured.
 *
 * The median, not the mean: a single stretch whose GPS median is an outlier
 * should not drag a whole route's ETA, and half the file's stretches carry
 * fewer than a handful of vehicles in some hours. Used where the consumer has a
 * distance along the trace rather than a stop-by-stop breakdown — the voice ETA
 * and the arrivals board both project a bus onto the line and ask how long the
 * remaining metres take.
 */
export function medianPairSpeedMpm(prepared, stopCodes) {
  if (!prepared || !Array.isArray(stopCodes) || stopCodes.length < 2) return null;
  const speeds = [];
  for (let i = 0; i < stopCodes.length - 1; i++) {
    const speed = pairSpeedMpm(prepared, stopCodes[i], stopCodes[i + 1]);
    if (speed !== null) speeds.push(speed);
  }
  if (speeds.length === 0) return null;
  speeds.sort((a, b) => a - b);
  const mid = speeds.length >> 1;
  return speeds.length % 2 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2;
}

/**
 * The speed (m/min) to charge a ride at: the measured stretches where they
 * exist, else the caller's own constant — scaled either way by the hour, which
 * is the honest half of the answer we have even for an unmeasured stretch.
 */
export function rideSpeedMpm(prepared, stopCodes, dayType, hour, fallbackMpm) {
  const base = medianPairSpeedMpm(prepared, stopCodes) ?? fallbackMpm;
  return clampSpeedMpm(base * hourFactor(prepared, dayType, hour));
}
