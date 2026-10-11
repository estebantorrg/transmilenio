import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import cors from 'cors';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { collectBody, decodeBody } from './services/upstream_body.js';
import { LIVE_API_HOST, LIVE_HOST_HEADERS } from './services/official_app_headers.js';
import { clientKey, createRateLimiter, createSharedWindow } from './services/flow_control.js';
import {
  LIVE_DESTINATION_MAX_LENGTH,
  LIVE_NAME_CANDIDATE_LIMIT,
  LIVE_ROUTE_CODE_MAX_LENGTH,
  normalizeLiveBusesPayload,
  normalizeLiveText,
} from './services/live_payload.js';

const LIVE_API_ORIGIN = `https://${LIVE_API_HOST}`;
const PORT = Number(process.env.COLOMBIA_RELAY_PORT || process.env.PORT || 8787);
const RELAY_SECRET = String(process.env.TRANSMILENIO_COLOMBIA_RELAY_SECRET || '').trim();
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const EGRESS_CACHE_MS = 30_000;
const LIVE_REQUEST_TIMEOUT_MS = 9_000;
const JSON_BODY_LIMIT = '64kb';
// What a route código looks like (`B12`, `661`, `3-5`): the relay has no catalog
// to check a `ruta` against, so its shape is the check. The longest filed is 5.
const ROUTE_CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,7}$/i;

// The same two bounds the main server keeps (spec §3.4, `flow_control.ts`):
// callers asking about one route share one answer, and a browser-direct client
// has a budget. The main server is not budgeted — it holds the secret, it is
// one address for every rider, and it bounds itself.
const SHARED_WINDOW_MS = 10_000;
const SHARED_MAX = 400;
const BUDGET_PER_MINUTE = 90;
const sharedBuses = createSharedWindow<any[]>(SHARED_WINDOW_MS, SHARED_MAX);
const rateLimiter = createRateLimiter(60_000);

const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ success: false, error: 'Request body too large' });
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ success: false, error: 'Invalid JSON body' });
    return;
  }

  next(error);
};

// Browser-direct mode: the web client (PC or mobile) calls this relay straight,
// so the live request egresses from the relay's Colombian IP with no main server
// in the path. Allow-list the app origin(s) for CORS.
const CLIENT_ORIGINS = String(process.env.RELAY_CLIENT_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * "Configured" = the operator told the relay who may call it, via a secret
 * (server-relay mode) or an origin allow-list (browser-direct mode) — spec §5.2.2.
 * Until then the relay is treated as a local dev instance.
 */
function isConfigured(): boolean {
  return RELAY_SECRET.length > 0 || CLIENT_ORIGINS.length > 0;
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (CLIENT_ORIGINS.includes(origin)) return true;
  // `Origin` is trivially forged by a non-browser caller, so a blanket localhost
  // pass would let ANY caller skip the secret on a public relay. Honour it only
  // while the relay is unconfigured, i.e. a local dev instance.
  return !isConfigured() && DEV_ORIGIN_RE.test(origin);
}

interface LiveRequestContext {
  routeCode: string;
  destinationName: string;
  routeType: 'troncal' | 'zonal';
  isZonal: boolean;
  targetPath: string;
  postData: string;
}

interface EgressCheck {
  ip: string;
  country: string;
  checkedAt: number;
}

let cachedEgress: EgressCheck | null = null;

/** Constant-time comparison to avoid leaking the secret via timing. */
function secretsMatch(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(RELAY_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The main server, or anything else holding `TRANSMILENIO_COLOMBIA_RELAY_SECRET`. */
function hasRelaySecret(req: Request): boolean {
  if (!RELAY_SECRET) return false;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const headerRaw = req.headers['x-relay-secret'];
  const headerSecret = String(Array.isArray(headerRaw) ? headerRaw[0] ?? '' : headerRaw ?? '').trim();
  return (bearer !== '' && secretsMatch(bearer)) ||
    (headerSecret !== '' && secretsMatch(headerSecret));
}

/**
 * The egress country check (`cdn-cgi/trace`). Bounded and error-listened through
 * the same reader every other upstream read uses (`collectBody`, spec §5.2.5):
 * a response that dies after its headers arrived emits `'error'` on the RESPONSE
 * stream, which `req.on('error')` does not cover — with no listener that is an
 * unhandled event and takes the relay process down.
 */
function fetchText(url: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      collectBody(res, 'egress trace').then(
        (body) => resolve(body.toString('utf-8')),
        reject
      );
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Egress country check timed out'));
    });
  });
}

async function checkEgress(): Promise<EgressCheck> {
  if (cachedEgress && Date.now() - cachedEgress.checkedAt < EGRESS_CACHE_MS) {
    return cachedEgress;
  }

  const trace = await fetchText(TRACE_URL);
  const fields = new Map(
    trace
      .split('\n')
      .map((line) => line.trim().split('='))
      .filter((parts) => parts.length === 2) as Array<[string, string]>
  );

  cachedEgress = {
    ip: fields.get('ip') || '',
    country: fields.get('loc') || '',
    checkedAt: Date.now(),
  };
  return cachedEgress;
}

