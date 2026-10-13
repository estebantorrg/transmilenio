/**
 * Which destination name last returned buses for a route (spec §5.2.4).
 *
 * A troncal live request only matches when `Nombre` is the API's own
 * destination string, and the catalog can offer several candidates — so a
 * lookup fires them in parallel and keeps the first non-empty answer. That is
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
 * One implementation for the server cascade (keyed `<type>:<código>`) and the
 * app's native lookup (keyed by código). Session-scoped on purpose: a restart
 * simply re-learns the name on the first poll.
 */

const MEMO_TTL_MS = 10 * 60 * 1000;
const MEMO_MAX = 400; // bounded like the live cache: a TTL only frees on read

const memo = new Map();

const keyOf = (key) => String(key).trim().toUpperCase();

/** The remembered name, and whether an empty answer from it can still be trusted. */
export function recallLiveName(key, now = Date.now()) {
  const entry = memo.get(keyOf(key));
  if (!entry) return null;
  return { name: entry.name, fresh: now - entry.at < MEMO_TTL_MS };
}

export function rememberLiveName(key, name) {
  const k = keyOf(key);
  if (!k || !name) return;
  memo.delete(k); // re-insert so the map stays in insertion order
  memo.set(k, { name, at: Date.now() });
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

export function forgetLiveName(key) {
  memo.delete(keyOf(key));
}
