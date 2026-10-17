/**
 * The Bogotá wall clock, for every surface that needs "what time and day is it
 * there": the planner's schedules (`client/src/services/schedule.ts`), the live
 * host's service window (`shared/live_window.js`) and the arrivals board's bus
 * speed (`server/src/services/stop_arrivals.ts`). Three copies of it agreed;
 * one is less to keep agreeing.
 *
 * Colombia keeps UTC−5 all year, with no daylight saving, so a fixed offset is
 * the whole timezone: no tz database and no `Intl`, and the same answer on a
 * phone set to another zone or a server in Oregon.
 *
 * `shared/avisos.js` keeps its own copy of the offset on purpose: it is loaded
 * by the ESM-side specs and this module by the CommonJS side, and a module
 * reached from both aborts the whole Playwright run.
 */

const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000;

/** Bogotá's date, weekday (0 = Sunday) and minute of the day at `epochMs`. */
export function bogotaClock(epochMs = Date.now()) {
  const local = new Date(epochMs + BOGOTA_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    weekday: local.getUTCDay(),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}