async function assertColombianEgress(): Promise<EgressCheck> {
  const egress = await checkEgress();
  if (egress.country !== 'CO') {
    const error = new Error(`Relay egress is ${egress.country || 'unknown'}, not CO`);
    (error as Error & { statusCode?: number }).statusCode = 451;
    throw error;
  }
  return egress;
}

function makeLiveContext(
  routeCode: string,
  destinationName: string,
  routeType: 'troncal' | 'zonal'
): LiveRequestContext {
  const cleanRouteCode = normalizeLiveText(routeCode, LIVE_ROUTE_CODE_MAX_LENGTH);
  const cleanDestinationName = normalizeLiveText(destinationName, LIVE_DESTINATION_MAX_LENGTH);
  const isZonal = routeType === 'zonal';
  return {
    routeCode: cleanRouteCode,
    destinationName: cleanDestinationName,
    routeType,
    isZonal,
    targetPath: isZonal
      ? `/location/ruta?ruta=${encodeURIComponent(cleanRouteCode)}`
      : '/buses',
    postData: isZonal ? '' : JSON.stringify({ ruta: cleanRouteCode, Nombre: cleanDestinationName }),
  };
}

/**
 * Troncal matches by destination name; the catalog often holds several candidate
 * strings for one route. Build one context per distinct candidate so the handler
 * can try each until buses appear (parity with the main server). Zonal is keyed
 * purely by route code.
 */
function createLiveRequestContexts(body: any): LiveRequestContext[] {
  const routeType = body?.type === 'zonal' || body?.action === 'zonal' ? 'zonal' : 'troncal';
  const routeCode = normalizeLiveText(body?.ruta, LIVE_ROUTE_CODE_MAX_LENGTH);

  if (routeType === 'zonal') {
    return [makeLiveContext(routeCode, '', 'zonal')];
  }

  const primary = normalizeLiveText(body?.Nombre ?? body?.nombre, LIVE_DESTINATION_MAX_LENGTH);
  const raw = Array.isArray(body?.nombreCandidates) ? body.nombreCandidates : [];
  const names: string[] = [];
  for (const value of [...raw, primary]) {
    const name = normalizeLiveText(value, LIVE_DESTINATION_MAX_LENGTH);
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
    if (names.length >= LIVE_NAME_CANDIDATE_LIMIT) break;
  }
  const list = names.length ? names : [''];
  return list.map((name) => makeLiveContext(routeCode, name, 'troncal'));
}

async function parseLiveResponse(raw: Buffer, encoding: string | string[] | undefined): Promise<any[]> {
  const body = await decodeBody(raw, encoding).catch(() => raw);
  const text = body.toString('utf-8');
  const payload = JSON.parse(text);

  if (payload?.success === false) {
    throw new Error(payload.error || 'Live API returned success=false');
  }

  const problemStatus = Number(payload?.status);
  if (Number.isFinite(problemStatus) && problemStatus >= 400) {
    throw new Error(`Status: ${problemStatus} ${payload.title || payload.detail || ''}`.trim());
  }

  return normalizeLiveBusesPayload(payload);
}

