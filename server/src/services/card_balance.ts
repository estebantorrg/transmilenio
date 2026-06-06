import https from 'https';
import zlib from 'zlib';

const CARD_API_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
const CARD_API_PATH = '/lectura_tarjeta';
const CARD_REQUEST_TIMEOUT_MS = 9_000;

// The card host is the same CO-IP-geofenced host as live tracking (spec §5.2.1):
// a non-Colombian egress is rejected 401/451. When opted in, the card read falls
// back to the same public CO proxy pool live tracking uses (spec §5.2.5). The
// pool is already verified against this exact host, so a CO exit passes both.
const CO_PROXY_READY_TIMEOUT_MS = 18_000; // spec §5.5.2 pool readiness wait
const CO_PROXY_TIMEOUT_MS = Number(process.env.LIVE_PROXY_TIMEOUT_MS) || 14_000;
const CO_PROXY_RACE_WIDTH = Number(process.env.CO_PROXY_RACE_WIDTH) || 5;

function allowPublicColombianProxyFallback(): boolean {
  return process.env.TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY === '1';
}

const CARD_HEADERS_BASE = {
  'Accept-Encoding': 'gzip',
  'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
  'Connection': 'Keep-Alive',
  'Content-Type': 'application/json; charset=UTF-8',
  'Host': CARD_API_HOST,
  'User-Agent': 'okhttp/4.12.0',
  'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
  'version': '2.9.5',
} as const;

export type CardReadSource = 'server' | 'card';

export interface CardBalanceMovement {
  source: CardReadSource;
  numeroTarjeta: string;
  type: string;
  amount?: string;
  finalBalance?: string;
  occurredAt?: string;
  raw: Record<string, unknown>;
}

export interface CardBalanceRead {
  numeroTarjeta: string;
  consultar: 'true' | 'false';
  balance?: string;
  balanceSource?: CardReadSource;
  asOf?: string;
  movements: CardBalanceMovement[];
  sources: {
    server: {
      status: 'ok';
      host: string;
      path: string;
      method: 'POST';
      requestBody: { numero_tarjeta: string; consultar: 'true' | 'false' };
      requestHeaders: Record<string, string>;
      count: number;
    };
    card: {
      status: 'unavailable';
      reason: string;
    };
  };
}

export class CardBalanceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 502,
    public readonly upstreamStatus?: number
  ) {
    super(message);
    this.name = 'CardBalanceError';
  }
}

export function normalizeConsultar(value: unknown): 'true' | 'false' {
  const raw = String(value ?? 'false').trim().toLowerCase();
  if (raw === 'true') return 'true';
  if (raw === 'false') return 'false';
  throw new CardBalanceError('consultar must be "true" or "false"', 400);
}

export function normalizeCardNumber(value: unknown): string {
  const cardNumber = String(value ?? '').trim();
  if (!/^\d{8,20}$/.test(cardNumber)) {
    throw new CardBalanceError('numero_tarjeta must be 8 to 20 digits', 400);
  }
  return cardNumber;
}

export function maskCardNumber(cardNumber: string): string {
  if (cardNumber.length <= 6) return cardNumber;
  return `${cardNumber.slice(0, 4)}...${cardNumber.slice(-4)}`;
}

function decodeCardBody(raw: Buffer, encoding: string | string[] | undefined): Promise<Buffer> {
  const contentEncoding = Array.isArray(encoding) ? encoding.join(',') : encoding || '';
  if (!contentEncoding.toLowerCase().includes('gzip')) return Promise.resolve(raw);

  return new Promise((resolve, reject) => {
    zlib.gunzip(raw, (err, decoded) => {
      if (err) reject(err);
      else resolve(decoded);
    });
  });
}

function isRow(item: unknown): item is Record<string, unknown> {
  return item != null && typeof item === 'object' && !Array.isArray(item);
}

/**
 * One POST to the card host, returning the ledger rows. Optionally tunnelled
 * through a CO proxy (`agent`) and cancellable (`signal`) so the proxy fallback
 * can race several at once and abort the losers.
 */
