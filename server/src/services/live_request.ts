/**
 * One request to the live host, and one race across a route's name candidates
 * (spec §5.2.4).
 *
 * The main server's tier cascade (`tm_api.ts`) and the standalone relay
 * (`colombia_live_relay.ts`) each carried their own copy of all of this, and a
 * copy had already drifted once (spec §1.1 R2). Its own module, free of
 * `import.meta` and of the catalog, so both import it and the Playwright runner
 * can load it (`tests/live-request.spec.ts`) — `tm_api.ts` cannot be.
 */

import http from 'http';
import https from 'https';
import { collectBody, decodeBody } from './upstream_body.js';
import { LIVE_API_HOST, LIVE_HOST_HEADERS } from './official_app_headers.js';
import {
  LIVE_DESTINATION_MAX_LENGTH,
  LIVE_NAME_CANDIDATE_LIMIT,
  LIVE_ROUTE_CODE_MAX_LENGTH,
  normalizeLiveText,
} from './live_payload.js';
import { addUniqueLiveName } from '../../../shared/live_names.js';
import { findBusPayloadArray } from '../../../shared/live_payload.js';

export const LIVE_API_ORIGIN = `https://${LIVE_API_HOST}`;

// ─── What is asked ────────────────────────────────────────

export interface LiveRequestContext {
  routeCode: string;
  destinationName: string;
  routeType: 'troncal' | 'zonal';
  isZonal: boolean;
  targetPath: string;
  postData: string;
  candidateName: string;
}

export function createLiveRequestContext(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal' = 'troncal',
  candidateName = nombre
): LiveRequestContext {
  const routeCode = normalizeLiveText(ruta, LIVE_ROUTE_CODE_MAX_LENGTH);
  const destinationName = normalizeLiveText(candidateName || nombre, LIVE_DESTINATION_MAX_LENGTH);
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
    candidateName: destinationName,
  };
}

/** Every spelling a troncal lookup tries, the caller's candidates first. Never empty. */
export function buildLiveNameCandidates(nombre: string, nombreCandidates: string[] = []): string[] {
  const candidates: string[] = [];
  for (const value of [...nombreCandidates, nombre]) {
    addUniqueLiveName(candidates, normalizeLiveText(value, LIVE_DESTINATION_MAX_LENGTH));
  }
  return (candidates.length > 0 ? candidates : ['']).slice(0, LIVE_NAME_CANDIDATE_LIMIT);
}

/** A route variant, as far as its live names go (the catalog's own shape). */
export interface LiveNameSource {
  nombre?: string;
  origin?: string;
  destination?: string;
  stops?: Array<{ nombre?: string }>;
}

/** A variant's live-query names, destination first (spec §5.2.4). */
export function variantLiveNames(variant: LiveNameSource): string[] {
  const out: string[] = [];
  const stops = variant.stops ?? [];
  const values = [variant.destination, variant.nombre, variant.origin, stops[stops.length - 1]?.nombre, stops[0]?.nombre];
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && !out.some((name) => name.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
}

/**
 * Of the names a caller sent, the ones the catalog files this route under.
 *
 * `/api/buses` forwards a name as written and shares one answer per set of
 * names, so a made-up name was both upstream traffic and a way around the
 * share: a valid route with random names fired up to twelve requests a call
 * (spec §3.4). A name the catalog does not know is dropped, never refused — a
 * request left with none asks with an empty name, which the live host answers
 * with both directions.
 */
export function keepKnownLiveNames(names: string[], variants: LiveNameSource[]): string[] {
  const known: string[] = [];
  for (const variant of variants) {
    for (const name of variantLiveNames(variant)) {
      addUniqueLiveName(known, normalizeLiveText(name, LIVE_DESTINATION_MAX_LENGTH));
    }
  }
  const allowed = new Set(known.map((name) => name.toLowerCase()));
  return names.filter((name) => allowed.has(name.toLowerCase()));
}

// ─── How it is asked ──────────────────────────────────────

/**
 * The header set for a live-host request (spec §5.2.3 / §5.5.1a). The app
 * identity itself lives in `official_app_headers.ts`. `Content-Type` is omitted
 * for a bodyless request (zonal `/location/ruta`).
 */
export function buildLiveApiHeaders(postData: string): Record<string, string | number> {
  const headers: Record<string, string | number> = {
    'Accept-Encoding': 'identity',
    ...LIVE_HOST_HEADERS,
    'Connection': 'Keep-Alive',
    'Host': LIVE_API_HOST,
    'Content-Length': Buffer.byteLength(postData),
  };
  if (postData) headers['Content-Type'] = 'application/json; charset=UTF-8';
  return headers;
}

type LiveParser = (raw: Buffer, encoding: string | string[] | undefined, source: string) => Promise<any[]>;

/** Shared decode + JSON + upstream-error handling for any live-host endpoint.
 *  The `normalize` step is what differs (buses vs arrivals). */
export async function parseLivePayload(
  raw: Buffer,
  encoding: string | string[] | undefined,
  source: string,
  normalize: (payload: any) => any[]
): Promise<any[]> {
  const body = await decodeBody(raw, encoding).catch(() => raw);
  const text = body.toString('utf-8');

  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${source}: Live JSON parse error (${text.slice(0, 120)})`);
  }

  if (payload?.success === false) {
    throw new Error(`${source}: ${payload.error || 'Proxy returned success=false'}`);
  }

  const problemStatus = Number(payload?.status);
  if (Number.isFinite(problemStatus) && problemStatus >= 400) {
    throw new Error(`${source}: Status: ${problemStatus} ${payload.title || payload.detail || ''}`.trim());
  }

  return normalize(payload);
}

const parseLiveBuses: LiveParser = (raw, encoding, source) =>
  parseLivePayload(raw, encoding, source, (payload) => findBusPayloadArray(payload) ?? []);

export function requestLiveJson(
  url: URL,
  headers: Record<string, string | number>,
  postData: string,
  timeoutMs: number,
  agent?: http.Agent,
  signal?: AbortSignal,
  parse: LiveParser = parseLiveBuses
): Promise<any[]> {
  const requestLib = url.protocol === 'http:' ? http : https;
  const source = `${url.protocol}//${url.hostname}${url.pathname}`;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${source}: aborted`));
      return;
    }

    const req = requestLib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      agent,
      timeout: timeoutMs,
    }, (res) => {
      // Bounded read + `error` listener live in one place (upstream_body.ts):
      // the transport may be an untrusted free proxy (spec §5.2.5).
      collectBody(res, source).then(
        async (raw) => {
          cleanup();
          if (res.statusCode !== 200) {
            reject(new Error(`${source}: Status: ${res.statusCode}`));
            return;
          }
          try {
            resolve(await parse(raw, res.headers['content-encoding'], source));
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
    });

    // Let a parallel race cancel the losers as soon as a winner resolves.
    const onAbort = () => {
      req.destroy(new Error(`${source}: aborted`));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
    req.on('timeout', () => {
      cleanup();
      req.destroy();
      reject(new Error(`${source}: Request timed out`));
    });

    if (postData) req.write(postData);
    req.end();
  });
}

