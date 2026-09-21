/**
 * Judging a free CO proxy, kept apart from the pool itself (`proxy_manager.ts`
 * builds its singleton — and starts scraping — on import, so these must be
 * importable without that).
 *
 * Both halves exist to keep upstream request volume down (spec §5.2.3):
 * `parseTraceCountry` lets verification establish the exit country against a
 * neutral endpoint instead of spending a live-host request on every one of
 * hundreds of scraped candidates, and `isProvenProxy` lets a live request go
 * through one proxy that has been answering instead of racing a whole wave.
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

/** `loc=CO` out of a Cloudflare trace body (`key=value` lines). Upper-cased; null if absent. */
export function parseTraceCountry(body: string): string | null {
  const match = /^loc=([A-Za-z]{2})$/m.exec(String(body ?? '').replace(/\r/g, ''));
  return match ? match[1].toUpperCase() : null;
}