function requestCardRows(
  postData: string,
  timeoutMs: number,
  agent?: https.Agent,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CardBalanceError('Card API request aborted', 502));
      return;
    }

    const headers: Record<string, string | number> = {
      ...CARD_HEADERS_BASE,
      'Content-Length': Buffer.byteLength(postData),
    };

    const req = https.request({
      hostname: CARD_API_HOST,
      path: CARD_API_PATH,
      method: 'POST',
      headers,
      agent,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', async () => {
        cleanup();
        const raw = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          const status = res.statusCode ?? 0;
          // 401/451 = CO-IP geofence; map to 503 and tag the upstream status so
          // the caller can decide to retry via a Colombian egress.
          const clientStatus = status === 401 || status === 451 ? 503 : 502;
          reject(new CardBalanceError(`Card API status ${status}`, clientStatus, status));
          return;
        }

        try {
          const body = await decodeCardBody(raw, res.headers['content-encoding']);
          const payload = JSON.parse(body.toString('utf-8'));
          resolve(Array.isArray(payload) ? payload.filter(isRow) : []);
        } catch (error: any) {
          reject(new CardBalanceError(`Card API JSON parse error: ${error?.message || error}`, 502));
        }
      });
    });

    const onAbort = () => {
      cleanup();
      req.destroy();
      reject(new CardBalanceError('Card API request aborted', 502));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (error: any) => {
      cleanup();
      reject(error instanceof CardBalanceError ? error : new CardBalanceError(`Card API request failed: ${error.message}`, 502));
    });
    req.on('timeout', () => {
      cleanup();
      req.destroy();
      reject(new CardBalanceError('Card API request timed out', 504));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Races the best N verified CO proxies and takes the fastest valid response,
 * aborting the rest — the same egress and pool live tracking uses (spec §5.2.5).
 */
async function fetchCardRowsViaColombianProxy(postData: string): Promise<Record<string, unknown>[]> {
  const { ProxyManager, SimpleProxyAgent } = await import('./proxy_manager.js');
  const ready = await ProxyManager.waitForReady(CO_PROXY_READY_TIMEOUT_MS);
  if (ready === 0) throw new CardBalanceError('No Colombian proxy available for card read', 503);

  const proxies = ProxyManager.getProxies(CO_PROXY_RACE_WIDTH);
  if (proxies.length === 0) throw new CardBalanceError('No Colombian proxy available for card read', 503);

  const controller = new AbortController();
  const attempts = proxies.map(async (proxy) => {
    const started = Date.now();
    try {
      const rows = await requestCardRows(postData, CO_PROXY_TIMEOUT_MS, new SimpleProxyAgent(proxy.ip, proxy.port), controller.signal);
      ProxyManager.reportSuccess(proxy.ip, proxy.port, Date.now() - started);
      return rows;
    } catch (error) {
      // Aborted losers are not genuine failures; don't penalise them.
      if (!controller.signal.aborted) ProxyManager.reportFailure(proxy.ip, proxy.port);
      throw error;
    }
  });

  try {
    const rows = await Promise.any(attempts);
    controller.abort(); // cancel the slower in-flight proxies
    return rows;
  } catch {
    throw new CardBalanceError(`All ${proxies.length} CO proxies failed for card read`, 503);
  }
}

function normalizeServerMovement(item: Record<string, unknown>, fallbackCardNumber: string): CardBalanceMovement {
  return {
    source: 'server',
    numeroTarjeta: String(item.numero_tarjeta ?? fallbackCardNumber),
    type: String(item.tipo ?? ''),
    finalBalance: item.saldo_tarjeta == null ? undefined : String(item.saldo_tarjeta),
    occurredAt: item.ultima_transaccion == null ? undefined : String(item.ultima_transaccion),
    raw: item,
  };
}

export async function fetchCardBalance(
  numeroTarjetaInput: unknown,
  consultarInput: unknown = 'false'
): Promise<CardBalanceRead> {
  const numeroTarjeta = normalizeCardNumber(numeroTarjetaInput);
  const consultar = normalizeConsultar(consultarInput);
  const postData = JSON.stringify({ numero_tarjeta: numeroTarjeta, consultar });

  let rows: Record<string, unknown>[];
  try {
    // 1. Direct — works when the backend egress is Colombian.
    rows = await requestCardRows(postData, CARD_REQUEST_TIMEOUT_MS);
  } catch (error) {
    const geofenced = error instanceof CardBalanceError && (error.upstreamStatus === 401 || error.upstreamStatus === 451);
    if (geofenced && allowPublicColombianProxyFallback()) {
      // 2. Public CO proxy — opt-in best-effort egress (spec §5.2.5).
      rows = await fetchCardRowsViaColombianProxy(postData);
    } else if (geofenced) {
      throw new CardBalanceError(
        'Card API is CO-IP geofenced and this server egress is not Colombian. Set TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY=1 (public CO proxy, spec §5.2.5) or run the backend from a Colombian egress.',
        503,
        error.upstreamStatus
      );
    } else {
      throw error;
    }
  }

  const movements = rows.map((item) => normalizeServerMovement(item, numeroTarjeta));
  const latest = movements[0];

  return {
    numeroTarjeta,
    consultar,
    balance: latest?.finalBalance,
    balanceSource: latest ? 'server' : undefined,
    asOf: latest?.occurredAt,
    movements,
    sources: {
      server: {
        status: 'ok',
        host: CARD_API_HOST,
        path: CARD_API_PATH,
        method: 'POST',
        requestBody: { numero_tarjeta: numeroTarjeta, consultar },
        requestHeaders: Object.fromEntries(Object.entries(CARD_HEADERS_BASE).map(([key, value]) => [key, String(value)])),
        count: movements.length,
      },
      card: {
        status: 'unavailable',
        reason: 'The official card endpoint returns the server ledger only. The current balance and movement ring shown after tapping a card are read locally from NFC card memory, which this web/server runtime cannot access.',
      },
    },
  };
}
