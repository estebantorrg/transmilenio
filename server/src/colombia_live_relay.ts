import express, { Request, Response } from 'express';
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

function createLiveRequestContext(body: any): LiveRequestContext {
  const routeType = body?.type === 'zonal' || body?.action === 'zonal' ? 'zonal' : 'troncal';
  const routeCode = String(body?.ruta || '').trim();
  const destinationName = String(body?.Nombre ?? body?.nombre ?? '').trim();
  const isZonal = routeType === 'zonal';

  return {
    routeCode,
    destinationName,
    routeType,
    isZonal,
    targetPath: isZonal
      ? `/location/ruta?ruta=${encodeURIComponent(routeCode)}`
      : '/buses',
    postData: isZonal ? '' : JSON.stringify({ ruta: routeCode, Nombre: destinationName }),
  };
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
app.use(express.json());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    const egress = await checkEgress();
    res.status(egress.country === 'CO' ? 200 : 451).json({
      status: egress.country === 'CO' ? 'ok' : 'blocked',
      colombiaOnly: true,
      egress,
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

    const context = createLiveRequestContext(req.body);
    if (!context.routeCode) {
      res.status(400).json({ success: false, error: 'ruta is required' });
      return;
    }

    const egress = await assertColombianEgress();
    const buses = await requestTransmiLiveJson(context);
    res.json({
      success: true,
      count: buses.length,
      data: buses,
      egress: { country: egress.country, ip: egress.ip },
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
