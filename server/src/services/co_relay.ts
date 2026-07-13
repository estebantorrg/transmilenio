/**
 * Colombia relay client — talks to the OCI Function (Bogotá egress) fronted by
 * an API Gateway. The relay exposes a generic, allowlisted forwarder that reaches
 * the CO-IP-geofenced TransMi live host from a reliable Colombian IP, replacing
 * the flaky free public proxy pool for every geofenced endpoint (live buses,
 * arrivals, card balance).
 *
 * Configure with `TRANSMILENIO_COLOMBIA_RELAY_URL` (the gateway deployment base,
 * e.g. https://<gw>.apigateway.<region>.oci.customer-oci.com/relay) and
 * `TRANSMILENIO_COLOMBIA_RELAY_SECRET` (shared Bearer, also set as the Function's
 * RELAY_SECRET config). See server/src/services/tm_api.ts for the live-bus tier.
 */

import http from 'http';
import https from 'https';

const DEFAULT_TIMEOUT_MS = 12_000;

function relayBaseUrl(): string {
  return String(process.env.TRANSMILENIO_COLOMBIA_RELAY_URL || '').trim();
}

function relaySecret(): string {
  return String(process.env.TRANSMILENIO_COLOMBIA_RELAY_SECRET || '').trim();
}

export function isColombiaRelayConfigured(): boolean {
  return relayBaseUrl().length > 0;
}

export interface RelayForwardResult {
  /** HTTP status the relay got back from the upstream TransMi host. */
  upstreamStatus: number;
  /** Parsed upstream JSON (or raw text when the body was not JSON). */
  payload: any;
}

/**
 * Forwards a request to an allowlisted TransMi live-host path through the CO
 * relay and returns the upstream status + parsed payload. Rejects on transport
 * failure or a non-2xx *relay* response (a non-200 *upstream* status is not an
 * error here — it surfaces via `upstreamStatus` so the caller decides).
 */
export function relayForward(
  path: string,
  body: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<RelayForwardResult> {
  const base = relayBaseUrl();
  if (!base) {
    return Promise.reject(new Error('Colombia relay not configured (TRANSMILENIO_COLOMBIA_RELAY_URL)'));
  }

  const url = new URL(`${base.replace(/\/$/, '')}/forward`);
  const postData = JSON.stringify({ path, method: 'POST', body });
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Accept-Encoding': 'identity',
    'Content-Length': Buffer.byteLength(postData),
  };
  const secret = relaySecret();
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const requestLib = url.protocol === 'http:' ? http : https;
  const source = `${url.origin}${url.pathname} (relay→${path})`;

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
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        cleanup();
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode !== 200) {
          reject(new Error(`${source}: relay status ${res.statusCode}`));
          return;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          reject(new Error(`${source}: relay JSON parse error (${text.slice(0, 120)})`));
          return;
        }
        resolve({
          upstreamStatus: Number(parsed?.upstreamStatus ?? 0),
          payload: parsed?.payload,
        });
      });
    });

    const onAbort = () => req.destroy(new Error(`${source}: aborted`));
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (err) => { cleanup(); reject(err); });
    req.on('timeout', () => { cleanup(); req.destroy(); reject(new Error(`${source}: timed out`)); });
    req.write(postData);
    req.end();
  });
}
