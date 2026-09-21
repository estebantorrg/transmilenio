/**
 * TransMilenio Explorer — Live Bridge (background service worker)
 *
 * Performs the live-bus request from the *user's* browser. An extension
 * background fetch to a host listed in `host_permissions` is not subject to the
 * page's CORS policy, so it succeeds where a normal page `fetch` is blocked
 * (preflight 403 + missing Access-Control-Allow-Origin). Because the request
 * leaves the user's own machine, it also carries the user's Colombian egress IP
 * and passes the live API's CO-only geofence — no server relay required.
 *
 * Security: this worker only ever contacts the single hard-coded live host with
 * fixed request shapes. It never accepts or fetches a page-supplied URL, so a
 * matched page cannot turn the extension into an open proxy. The only data it
 * can retrieve is public, real-time bus positions.
 */

const LIVE_HOST = 'https://tmsa-transmiapp-shvpc.uc.r.appspot.com';
const APPID = '9a2c3b48f0c24ae9bfba38e94f27c3ea';
const REQUEST_TIMEOUT_MS = 9000;
// This install's id for the `uuid` header the host has required since
// 2026-09-21 (without it: empty 403). Generated once and stored, so it is one
// id per install like the official app's — never a literal shared by every
// user (TMSA blocklisted exactly such an id on 2026-09-16), and never a fresh
// one per request. Mirrors client/src/services/installId.ts; the extension
// cannot import from the bundle.
const UUID_KEY = 'installUuid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let installUuidCache = null;

async function installUuid() {
  if (installUuidCache) return installUuidCache;
  try {
    const stored = await chrome.storage.local.get(UUID_KEY);
    if (stored && UUID_RE.test(String(stored[UUID_KEY] || ''))) {
      installUuidCache = String(stored[UUID_KEY]);
      return installUuidCache;
    }
  } catch (error) {
    /* unreadable store → fall through to a fresh id for this session */
  }
  installUuidCache = crypto.randomUUID();
  try {
    await chrome.storage.local.set({ [UUID_KEY]: installUuidCache });
  } catch (error) {
    /* session-only id; still a valid install for this run */
  }
  return installUuidCache;
}
// Candidates are fired in PARALLEL, so the list length is a fan-out multiplier
// on the user's own connection. Any script on a matched page can post a `fetch`
// message, so cap it here exactly as the server does (LIVE_NAME_CANDIDATE_LIMIT
// in server/src/services/tm_api.ts) instead of trusting the page.
const MAX_CANDIDATES = 12;

function isBusLike(value) {
  if (!value || typeof value !== 'object') return false;
  const lat = Number(value.latitude ?? value.lat);
  const lng = Number(value.longitude ?? value.lng ?? value.lon);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/** Unwrap the many shapes the live API returns into a flat bus array. */
function toBusArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const keys = ['data', 'buses', 'result', 'results', 'vehiculos', 'vehicles'];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const key of keys) {
    const nested = payload[key];
    if (nested && typeof nested === 'object') {
      const buses = Object.values(nested).filter(isBusLike);
      if (buses.length) return buses;
    }
  }
  const buses = Object.values(payload).filter(isBusLike);
  return buses.length ? buses : [];
}

