/**
 * Which destination name last returned buses for a route (spec §5.2.4).
 *
 * A troncal live request only matches when `Nombre` is the API's own
 * destination string, and the catalog can offer several candidates — so the
 * cascade fires them in parallel and keeps the first non-empty answer. That is
 * right for the *first* fix and wasteful for every poll after it: only one name
 * can match, and it does not change between polls, so a tracking session was
 * re-asking the live host the same dead questions every 15 s. Remembering the
 * winner turns a poll into one upstream request instead of up to twelve, on a
 * host that has already blocklisted an id over volume (spec §5.2.3).
 *
 * `fresh` is the interesting half: while the memo is fresh an *empty* answer
 * from the remembered name is the route's real answer (no buses right now);
 * once it is stale the name itself is the suspect again, so the caller re-asks
 * every candidate.
 *
 * Its own module so a test can import it — `tm_api.ts` uses `import.meta` and
 * cannot be loaded by the Playwright runner. `client/src/services/liveNameMemo.ts`
 * is the app-side twin, and `extension/background.js` mirrors it.
 */

const MEMO_TTL_MS = 10 * 60 * 1000;
const MEMO_MAX = 400; // bounded like the live cache: a TTL only frees on read

const memo = new Map<string, { name: string; at: number }>();

function keyOf(routeType: 'troncal' | 'zonal', routeCode: string): string {
  return `${routeType}:${routeCode.trim().toUpperCase()}`;
}

export function recallLiveName(
  routeType: 'troncal' | 'zonal',
  routeCode: string,
  now = Date.now()
): { name: string; fresh: boolean } | null {
  const entry = memo.get(keyOf(routeType, routeCode));
  if (!entry) return null;
  return { name: entry.name, fresh: now - entry.at < MEMO_TTL_MS };
}

export function rememberLiveName(routeType: 'troncal' | 'zonal', routeCode: string, name: string): void {
  const key = keyOf(routeType, routeCode);
  if (!name || key.endsWith(':')) return;
  memo.delete(key); // re-insert so the map stays in insertion order
  memo.set(key, { name, at: Date.now() });
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

export function forgetLiveName(routeType: 'troncal' | 'zonal', routeCode: string): void {
  memo.delete(keyOf(routeType, routeCode));
}
