import https from 'https';
import zlib from 'zlib';

const CARD_API_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
const CARD_API_PATH = '/lectura_tarjeta';
const CARD_REQUEST_TIMEOUT_MS = 9_000;

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
  constructor(message: string, public readonly statusCode: number = 502) {
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
  const headers: Record<string, string | number> = {
    ...CARD_HEADERS_BASE,
    'Content-Length': Buffer.byteLength(postData),
  };

  const payload = await new Promise<unknown>((resolve, reject) => {
    const req = https.request({
      hostname: CARD_API_HOST,
      path: CARD_API_PATH,
      method: 'POST',
      headers,
      timeout: CARD_REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', async () => {
        const raw = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          reject(new CardBalanceError(`Card API status ${res.statusCode}`, res.statusCode === 401 || res.statusCode === 451 ? 503 : 502));
          return;
        }

        try {
          const body = await decodeCardBody(raw, res.headers['content-encoding']);
          const text = body.toString('utf-8');
          resolve(JSON.parse(text));
        } catch (error: any) {
          reject(new CardBalanceError(`Card API JSON parse error: ${error?.message || error}`, 502));
        }
      });
    });

    req.on('error', (error) => reject(new CardBalanceError(`Card API request failed: ${error.message}`, 502)));
    req.on('timeout', () => {
      req.destroy();
      reject(new CardBalanceError('Card API request timed out', 504));
    });
    req.write(postData);
    req.end();
  });

  const rows = Array.isArray(payload) ? payload : [];
  const movements = rows
    .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
    .map((item) => normalizeServerMovement(item, numeroTarjeta));
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
