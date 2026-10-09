/**
 * Server-side flow control (spec §3.4).
 *
 * Every endpoint that turns a request into a call to somebody else's host —
 * the live host, the card host, the geocoders, the pedestrian router — used to
 * do so once per request, for anyone, without limit. The live host has already
 * blocklisted an install id over volume (spec §5.2.3), so the two things that
 * bound it live here: riders asking the same question share one answer, and one
 * client cannot ask more than a person could.
 *
 * Its own module, free of `import.meta`, so the Playwright runner can load it
 * (`tests/flow-control.spec.ts`) — `tm_api.ts` and `routes/api.ts` cannot be.
 */

/**
 * One result per `key` for every caller that asks while it is in flight and for
 * `ttlMs` after it settles. A rejection is never kept: the next caller retries.
 * Bounded like every other cache here — a TTL is only consulted on read, so
 * without the cap a key nobody asks for again is never freed (spec §5.1.3).
 */
export function createSharedWindow<T>(ttlMs: number, maxEntries: number) {
  const entries = new Map<string, { value: Promise<T>; settledAt: number | null }>();

  return (key: string, run: () => Promise<T>, now: () => number = Date.now): Promise<T> => {
    const hit = entries.get(key);
    if (hit && (hit.settledAt === null || now() - hit.settledAt < ttlMs)) return hit.value;

    const entry = { value: run(), settledAt: null as number | null };
    entries.delete(key); // re-insert so the map stays in insertion order
    entries.set(key, entry);
    entry.value.then(
      () => { entry.settledAt = now(); },
      () => { if (entries.get(key) === entry) entries.delete(key); }
    );
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return entry.value;
  };
}

/**
 * Who a request counts against. An IPv4 address is one client; an IPv6 client
 * owns its whole /64 and can take a new address from it per request, so the
 * prefix is the client. `::ffff:a.b.c.d` is the IPv4 address it wraps.
 */
export function clientKey(ip: string): string {
  const address = String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (!address.includes(':')) return address;

  const [head, tail] = address.split('::');
  const groups = head.split(':').filter(Boolean);
  if (tail !== undefined) {
    const rest = tail.split(':').filter(Boolean);
    while (groups.length + rest.length < 8) groups.push('0');
    groups.push(...rest);
  }
  return groups.slice(0, 4).join(':');
}

/**
 * Counts requests per key in one shared fixed window. `allow` answers whether
 * this request fits the key's budget of `max` per window.
 *
 * The whole table is dropped when the window turns, so it holds at most one
 * window of keys and needs no timer; `maxKeys` caps it inside a window, and a
 * key that does not fit is refused rather than let through uncounted.
 *
 * shortcut: fixed window, so a caller can spend two budgets back to back across
 * a boundary; make it a sliding window if a budget ever has to be exact.
 */
export function createRateLimiter(windowMs: number, maxKeys = 20_000) {
  const hits = new Map<string, number>();
  let windowStart = 0;

  return {
    allow(key: string, max: number, now = Date.now()): boolean {
      if (now - windowStart >= windowMs) {
        hits.clear();
        windowStart = now;
      }
      const count = hits.get(key) ?? 0;
      if (count >= max || (count === 0 && hits.size >= maxKeys)) return false;
      hits.set(key, count + 1);
      return true;
    },
    /** Whole seconds until the window turns — the `Retry-After` of a refusal. */
    retryAfterSeconds(now = Date.now()): number {
      return Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    },
    /** Keys counted in the current window (`/api/health`). */
    size(): number {
      return hits.size;
    },
  };
}
