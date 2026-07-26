/**
 * The live-tracking service window.
 *
 * Spec §5.2.2a, verified in-country: outside roughly 05:00–23:00 Bogotá the
 * official live host answers `400 {"detail":"Service Not Available"}` to ANY
 * Colombian client — the feed is closed, not empty. Both clients used to render
 * that as "Sin buses ahora", which is a claim we cannot make: it tells a rider
 * at 02:00 that their route has no buses running when what actually happened is
 * that the upstream is shut for the night (spec §1 Certainty).
 *
 * A handful of night routes do run, so this is presented as an explanation of an
 * empty result, never as a reason to skip asking.
 */

import { bogotaNow, formatClockMinute, type PlanTime } from './schedule';

/** First/last minute of the day the live feed is known to answer. */
export const LIVE_WINDOW_START_MINUTE = 5 * 60; // 05:00
export const LIVE_WINDOW_END_MINUTE = 23 * 60; // 23:00

export function isLiveWindowOpen(now: PlanTime = bogotaNow()): boolean {
  return now.minute >= LIVE_WINDOW_START_MINUTE && now.minute < LIVE_WINDOW_END_MINUTE;
}

/** Human window, e.g. "5:00 a.m. a 11:00 p.m.". */
export function liveWindowLabel(): string {
  return `${formatClockMinute(LIVE_WINDOW_START_MINUTE)} a ${formatClockMinute(LIVE_WINDOW_END_MINUTE)}`;
}

/**
 * How to describe an empty live result *right now*: closed upstream, or a
 * genuine absence of buses on that route. `null` when the window is open, so the
 * caller keeps its normal wording.
 */
export function closedWindowNotice(now: PlanTime = bogotaNow()): { short: string; detail: string } | null {
  if (isLiveWindowOpen(now)) return null;
  return {
    short: 'Servicio cerrado',
    detail: `El rastreo en vivo opera de ${liveWindowLabel()}. Algunas rutas nocturnas siguen circulando.`,
  };
}
