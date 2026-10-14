/**
 * Operational notices TransMilenio posts on X as `#TMAhora` (spec §5.5.9).
 *
 * The source is the account's public profile page, read without logging in:
 * the page embeds the account's five newest posts in its server-rendered data.
 * TransMilenio posts a few an hour, so a read every three minutes misses
 * nothing short of a burst of more than five, and a missed one only costs a
 * line in a feed. There is no API in the path, so the page's shape is the
 * contract — `extractPosts` is written against it and tested on a copy of it,
 * and `status` says when it stops matching rather than serving an empty list
 * as if the system were quiet.
 *
 * shortcut: scraping the page, not X's paid API — breaks when X changes the page
 * or blocks this server; move to the API (or TransMilenio's GTFS-RT service
 * alerts, promised for December 2026) when it does.
 */

const PROFILE_URL = 'https://x.com/TransMilenio';
const POLL_MS = 3 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const KEEP_MS = 24 * 3_600_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export interface Novedad {
  /** The post's id on X. */
  id: string;
  /** When it was posted (epoch ms). */
  at: number;
  /** The post as written — its emoji lines are already the layout. */
  text: string;
  url: string;
}

export interface NovedadesStatus {
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  /** Why the last read failed: an HTTP status, a timeout, or a page with no posts in it. */
  lastError: string | null;
}

const store = new Map<string, Novedad>();
const status: NovedadesStatus = { lastAttemptAt: null, lastOkAt: null, lastError: null };
let polling = false;

/** A string literal as the page serialises it (JSON escapes, plus `\xNN`). */
function unescapeLiteral(raw: string): string | null {
  try {
    return JSON.parse(`"${raw.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')}"`);
  } catch {
    return null;
  }
}

/**
 * The `#TMAhora` posts embedded in the profile page, newest first.
 *
 * Every post's data opens with `details:` (time, text) and goes on to its id
 * and, for a post over 280 characters, the full text as a "note" — `full_text`
 * stops at the cut. A retweet is someone else's post and is left out.
 */
export function extractPosts(html: string): Novedad[] {
  const posts: Novedad[] = [];
  for (const chunk of html.split('details:$R[').slice(1)) {
    const at = Number(chunk.match(/created_at_ms:(\d+)/)?.[1]);
    const id = chunk.match(/edit_tweet_ids:\$R\[\d+\]=\["(\d+)"/)?.[1];
    const note = chunk.match(/note_tweet_results:[\s\S]*?rest_id:"\d+",text:"((?:[^"\\]|\\.)*)"/)?.[1];
    const short = chunk.match(/full_text:"((?:[^"\\]|\\.)*)"/)?.[1];
    const text = unescapeLiteral(note ?? short ?? '');
    if (!id || !Number.isFinite(at) || !text) continue;
    if (text.startsWith('RT @') || !/#TMAhora\b/i.test(text)) continue;
    posts.push({ id, at, text: text.trim(), url: `${PROFILE_URL}/status/${id}` });
  }
  return posts.sort((a, b) => b.at - a.at);
}

/** One read of the profile page into the store. Never throws. */
export async function pollNovedades(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<void> {
  status.lastAttemptAt = now;
  try {
    const res = await fetchImpl(PROFILE_URL, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'es-CO,es;q=0.9' },
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
