/**
 * When the official live host answers at all (spec §5.2.2a): outside roughly
 * 05:00–23:00 Bogotá it returns `400 Service Not Available` to every client.
 *
 * One definition for the two sides that need it: the app explains an empty
 * result with it (`client/src/services/liveWindow.ts`), and the server's proxy
 * pool verifies proxies against that host, so it has nothing to verify while
 * the host is shut (`server/src/services/proxy_health.ts`).
 */

import { bogotaClock } from './bogota_clock.js';

export const LIVE_WINDOW_START_MINUTE = 5 * 60; // 05:00
export const LIVE_WINDOW_END_MINUTE = 23 * 60; // 23:00

export function liveWindowOpenAt(epochMs) {
  const { minute } = bogotaClock(epochMs);
  return minute >= LIVE_WINDOW_START_MINUTE && minute < LIVE_WINDOW_END_MINUTE;
}
