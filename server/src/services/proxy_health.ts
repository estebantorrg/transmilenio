/**
 * Judging a free CO proxy, kept apart from the pool itself (`proxy_manager.ts`
 * builds its singleton — and starts scraping — on import, so these must be
 * importable without that).
 *
 * Both exist to keep upstream request volume down (spec §5.2.3): `isProvenProxy`
 * lets a live request go through one proxy that has been answering instead of
 * racing a whole wave, and `shouldRefreshPool` keeps the scheduled re-scrape —
 * one live-host request per candidate — from running when nothing needs it.
 */

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

/**
 * Whether the periodic re-scrape should run at all.
 *
 * Verification spends one live-host request per candidate, so re-probing a
 * healthy pool every 10 minutes was the largest single source of this
 * project's upstream traffic. A pool at target is left alone; proxies that
 * stop working are evicted on failure, which drops the size below target and
 * lets the next tick (or the top-up timer) refill it.
 */
export function shouldRefreshPool(poolSize: number, targetSize: number): boolean {
  return poolSize < targetSize;
}
