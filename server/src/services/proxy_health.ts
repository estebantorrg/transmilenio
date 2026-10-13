/**
 * Judging a free CO proxy, kept apart from the pool itself (`proxy_manager.ts`
 * builds its singleton — and starts scraping — on import, so these must be
 * importable without that).
 *
 * All of it exists to keep upstream request volume down (spec §5.2.3):
 * `isProvenProxy` lets a live request go through one proxy that has been
 * answering instead of racing a whole wave, and `shouldRefreshPool` /
 * `canRefreshPool` keep a verification pass — one live-host request per
 * candidate — from running when it buys nothing.
 */

import { liveWindowOpenAt } from '../../../shared/live_window.js';

/** A proxy answered this recently, and this much of its record is successes. */
export const PROVEN_PROXY_MAX_AGE_MS = 5 * 60 * 1000;
export const PROVEN_PROXY_MIN_RATE = 0.6;

export interface ProxyRecord {
  success: number;
  failure: number;
  lastOkAt: number;
}

/**
 * Whether a lone request may be sent through this proxy. Deliberately strict —
 * a wrong guess costs the caller a retry, so it wants a recent success *and* a
 * record that is mostly successes.
 */
export function isProvenProxy(record: ProxyRecord, now = Date.now()): boolean {
  const total = record.success + record.failure;
  if (record.success <= 0 || total <= 0) return false;
  if (now - record.lastOkAt >= PROVEN_PROXY_MAX_AGE_MS) return false;
  return record.success / total >= PROVEN_PROXY_MIN_RATE;
}

/** A pool nobody has asked for a proxy in this long has no rider to serve. */
export const POOL_IDLE_MS = 10 * 60 * 1000;
/** The least time between the end of one verification pass and the next. */
export const REFRESH_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * Whether the periodic re-scrape should run at all.
 *
 * Verification spends one live-host request per candidate, so re-probing a
 * healthy pool every 10 minutes was the largest single source of this
 * project's upstream traffic. A pool at target is left alone; proxies that
 * stop working are evicted on failure, which drops the size below target and
 * lets the next tick refill it.
 *
 * So is a pool nobody is using. A free pool usually sits *below* target, and a
 * 90-second top-up timer answered that by re-probing the whole candidate list
 * back to back for as long as the process lived — measured in production on
 * 2026-10-13 at 00:20 Bogotá: no proxy, no rider, and a pass in flight in 11 of
 * 12 samples over four minutes.
 */
export function shouldRefreshPool(poolSize: number, targetSize: number, lastUsedAt: number, now = Date.now()): boolean {
  return poolSize < targetSize && now - lastUsedAt < POOL_IDLE_MS;
}

/**
 * Whether a verification pass may start now, whoever asks for it.
 *
 * Outside its service window the live host answers `400` to everyone (spec
 * §5.2.2a), so no proxy can pass and a pass can only spend requests. And a pass
 * that has just ended is not repeated at once: with the pool empty every live
 * request asks for one, which is the same back-to-back probing by another road.
 */
export function canRefreshPool(lastRefreshAt: number, now = Date.now()): boolean {
  return liveWindowOpenAt(now) && now - lastRefreshAt >= REFRESH_COOLDOWN_MS;
}
