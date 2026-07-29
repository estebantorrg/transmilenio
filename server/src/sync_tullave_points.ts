/**
 * Refreshes the two tullave POI catalogues (spec §5.5.1, §5.8 Host 2).
 *
 *   recarga         → `/puntos_recarga`         → `data/recarga_points.json`
 *   personalizacion → `/puntos_personalizacion` → `data/personalizacion_points.json`
 *
 * Both are static POI data on the CO-geofenced live host, and both come back in
 * the identical `TuLlave` shape (verified in the official app v2.9.6 —
 * `Models/TuLlave.java`, one model class serving both calls). So this is ONE
 * sync parameterised by path, not two files that must be kept in step (R2).
 *
 * Like the master catalog, the result is fetched once and committed: production
 * (Render, US egress) then serves the file with zero runtime geofence
 * dependency, and neither endpoint is ever called on a request path.
 *
 * Egress cascade — direct → CO relay → public CO proxy — the same order every
 * other geofenced read uses (spec §5.2.2a, §5.2.5), so this runs from anywhere:
 *   npm run sync:recarga            # from a CO connection, or via relay/proxy
 *   npm run sync:personalizacion
 *   npm run sync:tullave -- all
 */
import { writeFile } from 'node:fs/promises';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectBody, decodeBody } from './services/upstream_body.js';
import { relayForward, isColombiaRelayConfigured } from './services/co_relay.js';

const LIVE_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

const HEADERS: Record<string, string> = {
  Appid: '9a2c3b48f0c24ae9bfba38e94f27c3ea',
  'User-Agent': 'okhttp/4.12.0',
  uuid: 'fd1be953-d85e-4c63-8c23-234f143f445d',
  version: '2.9.5',
  'Accept-Encoding': 'gzip',
};

const DIRECT_TIMEOUT_MS = 15_000;
const RELAY_TIMEOUT_MS = 20_000;
// A free proxy carrying a ~1 MB POI payload is far slower than a live-bus fix,
// so this is deliberately looser than the 14 s live budget (spec §5.5.2).
const PROXY_TIMEOUT_MS = 30_000;
const PROXY_READY_TIMEOUT_MS = 18_000;
const PROXY_RACE_WIDTH = 6;

export type TuLlaveDatasetId = 'recarga' | 'personalizacion';

interface TuLlaveDataset {
  /** Upstream path — must be allowlisted in the OCI relay (spec §5.2.2a). */
  path: string;
  file: string;
  label: string;
}

export const TULLAVE_DATASETS: Record<TuLlaveDatasetId, TuLlaveDataset> = {
  recarga: {
    path: '/puntos_recarga',
    file: 'recarga_points.json',
    label: 'recharge points',
  },
  personalizacion: {
    path: '/puntos_personalizacion',
    file: 'personalizacion_points.json',
    label: 'personalization points',
  },
};

/**
 * One tullave POI. Field names are the upstream's own (`TuLlave` model).
 *
 * The three opaque hour fields are labelled here as the OFFICIAL APP labels
 * them (v2.9.6 `MapTagActivity.onResult`), not as their names suggest — `wks`
 * is not "weekdays". Getting this backwards silently mislabels opening hours,
 * and "No Opera" in the wrong row reads as a closed shop (spec §1 certainty).
 */
export interface TuLlavePoint {
  nombre: string;
  direccion: string;
  localidad: string;
  latitud: number;
  longitud: number;
  hds?: string; // "Horario entre semana"      → Mon–Fri
  exs?: string; // "Horario Sabados"           → Saturday
  wks?: string; // "Horario Domingos y Festivos" → Sunday + holidays ("No Opera" = closed)
}

/** Upstream types `nombre` as a bare Object, so it is not guaranteed to be a
 *  string — coerce rather than trust it. */
function text(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function clean(raw: any): TuLlavePoint | null {
  const lat = Number(raw?.latitud);
  const lng = Number(raw?.longitud);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) return null;
  const nombre = text(raw?.nombre);
  if (!nombre) return null;
  return {
    nombre,
    direccion: text(raw?.direccion),
    localidad: text(raw?.localidad),
    latitud: lat,
    longitud: lng,
    hds: raw?.hds ? String(raw.hds) : undefined,
    exs: raw?.exs ? String(raw.exs) : undefined,
    wks: raw?.wks ? String(raw.wks) : undefined,
  };
}

/**
 * One GET to the live host. Optionally tunnelled through a CO proxy (`agent`)
 * and cancellable (`signal`) so the proxy tier can race several and abort the
 * losers. The body goes through the shared bounded reader — a free proxy is an
 * untrusted middlebox that can answer with an arbitrarily long body or a gzip
 * bomb (spec §5.2.5).
 */
