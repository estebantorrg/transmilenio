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

/** Per-device memory of the newest post the rider has seen (its `at`). */
export const SEEN_STORAGE_KEY = 'tm.novedades.seenAt';

/**
 * The post to put up front, or null. TransMilenio posts #TMAhora most hours of
 * the day, so "recent" alone kept the banner up all day long; it is shown like an
 * unread notice instead — only for a post newer than the last one the rider saw
 * (opened the list, or closed the banner on).
 */
export function bannerPost(items, seenAt = 0, now = Date.now()) {
  const newest = items?.[0];
  if (!newest || now - newest.at > BANNER_MAX_AGE_MS || newest.at <= seenAt) return null;
  return newest;
}

/** A string literal as the page serialises it (JSON escapes, plus `\xNN`). */
function unescapeLiteral(raw) {
  try {
    return JSON.parse(`"${raw.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')}"`);
  } catch {
    return null;
  }
}

/**
 * The `#TMAhora` posts embedded in the profile page, newest first, and how many
 * posts of any kind it carried (`seen`). None at all means the page changed
 * shape or a login wall came back; posts with no #TMAhora among them are only a
 * quiet stretch — the account posts other things too, and on a calm weekend its
 * five newest can all be those.
 *
 * The page carries the timeline as a GraphQL answer serialised into a string
 * (`result:…={kind:"Result.Ok",value:"{\"data\":…}"}`). Every post in it is an
 * object with `details` (time, text), its id in `edit_control` and, for a post
 * over 280 characters, the full text as a "note" — `full_text` stops at the
 * cut. A retweet is someone else's post and is left out.
 *
 * @param {string} html
 * @returns {{ posts: Array<{ id: string, at: number, text: string, url: string }>, seen: number }}
 */
export function readTimeline(html) {
  const posts = new Map();
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const at = node.details?.created_at_ms;
    const id = node.edit_control?.edit_tweet_ids?.[0] ?? node.rest_id;
    const text = node.note_tweet?.note_tweet_results?.result?.text ?? node.details?.full_text;
    if (Number.isFinite(at) && typeof id === 'string' && typeof text === 'string') {
      seen.add(id);
      if (!text.startsWith('RT @') && /#TMAhora\b/i.test(text)) {
        posts.set(id, { id, at, text: text.trim(), url: `${PROFILE_URL}/status/${id}` });
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  for (const [, raw] of String(html).matchAll(/value:"((?:[^"\\]|\\.)*)"/g)) {
    try {
      visit(JSON.parse(unescapeLiteral(raw) ?? ''));
    } catch {
      // Not every `value:` string is JSON; the timeline is the one that is.
    }
  }
  return { posts: [...posts.values()].sort((a, b) => b.at - a.at), seen: seen.size };
}

/** Just the `#TMAhora` posts of {@link readTimeline}. */
export function extractPosts(html) {
  return readTimeline(html).posts;
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
