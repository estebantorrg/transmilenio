/**
 * Which destination name last returned buses for a troncal route (spec §5.2.4).
 *
 * A troncal live request only matches when `Nombre` is the API's own
 * destination, and the catalog can offer several candidates — so the native app
 * fires them in parallel and keeps the first non-empty answer. That is the right
 * shape for the *first* fix and wasteful for every poll after it: only one name
 * can match, and it does not change between polls. Remembering it turns a poll
 * into one upstream request instead of up to a dozen, which matters on a host
 * that has already blocklisted an id over volume (spec §5.2.3).
 *
 * Session-scoped on purpose: nothing here is worth persisting, and a restart
 * simply re-learns the name on the first poll. The server keeps the same memo
 * for the website's tiers (`recallLiveName` in `server/src/services/tm_api.ts`).
 */

const MEMO_TTL_MS = 10 * 60 * 1000;
const MEMO_MAX = 200;

const memo = new Map<string, { name: string; at: number }>();

const keyOf = (routeCode: string) => routeCode.trim().toUpperCase();

/** The remembered name, and whether an empty answer from it can still be trusted. */
export function recallLiveName(routeCode: string, now = Date.now()): { name: string; fresh: boolean } | null {
  const entry = memo.get(keyOf(routeCode));
  if (!entry) return null;
  return { name: entry.name, fresh: now - entry.at < MEMO_TTL_MS };
}

export function rememberLiveName(routeCode: string, name: string): void {
  const key = keyOf(routeCode);
  if (!key || !name) return;
  memo.delete(key); // re-insert to keep the map in insertion order
  memo.set(key, { name, at: Date.now() });
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

export function forgetLiveName(routeCode: string): void {
  memo.delete(keyOf(routeCode));
}
