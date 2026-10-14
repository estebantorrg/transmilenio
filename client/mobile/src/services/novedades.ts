/**
 * TransMilenio's `#TMAhora` posts for the app (spec §5.5.9).
 *
 * The app talks to no server of ours (§5.2.1b), so it does not ask the
 * website's `/api/novedades`: it reads `x.com/TransMilenio` itself, over native
 * HTTP from the phone's own connection, with the reader the server uses
 * (`shared/novedades.js`). Each read is one page; the posts seen this session
 * are kept for a day, so a read that fails leaves the last good list in place.
 */

import { isNativeLiveAvailable, nativeHttpRequest } from '@shared/services/nativeLive';
import { KEEP_MS, PROFILE_HEADERS, PROFILE_URL, extractPosts, type Novedad } from '../../../../shared/novedades.js';

export type { Novedad };

const MIN_INTERVAL_MS = 3 * 60_000;
const TIMEOUT_MS = 15_000;

const store = new Map<string, Novedad>();
let lastAttemptAt = 0;
let inFlight: Promise<Novedad[]> | null = null;

function current(now: number): Novedad[] {
  for (const [id, post] of store) if (now - post.at > KEEP_MS) store.delete(id);
  return [...store.values()].sort((a, b) => b.at - a.at);
}

/**
 * The last day's posts, newest first. Reads the page again only when the last
 * read is over three minutes old — the screen asks every time it is shown.
 */
export function refreshNovedades(now = Date.now()): Promise<Novedad[]> {
  if (inFlight) return inFlight;
  if (!isNativeLiveAvailable() || now - lastAttemptAt < MIN_INTERVAL_MS) return Promise.resolve(current(now));
  lastAttemptAt = now;
  inFlight = nativeHttpRequest({ method: 'GET', url: PROFILE_URL, headers: PROFILE_HEADERS, timeoutMs: TIMEOUT_MS })
    .then((res) => {
      if (res.status >= 400 || typeof res.data !== 'string') throw new Error(`HTTP ${res.status}`);
      for (const post of extractPosts(res.data)) store.set(post.id, post);
    })
    .catch((error) => console.warn('[Novedades] read failed:', error))
    .then(() => current(Date.now()))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