function requestTransmiLiveJson(context: LiveRequestContext, signal?: AbortSignal): Promise<any[]> {
  const url = new URL(`${LIVE_API_ORIGIN}${context.targetPath}`);
  const postData = context.postData;
  const headers: Record<string, string | number> = {
    'Accept-Encoding': 'identity',
    ...LIVE_HOST_HEADERS,
    'Connection': 'Keep-Alive',
    'Host': LIVE_API_HOST,
    'Content-Length': Buffer.byteLength(postData),
  };

  if (postData) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Live API request aborted'));
      return;
    }
    const requestLib = url.protocol === 'http:' ? http : https;
    const req = requestLib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      timeout: LIVE_REQUEST_TIMEOUT_MS,
    }, (res) => {
      collectBody(res, 'Live API').then(
        async (raw) => {
          cleanup();
          if (res.statusCode !== 200) {
            reject(new Error(`Live API status: ${res.statusCode}`));
            return;
          }
          try {
            resolve(await parseLiveResponse(raw, res.headers['content-encoding']));
          } catch (error) {
            reject(error);
          }
        },
        (error) => { cleanup(); reject(error); }
      );
    });

    // Let the candidate race cancel the losers the moment one returns buses.
    const onAbort = () => req.destroy(new Error('Live API request aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (err) => { cleanup(); reject(err); });
    req.on('timeout', () => {
      cleanup();
      req.destroy();
      reject(new Error('Live API request timed out'));
    });

    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Fires every candidate at once, resolving with the first NON-EMPTY payload and
 * aborting the stragglers. A valid empty result needs all candidates to settle
 * (only a non-empty hit proves the name matched, spec §5.2.4); rejects only when
 * no candidate answered at all.
 */
function raceCandidates(contexts: LiveRequestContext[]): Promise<any[]> {
  if (contexts.length === 1) return requestTransmiLiveJson(contexts[0]);

  const controller = new AbortController();
  return new Promise<any[]>((resolve, reject) => {
    let pending = contexts.length;
    let answeredEmpty: any[] | null = null;
    let lastError: unknown = null;

    const settle = (fn: () => void) => {
      controller.abort();
      fn();
    };

    for (const context of contexts) {
      requestTransmiLiveJson(context, controller.signal).then(
        (result) => {
          if (result.length > 0) {
            settle(() => resolve(result));
            return;
          }
          answeredEmpty = result;
          if (--pending === 0) settle(() => resolve(answeredEmpty ?? []));
        },
        (error) => {
          lastError = error;
          if (--pending === 0) {
            if (answeredEmpty !== null) settle(() => resolve(answeredEmpty!));
            else settle(() => reject(lastError));
          }
        }
      );
    }
  });
}

const app = express();
// `req.ip` is what the budget counts against. The relay is reached either
// directly or through a tunnel on this same machine (Tailscale Funnel,
// cloudflared), and both tunnels put the caller in X-Forwarded-For — Tailscale
// overwrites the header with the source address it saw. Trusting loopback and
// nothing else reads that address through a tunnel, and the socket itself
// when there is none, so a caller cannot name its own.
app.set('trust proxy', 'loopback');
app.use(
  cors({
    origin(origin, cb) {
      // No Origin = non-browser caller (curl/server-to-server); allow at the CORS
      // layer and let the handler gate it (it needs the secret). Browser origins must be allow-listed.
      cb(null, !origin || isAllowedOrigin(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-relay-secret'],
    maxAge: 86_400,
  })
);
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(jsonErrorHandler);

app.get('/health', async (_req: Request, res: Response) => {
  try {
    const egress = await checkEgress();
    res.status(egress.country === 'CO' ? 200 : 451).json({
      status: egress.country === 'CO' ? 'ok' : 'blocked',
      colombiaOnly: true,
      egress: { country: egress.country, checkedAt: egress.checkedAt },
    });
  } catch (error: any) {
    res.status(503).json({ status: 'error', colombiaOnly: true, error: error.message });
  }
});

app.post('/buses', async (req: Request, res: Response) => {
  try {
    // An allow-listed `Origin` admits a browser, and that is all it does: it is
    // a header, and anything that is not a browser can send whichever one it
    // likes. So it is not treated as proof of who is calling — a caller
    // admitted by it is a stranger with a budget (spec §5.2.2), and an
    // unconfigured relay still answers only localhost (`isAllowedOrigin`).
    const trusted = hasRelaySecret(req);
    if (!trusted && !isAllowedOrigin(req.headers.origin as string | undefined)) {
      res.status(401).json({ success: false, error: 'Unauthorized relay request' });
      return;
    }
    if (!trusted && !rateLimiter.allow(clientKey(req.ip ?? ''), BUDGET_PER_MINUTE)) {
      res.setHeader('Retry-After', String(rateLimiter.retryAfterSeconds()));
      res.status(429).json({ success: false, error: 'Too many requests' });
      return;
    }

    const contexts = createLiveRequestContexts(req.body);
    if (!ROUTE_CODE_RE.test(contexts[0]?.routeCode ?? '')) {
      res.status(400).json({ success: false, error: 'ruta must be a route code' });
      return;
    }

    const egress = await assertColombianEgress();

    // Race every name candidate IN PARALLEL and settle the moment one returns
    // buses (spec §5.2.4 / §5.2.2b). The old sequential loop paid a round-trip —
    // or the full 9 s timeout — per miss before reaching the matching name, up to
    // 12 candidates deep: exactly the cold start the parallel fan-out removed
    // everywhere else (main server, native app, extension worker). An empty
    // result from a candidate that *answered* is a valid "no buses right now",
    // so it still requires every candidate to settle; an error is only surfaced
    // if none answered at all.
    const key = contexts.map((c) => `${c.routeType}|${c.routeCode}|${c.destinationName}`).join('||').toLowerCase();
    const buses = await sharedBuses(key, () => raceCandidates(contexts));

    res.json({
      success: true,
      count: buses.length,
      data: buses,
      egress: { country: egress.country },
    });
  } catch (error: any) {
    const status = error.statusCode || 503;
    res.status(status).json({
      success: false,
      error: error.message || 'Colombia relay failed',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Colombia live relay listening on http://localhost:${PORT}`);
  if (!isConfigured()) {
    console.warn(
      '[relay] Unconfigured: no TRANSMILENIO_COLOMBIA_RELAY_SECRET and no RELAY_CLIENT_ORIGINS. ' +
      'Only localhost origins are served. Set one of them before exposing this relay publicly (spec §5.2.2).'
    );
  }
});
