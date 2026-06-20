import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import cors from 'cors';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import crypto from 'crypto';

const LIVE_API_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
const LIVE_API_ORIGIN = `https://${LIVE_API_HOST}`;
const PORT = Number(process.env.COLOMBIA_RELAY_PORT || process.env.PORT || 8787);
const RELAY_SECRET = String(process.env.TRANSMILENIO_COLOMBIA_RELAY_SECRET || '').trim();
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const EGRESS_CACHE_MS = 30_000;
const LIVE_REQUEST_TIMEOUT_MS = 9_000;
const JSON_BODY_LIMIT = '64kb';
const LIVE_ROUTE_CODE_MAX_LENGTH = 32;
const LIVE_DESTINATION_MAX_LENGTH = 160;
const LIVE_NAME_CANDIDATE_LIMIT = 12;

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

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return DEV_ORIGIN_RE.test(origin) || CLIENT_ORIGINS.includes(origin);
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

function isAuthorized(req: Request): boolean {
  // Browser requests from an allow-listed origin are trusted at the app layer:
  // CORS already blocks other browser origins, and the relay returns only public,
  // CO-gated bus positions. (Origin is not a hard boundary for non-browser
  // clients, but there is nothing private to protect here.)
  if (isAllowedOrigin(req.headers.origin as string | undefined)) return true;

  if (!RELAY_SECRET) return true;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const headerRaw = req.headers['x-relay-secret'];
  const headerSecret = String(Array.isArray(headerRaw) ? headerRaw[0] ?? '' : headerRaw ?? '').trim();
  return (bearer !== '' && secretsMatch(bearer)) ||
    (headerSecret !== '' && secretsMatch(headerSecret));
}

function fetchText(url: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
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

function normalizeLiveText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
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

function isLiveBusLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const bus = value as { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown; lon?: unknown };
  return Number.isFinite(Number(bus.latitude ?? bus.lat)) &&
    Number.isFinite(Number(bus.longitude ?? bus.lng ?? bus.lon));
}

function normalizeLiveBusesPayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [
    payload.data,
    payload.buses,
    payload.result,
    payload.results,
    payload.vehiculos,
    payload.vehicles,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const buses = Object.values(candidate).filter(isLiveBusLike);
      if (buses.length > 0) return buses;
    }
  }

  const buses = Object.values(payload).filter(isLiveBusLike);
  return buses.length > 0 ? buses : [];
}

function decodeBody(raw: Buffer, encoding: string | string[] | undefined): Promise<Buffer> {
  const contentEncoding = Array.isArray(encoding) ? encoding.join(',') : encoding || '';
  if (!contentEncoding.toLowerCase().includes('gzip')) return Promise.resolve(raw);

  return new Promise((resolve, reject) => {
    zlib.gunzip(raw, (err, decompressed) => {
      if (err) reject(err);
      else resolve(decompressed);
    });
  });
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

function requestTransmiLiveJson(context: LiveRequestContext): Promise<any[]> {
  const url = new URL(`${LIVE_API_ORIGIN}${context.targetPath}`);
  const postData = context.postData;
  const headers: Record<string, string | number> = {
    'Accept-Encoding': 'identity',
    'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
    'Connection': 'Keep-Alive',
    'Host': LIVE_API_HOST,
    'User-Agent': 'okhttp/4.12.0',
    'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
    'version': '2.9.5',
    'Content-Length': Buffer.byteLength(postData),
  };

  if (postData) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
  }

  return new Promise((resolve, reject) => {
    const requestLib = url.protocol === 'http:' ? http : https;
    const req = requestLib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      timeout: LIVE_REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', async () => {
        const raw = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          reject(new Error(`Live API status: ${res.statusCode}`));
          return;
        }

        try {
          resolve(await parseLiveResponse(raw, res.headers['content-encoding']));
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Live API request timed out'));
    });

    if (postData) req.write(postData);
    req.end();
  });
}

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      // No Origin = non-browser caller (curl/server-to-server); allow at the CORS
      // layer and let isAuthorized() gate it. Browser origins must be allow-listed.
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
    if (!isAuthorized(req)) {
      res.status(401).json({ success: false, error: 'Unauthorized relay request' });
      return;
    }

    const contexts = createLiveRequestContexts(req.body);
    if (!contexts[0]?.routeCode) {
      res.status(400).json({ success: false, error: 'ruta is required' });
      return;
    }

    const egress = await assertColombianEgress();

    // Try each name candidate; return the first non-empty payload. An empty
    // result from a candidate that *answered* is a valid "no buses right now";
    // only surface an error if every candidate threw.
    let buses: any[] = [];
    let anyAnswered = false;
    let lastError: Error | null = null;
    for (const context of contexts) {
      try {
        const result = await requestTransmiLiveJson(context);
        anyAnswered = true;
        if (result.length) {
          buses = result;
          break;
        }
      } catch (error) {
        lastError = error as Error;
      }
    }
    if (!anyAnswered && lastError) throw lastError;

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
});