async function fetchLiveOnce(path, body, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  try {
    const headers = { Appid: APPID, uuid: await installUuid() };
    if (body != null) headers['Content-Type'] = 'application/json; charset=UTF-8';

    const res = await fetch(LIVE_HOST + path, {
      method: 'POST',
      headers,
      body: body == null ? undefined : body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Live API status ${res.status}`);

    const json = await res.json();
    if (json && json.success === false) throw new Error(json.error || 'Live API success=false');
    const status = Number(json && json.status);
    if (Number.isFinite(status) && status >= 400) {
      throw new Error(`Status ${status} ${(json && (json.title || json.detail)) || ''}`.trim());
    }
    return toBusArray(json);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Resolves with the first candidate that returns buses. A wrong destination name
 * answers with an empty list rather than an error, so the winning condition is
 * "first NON-EMPTY": a valid empty result is only returned once every candidate
 * has answered, and the rejection only if none did.
 */
function firstNonEmpty(tasks) {
  return new Promise((resolve, reject) => {
    let pending = tasks.length;
    let empty = null;
    let lastError = null;

    for (const task of tasks) {
      task.then(
        (buses) => {
          if (buses.length > 0) return resolve(buses);
          empty = buses;
          if (--pending === 0) resolve(empty || []);
        },
        (error) => {
          lastError = error;
          if (--pending === 0) {
            if (empty !== null) resolve(empty);
            else reject(lastError);
          }
        }
      );
    }
  });
}

// Which destination name last returned buses, per troncal route code. Only one
// candidate can match and it does not change between polls, so remembering it
// turns a poll into one request instead of up to MAX_CANDIDATES. Session-scoped:
// a restarted worker re-learns it on the first poll.
const nameMemo = new Map();
const NAME_MEMO_TTL_MS = 10 * 60 * 1000;
const NAME_MEMO_MAX = 200;

function recallLiveName(routeCode) {
  const entry = nameMemo.get(routeCode.toUpperCase());
  if (!entry) return null;
  return { name: entry.name, fresh: Date.now() - entry.at < NAME_MEMO_TTL_MS };
}

function rememberLiveName(routeCode, name) {
  const key = routeCode.toUpperCase();
  if (!key || !name) return;
  nameMemo.delete(key); // re-insert so the map stays in insertion order
  nameMemo.set(key, { name, at: Date.now() });
  while (nameMemo.size > NAME_MEMO_MAX) {
    const oldest = nameMemo.keys().next().value;
    if (oldest === undefined) break;
    nameMemo.delete(oldest);
  }
}

function forgetLiveName(routeCode) {
  nameMemo.delete(routeCode.toUpperCase());
}

/** One `/buses` ask for a single candidate name, remembering a name that hits. */
async function askLive(code, name, signal) {
  const buses = await fetchLiveOnce('/buses', JSON.stringify({ ruta: code, Nombre: name }), signal);
  if (buses.length > 0) rememberLiveName(code, name);
  return buses;
}

/**
 * Troncal needs a destination name to match; the catalog often holds several
 * candidate strings. Fire them ALL in parallel and take the first that returns
 * buses — trying them one by one paid a round-trip (or a full 9 s timeout) per
 * miss before reaching the matching name, which dominated the first fix of a
 * tracking session. Mirrors the server's parallel candidate strategy. Zonal is
 * keyed purely by route code with an empty body.
 */
async function fetchLive({ ruta, nombre, routeType, candidates }) {
  const code = String(ruta || '').trim();
  if (!code) throw new Error('ruta is required');

  if (routeType === 'zonal') {
    return fetchLiveOnce(`/location/ruta?ruta=${encodeURIComponent(code)}`, null);
  }

  const names = (Array.isArray(candidates) && candidates.length ? candidates : [nombre])
    .map((n) => String(n || '').trim())
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);
  const tried = names.length ? names : [''];

  // Poll 2 onwards asks only the name that matched. The fan-out exists to find
  // it once; re-asking the same misses every 15 s is load the upstream has
  // already shown it counts (spec §5.2.3). Mirrors client/src/services/liveNameMemo.ts.
  const memo = recallLiveName(code);
  if (memo && tried.includes(memo.name) && tried.length > 1) {
    const buses = await askLive(code, memo.name);
    // Empty from the matching name is "no buses right now"; a stale memo makes
    // the name itself the suspect, so fall through to the full fan-out.
    if (buses.length > 0 || memo.fresh) return buses;
    forgetLiveName(code);
  }

  // Cancel the still-running candidates as soon as one wins.
  const controller = new AbortController();
  try {
    return await firstNonEmpty(tried.map((name) => askLive(code, name, controller.signal)));
  } finally {
    controller.abort();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'tm-live-fetch') return;
  fetchLive(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the message channel open for the async response
});