/** One live-bus request for `context`, straight to the live host (optionally through `agent`). */
export function requestLiveBuses(
  context: LiveRequestContext,
  timeoutMs: number,
  agent?: http.Agent,
  signal?: AbortSignal
): Promise<any[]> {
  const url = new URL(`${LIVE_API_ORIGIN}${context.targetPath}`);
  return requestLiveJson(url, buildLiveApiHeaders(context.postData), context.postData, timeoutMs, agent, signal);
}

// ─── The candidate race ───────────────────────────────────

/**
 * Asks every candidate **in parallel** and resolves the MOMENT one returns
 * buses, aborting the stragglers — waiting for every candidate to settle would
 * pin the response to the slowest one (the live host answers anywhere between
 * 0.3 s and its 9 s timeout), which lands squarely on the first fix of a
 * tracking session.
 *
 * A valid empty result needs every candidate to have settled, since only a
 * non-empty hit proves the name matched. `null` means no candidate answered at
 * all; each failure is handed to `onError`.
 */
export function raceLiveCandidates<C>(
  contexts: C[],
  fetcher: (context: C, signal: AbortSignal) => Promise<any[]>,
  options: { signal?: AbortSignal; onHit?: (context: C) => void; onError?: (context: C, error: any) => void } = {}
): Promise<any[] | null> {
  if (contexts.length === 0) return Promise.resolve(null);

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onParentAbort, { once: true });

  let pending = contexts.length;
  let emptyResult: any[] | null = null;

  return new Promise<any[] | null>((resolve) => {
    const settle = (value: any[] | null) => {
      controller.abort(); // cancel the stragglers
      options.signal?.removeEventListener('abort', onParentAbort);
      resolve(value);
    };

    for (const context of contexts) {
      fetcher(context, controller.signal).then(
        (buses) => {
          if (buses.length > 0) {
            options.onHit?.(context);
            settle(buses);
            return;
          }
          emptyResult = buses;
          if (--pending === 0) settle(emptyResult);
        },
        (error: any) => {
          options.onError?.(context, error);
          if (--pending === 0) settle(emptyResult);
        }
      );
    }
  });
}

// ─── The relay's generic forwarder ────────────────────────

/**
 * The live-host paths the relay forwards as they are, and the verb each takes
 * (spec §5.2.2a). Matched exactly: a relay is a controlled forwarder, never an
 * open proxy, and a `startsWith` on a path authorizes everything under it.
 */
const FORWARD_PATHS: Record<string, 'GET' | 'POST'> = {
  '/lectura_tarjeta': 'POST',
  '/puntos_recarga': 'GET',
  '/puntos_personalizacion': 'GET',
};

/** Whether the relay may forward `method path` to the live host. */
export function isForwardAllowed(path: unknown, method: unknown): boolean {
  return typeof path === 'string' && Object.hasOwn(FORWARD_PATHS, path) && FORWARD_PATHS[path] === method;
}
