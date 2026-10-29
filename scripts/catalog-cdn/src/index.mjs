// Serves the website's route catalog from Cloudflare's edge (spec §5.1.4).
//
// Every first visit to mitrasto.app downloads the catalog, 2.5 MB gzip, and
// Render's free plan allows 5 GB of traffic a month — with no card on file, going
// over suspends the whole site until the month ends. A post that sends a few
// thousand people at once would do exactly that. From here, Render serves the
// catalog once per version and Cloudflare serves everyone else.
//
// The bytes are never decoded: the origin hands them over as a file
// (`/api/troncal/master-catalog.gz`), they are stored as they come in KV (one key
// per ETag), and they go out with `Content-Encoding: gzip`. Inflating 15 MB in a
// Worker would not fit the free plan's 10 ms of CPU.
//
// Freshness: each isolate asks the origin at most once a minute whether the
// catalog changed (a conditional request, a few hundred bytes when it did not).
// Anything that goes wrong answers 503, and the site falls back to its own API.

const ORIGIN = 'https://mitrasto.app/api/troncal/master-catalog.gz';
const RECHECK_MS = 60_000;

let memo = null; // { etag, checkedAt }, per isolate

/** Forget the per-isolate memo (tests). */
export function resetMemo() {
  memo = null;
}

/** The current catalog's ETag, refreshing the stored copy when the origin has a new one. */
export async function currentEtag(env, now, fetchImpl = fetch) {
  if (memo && now - memo.checkedAt < RECHECK_MS) return memo.etag;
  const stored = await env.CATALOG.get('etag');
  try {
    const res = await fetchImpl(env.ORIGIN ?? ORIGIN, { headers: stored ? { 'If-None-Match': stored } : {} });
    const etag = res.headers.get('etag');
    if (res.status === 200 && etag && res.body) {
      await env.CATALOG.put(`body:${etag}`, res.body);
      await env.CATALOG.put('etag', etag);
      if (stored && stored !== etag) await env.CATALOG.delete(`body:${stored}`);
      memo = { etag, checkedAt: now };
      return etag;
    }
    if (res.status !== 304) console.log(JSON.stringify({ origin: res.status }));
  } catch (error) {
    // Origin unreachable: keep serving the copy we have.
    console.log(JSON.stringify({ origin: String(error?.message ?? error) }));
  }
  if (stored) memo = { etag: stored, checkedAt: now };
  return stored;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag' };

export async function handle(request, env, now = Date.now(), fetchImpl = fetch) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'If-None-Match', 'Access-Control-Max-Age': '86400' },
    });
  }
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/master-catalog') {
    return new Response('Not found', { status: 404, headers: CORS });
  }
  const etag = await currentEtag(env, now, fetchImpl);
  if (!etag) return new Response('Unavailable', { status: 503, headers: CORS });
  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    ETag: etag,
    'Cache-Control': 'public, max-age=1800',
    Vary: 'Accept-Encoding',
  };
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  const body = await env.CATALOG.get(`body:${etag}`, 'stream');
  // KV is eventually consistent: another location may know the ETag before the body.
  if (!body) return new Response('Unavailable', { status: 503, headers: CORS });
  return new Response(body, { headers: { ...headers, 'Content-Encoding': 'gzip' }, encodeBody: 'manual' });
}

export default {
  fetch: (request, env) => handle(request, env),
};
