/**
 * Native Live client (Capacitor)
 *
 * Inside the Android app (see `mobile/`), HTTP requests can be issued through
 * Capacitor's native `CapacitorHttp` plugin instead of the webview `fetch`.
 * Native requests are not subject to browser CORS and leave from the device's
 * own connection — so on a phone with a Colombian IP the live API's two
 * constraints (CO-only geofence + no CORS, spec §5.2.1) are both satisfied with
 * no relay, proxy, or extension in the path. This is the mobile twin of the
 * Live Bridge extension (`liveBridge.ts`).
 *
 * In a regular browser (no Capacitor) every export is a cheap no-op/false and
 * the caller falls through to the existing tiers (see `services/api.ts`).
 */

import { findBusPayloadArray } from '../utils/liveBus';

const LIVE_HOST = 'https://tmsa-transmiapp-shvpc.uc.r.appspot.com';
const APPID = '9a2c3b48f0c24ae9bfba38e94f27c3ea';
const REQUEST_TIMEOUT_MS = 9_000;

interface NativeHttpResponse {
  status: number;
  data: unknown;
}

interface NativeHttpPlugin {
  request(options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
  }): Promise<NativeHttpResponse>;
}

/** The CapacitorHttp core plugin, or null when not running inside the native app. */
function getNativeHttp(): NativeHttpPlugin | null {
  const cap = (window as any).Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  const http = cap.Plugins?.CapacitorHttp;
  return http && typeof http.request === 'function' ? (http as NativeHttpPlugin) : null;
}

export function isNativeLiveAvailable(): boolean {
  return typeof window !== 'undefined' && getNativeHttp() !== null;
}

/**
 * Issue any app API request through the native HTTP layer. Returns null when
 * not running natively so `api.ts` can keep its normal web `fetch` path; the
 * caller maps non-2xx statuses to its own error type. Bypassing webview CORS
 * here means the hosted API needs no origin allow-list entry for the app.
 */
export async function nativeJsonRequest(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<NativeHttpResponse | null> {
  const http = getNativeHttp();
  if (!http) return null;

  const headers: Record<string, string> = {};
  if (init?.headers) {
    for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
      headers[key] = value;
    }
  }
  return http.request({
    method: init?.method || 'GET',
    url,
    headers,
    data: typeof init?.body === 'string' ? init.body : undefined,
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
  });
}

/** One POST to the live host; unwraps the payload into a flat bus array. */
async function fetchLiveOnce(http: NativeHttpPlugin, path: string, body: unknown): Promise<unknown[]> {
  const headers: Record<string, string> = { Appid: APPID };
  if (body != null) headers['Content-Type'] = 'application/json; charset=UTF-8';

  const res = await http.request({
    method: 'POST',
    url: LIVE_HOST + path,
    headers,
    data: body ?? undefined,
    connectTimeout: REQUEST_TIMEOUT_MS,
    readTimeout: REQUEST_TIMEOUT_MS,
  });
  if (res.status >= 400) throw new Error(`Live API status ${res.status}`);

  let json: any = res.data;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      throw new Error('Live API returned non-JSON body');
    }
  }
  if (json && json.success === false) throw new Error(json.error || 'Live API success=false');
  const status = Number(json && json.status);
  if (Number.isFinite(status) && status >= 400) {
    throw new Error(`Status ${status} ${(json && (json.title || json.detail)) || ''}`.trim());
  }
  return findBusPayloadArray(json) ?? [];
}

/**
 * Live buses straight from the device. Troncal tries each destination-name
 * candidate until one returns buses (a wrong name returns empty, not an error —
 * spec §5.2.4); zonal is keyed purely by route code with an empty body. Mirrors
 * the extension worker's loop (`extension/background.js`).
 */
export async function fetchLiveBusesViaNative(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal',
  candidates: string[]
): Promise<unknown[]> {
  const http = getNativeHttp();
  if (!http) throw new Error('Native HTTP unavailable');

  const code = String(ruta || '').trim();
  if (!code) throw new Error('ruta is required');

  if (routeType === 'zonal') {
    return fetchLiveOnce(http, `/location/ruta?ruta=${encodeURIComponent(code)}`, null);
  }

  const names = (candidates.length ? candidates : [nombre])
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  const tried = names.length ? names : [''];

  let lastEmpty: unknown[] = [];
  let lastError: unknown = null;
  for (const name of tried) {
    try {
      const buses = await fetchLiveOnce(http, '/buses', { ruta: code, Nombre: name });
      if (buses.length) return buses;
      lastEmpty = buses;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError && !lastEmpty.length) throw lastError;
  return lastEmpty;
}