function requestPoints(
  path: string,
  timeoutMs: number,
  agent?: https.Agent,
  signal?: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const req = https.request(
      { hostname: LIVE_HOST, path, method: 'GET', headers: HEADERS, agent, timeout: timeoutMs },
      (res) => {
        collectBody(res, `tullave ${path}`).then(
          async (raw) => {
            cleanup();
            if (res.statusCode !== 200) {
              // 401/451 = the CO-IP geofence rejecting a non-Colombian egress.
              const geo = res.statusCode === 401 || res.statusCode === 451;
              reject(new Error(`${path} HTTP ${res.statusCode}${geo ? ' (geofenced — needs a Colombian egress)' : ''}`));
              return;
            }
            try {
              const body = await decodeBody(raw, res.headers['content-encoding']);
              resolve(JSON.parse(body.toString('utf-8')));
            } catch (error: any) {
              reject(new Error(`${path} parse error: ${error?.message || error}`));
            }
          },
          (error: any) => {
            cleanup();
            reject(new Error(`${path} read failed: ${error?.message || error}`));
          }
        );
      }
    );

    const onAbort = () => {
      cleanup();
      req.destroy();
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (error: any) => {
      cleanup();
      reject(error);
    });
    req.on('timeout', () => {
      cleanup();
      req.destroy();
      reject(new Error(`${path} timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

/** Races the best N verified CO proxies, taking the fastest valid response. */
async function fetchViaPublicProxy(path: string): Promise<unknown> {
  const { ProxyManager, SimpleProxyAgent } = await import('./services/proxy_manager.js');
  const ready = await ProxyManager.waitForReady(PROXY_READY_TIMEOUT_MS);
  if (ready === 0) throw new Error('no verified Colombian proxy available');

  const proxies = ProxyManager.getProxies(PROXY_RACE_WIDTH);
  if (proxies.length === 0) throw new Error('no verified Colombian proxy available');

  const controller = new AbortController();
  const attempts = proxies.map(async (proxy) => {
    const started = Date.now();
    try {
      const payload = await requestPoints(
        path,
        PROXY_TIMEOUT_MS,
        new SimpleProxyAgent(proxy.ip, proxy.port),
        controller.signal
      );
      if (!Array.isArray(payload)) throw new Error('proxy returned a non-array payload');
      ProxyManager.reportSuccess(proxy.ip, proxy.port, Date.now() - started);
      return payload;
    } catch (error) {
      // Aborted losers are not genuine failures; don't penalise them.
      if (!controller.signal.aborted) ProxyManager.reportFailure(proxy.ip, proxy.port);
      throw error;
    }
  });

  try {
    const payload = await Promise.any(attempts);
    controller.abort(); // cancel the slower in-flight proxies
    return payload;
  } catch {
    throw new Error(`all ${proxies.length} CO proxies failed`);
  }
}

/**
 * Fetches one catalogue through whichever Colombian egress is available.
 * Every tier is attempted in turn; only an all-tiers failure throws.
 */
async function fetchPoints(path: string): Promise<unknown> {
  const failures: string[] = [];

  try {
    return await requestPoints(path, DIRECT_TIMEOUT_MS);
  } catch (error: any) {
    failures.push(`direct: ${error?.message || error}`);
  }

  if (isColombiaRelayConfigured()) {
    try {
      // GET, not POST — the forward envelope defaults to POST and these two
      // catalogues are GET-only (spec §5.2.2a).
      const { upstreamStatus, payload } = await relayForward(path, undefined, RELAY_TIMEOUT_MS, undefined, 'GET');
      if (upstreamStatus === 200) return payload;
      failures.push(`co-relay: upstream HTTP ${upstreamStatus}`);
    } catch (error: any) {
      failures.push(`co-relay: ${error?.message || error}`);
    }
  } else {
    failures.push('co-relay: not configured (TRANSMILENIO_COLOMBIA_RELAY_URL)');
  }

  try {
    return await fetchViaPublicProxy(path);
  } catch (error: any) {
    failures.push(`public proxy: ${error?.message || error}`);
  }

  throw new Error(`No Colombian egress worked for ${path}:\n  - ${failures.join('\n  - ')}`);
}

/** Fetches one catalogue and writes it, returning the point count. */
export async function syncTuLlaveDataset(id: TuLlaveDatasetId): Promise<number> {
  const dataset = TULLAVE_DATASETS[id];
  const raw = await fetchPoints(dataset.path);
  if (!Array.isArray(raw)) throw new Error(`${dataset.path} did not return an array`);

  const points = raw.map(clean).filter((p): p is TuLlavePoint => p !== null);
  // Refuse to overwrite a good committed file with an empty harvest: a silently
  // emptied catalogue would read downstream as "this POI kind has no points"
  // rather than as the failure it is (spec §1 certainty).
  if (points.length === 0) throw new Error(`${dataset.path} yielded 0 usable points — refusing to write`);

  await writeFile(join(DATA_DIR, dataset.file), JSON.stringify(points), 'utf8');
  return points.length;
}

// Run directly (not when imported). Sets `exitCode` instead of calling
// `process.exit()` — a hard exit races libuv handle teardown on Windows
// (assertion in async.c) while the undici pool is still closing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (process.argv[2] || 'all').toLowerCase();
  const ids: TuLlaveDatasetId[] =
    arg === 'all' ? (Object.keys(TULLAVE_DATASETS) as TuLlaveDatasetId[]) : [arg as TuLlaveDatasetId];

  const unknown = ids.filter((id) => !TULLAVE_DATASETS[id]);
  if (unknown.length) {
    console.error(`[sync:tullave] Unknown dataset(s): ${unknown.join(', ')}. Expected: recarga, personalizacion, all`);
    process.exitCode = 1;
  } else {
    (async () => {
      let failed = 0;
      for (const id of ids) {
        const { label, file } = TULLAVE_DATASETS[id];
        try {
          const n = await syncTuLlaveDataset(id);
          console.log(`[sync:tullave] ${label}: wrote ${n} points to data/${file}`);
        } catch (error: any) {
          failed++;
          console.error(`[sync:tullave] ${label} failed: ${error?.message || error}`);
        }
      }
      if (failed) process.exitCode = 1;
    })();
  }
}
