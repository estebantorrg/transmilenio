/**
 * Operational notices TransMilenio posts on X as `#TMAhora` (spec §5.5.9) —
 * the server's reader, which the website asks (`GET /api/novedades`).
 *
 * The source is the account's public profile page, read without logging in:
 * the page embeds the account's five newest posts in its server-rendered data.
 * TransMilenio posts a few an hour, so a read every three minutes misses
 * nothing short of a burst of more than five, and a missed one only costs a
 * line in a feed. How a post is read off the page is `shared/novedades.js`,
 * which the app uses to read the same page itself; `status` says when the page
 * stops matching rather than serving an empty list as if the system were quiet.
 */

import { KEEP_MS, PROFILE_HEADERS, PROFILE_URL, extractPosts, type Novedad } from '../../../shared/novedades.js';

export type { Novedad };

const POLL_MS = 3 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface NovedadesStatus {
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  /** Why the last read failed: an HTTP status, a timeout, or a page with no posts in it. */
  lastError: string | null;
}

const store = new Map<string, Novedad>();
const status: NovedadesStatus = { lastAttemptAt: null, lastOkAt: null, lastError: null };
let polling = false;

/** One read of the profile page into the store. Never throws. */
export async function pollNovedades(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<void> {
  status.lastAttemptAt = now;
  try {
    const res = await fetchImpl(PROFILE_URL, {
      headers: PROFILE_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const posts = extractPosts(await res.text());
    // The page always carries the latest posts, and the latest are always
    // #TMAhora on a working day — none at all means the page changed shape (or
    // a login wall came back), not that the city is quiet.
    if (posts.length === 0) throw new Error('no #TMAhora posts in the page');
    for (const post of posts) store.set(post.id, post);
    status.lastOkAt = now;
    status.lastError = null;
  } catch (error) {
    status.lastError = String((error as Error)?.message ?? error).slice(0, 200);
    console.warn(`[Novedades] read failed: ${status.lastError}`);
  }
  for (const [id, post] of store) if (now - post.at > KEEP_MS) store.delete(id);
}

/** The last day's notices, newest first, and how the source is doing. */
export function getNovedades(): { items: Novedad[]; status: NovedadesStatus } {
  return { items: [...store.values()].sort((a, b) => b.at - a.at), status: { ...status } };
}

/** Reads now and every three minutes; one read at a time. */
export function startNovedadesPoller(): void {
  const tick = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      await pollNovedades();
    } finally {
      polling = false;
    }
  };
  void tick();
  setInterval(() => void tick(), POLL_MS).unref();
}
