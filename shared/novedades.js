/**
 * TransMilenio's `#TMAhora` posts, read off its public X profile page (spec
 * §5.5.9) — the reading and the wording, in one place for the three readers:
 * the server's poller (`server/src/services/novedades.ts`, which the website
 * asks), and the app, which reads the page itself because it talks to no
 * server of ours (§5.2.1b).
 *
 * shortcut: scraping the page, not X's paid API — breaks when X changes the
 * page; move to the API, or to TransMilenio's GTFS-RT service alerts (promised
 * for December 2026), when it does.
 */

export const PROFILE_URL = 'https://x.com/TransMilenio';

/** Asked for as a browser would; the page embeds the newest posts for one. */
export const PROFILE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  'Accept-Language': 'es-CO,es;q=0.9',
};

/** How long a notice is kept, and how recent the newest must be to be put up front. */
export const KEEP_MS = 24 * 3_600_000;
export const BANNER_MAX_AGE_MS = 3 * 3_600_000;

/** A string literal as the page serialises it (JSON escapes, plus `\xNN`). */
function unescapeLiteral(raw) {
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
 *
 * @param {string} html
 * @returns {Array<{ id: string, at: number, text: string, url: string }>}
 */
export function extractPosts(html) {
  const posts = [];
  for (const chunk of String(html).split('details:$R[').slice(1)) {
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

/** The post as written, minus the `t.co` links to its own photos (the X link
 *  covers those) and its blank lines — on a phone they doubled every card. */
export function postText(text) {
  return String(text).replace(/\s*https:\/\/t\.co\/\S+/g, '').replace(/\n{2,}/g, '\n').trim();
}

/** The line that says what happened: the first one after the `⏰ #TMAhora (…)` stamp. */
export function headline(text) {
  const lines = postText(text).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !/#TMAhora/i.test(l)) ?? lines[0] ?? '';
}

/** "hace 12 min" / "hace 2 h". */
export function ago(at, now = Date.now()) {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.floor(min / 60)} h`;
}

/** "12:11 p. m.", Bogotá time. */
export function clock(at) {
  return new Date(at).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
}
