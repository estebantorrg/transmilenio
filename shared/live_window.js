/**
 * When the official live host answers at all (spec §5.2.2a): outside roughly
 * 05:00–23:00 Bogotá it returns `400 Service Not Available` to every client.
 *
 * One definition for the two sides that need it: the app explains an empty
 * result with it (`client/src/services/liveWindow.ts`), and the server's proxy
 * pool verifies proxies against that host, so it has nothing to verify while
 * the host is shut (`server/src/services/proxy_health.ts`).
 */

export const LIVE_WINDOW_START_MINUTE = 5 * 60; // 05:00
export const LIVE_WINDOW_END_MINUTE = 23 * 60; // 23:00

/** Bogotá is UTC−5 all year (no DST), so the offset is a constant, not a lookup. */
export function liveWindowOpenAt(epochMs) {
  const local = new Date(epochMs - 5 * 60 * 60 * 1000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minute >= LIVE_WINDOW_START_MINUTE && minute < LIVE_WINDOW_END_MINUTE;
}
