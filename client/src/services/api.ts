import type {
  ApiResponse,
  TroncalCorridorFeature,
  TroncalRouteFeature,
  TroncalStationFeature,
} from '../types/transmilenio';
import type { MasterCatalogResponse } from '../types/catalog';
import { isLiveBridgeReady, probeLiveBridge, fetchLiveBusesViaBridge } from './liveBridge';
import { isNativeLiveAvailable, fetchLiveBusesViaNative, nativeJsonRequest } from './nativeLive';
import { officialApi } from './officialApi';
import { findBusPayloadArray } from '../utils/liveBus';

/** Honest, mutually-exclusive live-tracking outcomes (spec §4 / §5.2.5):
 *  - live        buses are present.
 *  - no-buses    a Colombian egress (extension/relay) verified zero buses — trustworthy.
 *  - unverified  a free public proxy returned empty — low confidence, NOT "no buses".
 *  - stale       upstream silent; showing the last real fix (see `asOf`).
 *  - unreachable no transport reached the live API and no cache exists. */
export type LiveStatus = 'live' | 'no-buses' | 'unverified' | 'stale' | 'unreachable';

export interface LiveBusResult {
  status: LiveStatus;
  confidence: 'high' | 'low';
  data: any[];
  source: string | null;
  asOf?: number;
}

/** Wrap a high-confidence CO-egress payload (extension/relay-direct): a non-empty
 *  list is `live`, an empty one is a verified `no-buses`. */
function wrapHighConfidence(raw: unknown, source: string): LiveBusResult {
  const data = (findBusPayloadArray(raw) ?? []) as any[];
  return {
    status: data.length > 0 ? 'live' : 'no-buses',
    confidence: 'high',
    data,
    source,
  };
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
// Optional Colombia relay the browser calls directly (PC + mobile, no install):
// browser → CO relay → live API, keeping the main server out of the live path.
const LIVE_RELAY_URL = String(import.meta.env.VITE_LIVE_RELAY_URL || '').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 60_000;
const LIVE_TRACKING_TIMEOUT_MS = 15_000;
const MASTER_CATALOG_TIMEOUT_MS = 300_000; // 5m for the heavy catalog

const MAX_RETRIES = 4;
const INITIAL_RETRY_DELAY_MS = 2_000;  // 2s, then 4s, 8s, 16s

export class ApiError extends Error {
  constructor(
    public readonly endpoint: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    const status = error.status;
    // No status means the request never got an HTTP response (fetch failed,
    // timeout, connection reset) — transient by nature, retry it.
    if (status === undefined) return true;
    // 502, 503, 504 are all server-side transient errors (cold start, overload, timeout)
    return status === 502 || status === 503 || status === 504;
  }
  // Network errors (fetch failed, aborted, etc.) are also retryable
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonOnce<T>(
  endpoint: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  init?: RequestInit
): Promise<T> {
  // Inside the Android app (mobile/) the request goes through the native HTTP
  // layer: no webview CORS, so the hosted API needs no allow-list entry for the
  // app's local origin. Returns null in a regular browser.
  const native = await nativeJsonRequest(`${API_BASE}${endpoint}`, init, timeoutMs).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(endpoint, `No se pudo conectar con ${API_BASE}: ${message}`);
  });
  if (native) {
    if (native.status < 200 || native.status >= 300) {
      throw new ApiError(endpoint, `API ${native.status}.`, native.status);
    }
    if (typeof native.data === 'string') {
      try {
        return JSON.parse(native.data) as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ApiError(endpoint, `Respuesta JSON invalida desde ${endpoint}: ${message}`, native.status);
      }
    }
    return native.data as T;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body ? ` ${body.slice(0, 180)}` : '';
      throw new ApiError(endpoint, `API ${response.status} ${response.statusText}.${detail}`, response.status);
    }
    try {
      return await response.json();
    } catch (error) {
      // If it's an abort error that happened during body reading, handle it specifically
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError(endpoint, `Respuesta JSON invalida desde ${endpoint}: ${message}`, response.status);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const isAbort = (error instanceof DOMException && error.name === 'AbortError') || message.toLowerCase().includes('aborted');
    throw new ApiError(
      endpoint,
      isAbort
        ? `La API no respondió dentro del tiempo límite (${timeoutMs / 1000}s): ${endpoint}`
        : `No se pudo conectar con ${API_BASE}: ${message}`
    );
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchJson<T>(
  endpoint: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchJsonOnce<T>(endpoint, timeoutMs, init);
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries && isRetryable(error)) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        const status = error instanceof ApiError ? error.status : 'network';
        console.warn(
          `[API] ${endpoint} failed (${status}), retry ${attempt + 1}/${maxRetries} in ${delay}ms...`
        );
        await sleep(delay);
      } else {
        break;
      }
    }
  }

  throw lastError;
}

/**
 * POSTs a live-bus request straight to the configured Colombia relay
 * (`VITE_LIVE_RELAY_URL`). The relay adds CORS and egresses from a Colombian IP,
 * so this works from any browser (PC or mobile) with no extension. Throws on
 * non-2xx or network error so the caller can fall back to the main server.
 */
async function postLiveRelayDirect(payload: unknown): Promise<any> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), LIVE_TRACKING_TIMEOUT_MS);
  try {
    const response = await fetch(`${LIVE_RELAY_URL}/buses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiError('/buses (relay)', `Relay ${response.status} ${response.statusText}`, response.status);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * Runs the tiered live-bus cascade once: native app → Live Bridge extension →
 * direct CO relay → main server relay (spec §5.2.1a). NEVER throws — every
 * outcome, including total failure, comes back as a typed {@link LiveBusResult}
 * so the caller can tell a silent upstream from a genuine absence of buses.
 */
async function requestLiveBuses(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal',
  nombreCandidates: string[]
): Promise<LiveBusResult> {
  const payload = { ruta, Nombre: nombre, nombreCandidates, type: routeType };

  // Tier 0: native app (Capacitor) — the device itself calls the live API.
  // Native HTTP ignores CORS and carries the phone's own (Colombian) IP, so
  // no relay, proxy, or extension is involved (spec §5.2.1a, mobile twin).
  if (isNativeLiveAvailable()) {
    try {
      return wrapHighConfidence(await fetchLiveBusesViaNative(ruta, nombre, routeType, nombreCandidates), 'native');
    } catch (error) {
      console.warn('[Live] Native direct failed, trying next tier:', error);
    }
  }

  // Tier 1: Live Bridge extension — fetches from the user's own Colombian
  // connection, bypassing the geofence and browser CORS with no relay load.
  // Availability is read from cache (the extension announces itself at
  // document_start); probing here would add its 600 ms ping timeout to the
  // cold start of every user who has no extension.
  if (isLiveBridgeReady()) {
    try {
      return wrapHighConfidence(await fetchLiveBusesViaBridge(ruta, nombre, routeType, nombreCandidates), 'extension');
    } catch (error) {
      console.warn('[Live] Bridge failed, trying direct relay:', error);
    }
  } else {
    probeLiveBridge(); // settle availability in the background for the next poll
  }

  // Tier 2: Colombia relay called directly (PC + mobile, no install).
  if (LIVE_RELAY_URL) {
    try {
      return wrapHighConfidence(await postLiveRelayDirect(payload), 'co-relay');
    } catch (error) {
      console.warn('[Live] Direct relay failed, falling back to server:', error);
    }
  }

  // Tier 3: main server relay (spec §4.2). 0 retries — live requests must not
  // stack up behind the 15s polling window (spec §3.4). The server endpoint
  // itself never hard-fails and already returns a {status,...} envelope.
  try {
    const res = await fetchJson<any>('/buses', LIVE_TRACKING_TIMEOUT_MS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }, 0);
    if (res && typeof res.status === 'string') {
      return {
        status: res.status as LiveStatus,
        confidence: res.confidence === 'high' ? 'high' : 'low',
        data: Array.isArray(res.data) ? res.data : [],
        source: res.source ?? 'server',
        asOf: typeof res.asOf === 'number' ? res.asOf : undefined,
      };
    }
    // Unexpected shape — treat as a reached-but-unverifiable response.
    return { status: 'unverified', confidence: 'low', data: [], source: 'server' };
  } catch (error) {
    // Total cascade failure: report it honestly instead of throwing, so the UI
    // shows "reintentando" rather than asserting there are no buses.
    console.warn('[Live] All live tiers failed:', error);
    return { status: 'unreachable', confidence: 'low', data: [], source: null };
  }
}

/**
 * Live-request de-duplication window.
 *
 * Selecting a route kicks off a live fetch immediately ({@link prefetchLiveBuses})
 * while the route detail, the 3D bus layer and the map work are still loading;
 * the tracking layer's first poll then lands on the SAME in-flight request
 * instead of starting a second one. A just-settled result is reused for a short
 * window for the same reason. Well under the 15 s polling interval (spec §3.4),
 * so a real poll is never served from here.
 */
const LIVE_REUSE_MS = 5_000;

interface PendingLive {
  key: string;
  promise: Promise<LiveBusResult>;
  settledAt: number | null;
}
let pendingLive: PendingLive | null = null;

/** Identity of a live request. The name candidates are part of it: a request
 *  made with a shorter candidate list is NOT the same request (a missing
 *  candidate can be the one that matches upstream, spec §5.2.4), so a prefetch
 *  fired before the route detail loaded is only reused when the tracking layer
 *  ends up asking for exactly the same thing. */
function liveKey(routeType: 'troncal' | 'zonal', ruta: string, nombre: string, candidates: string[]): string {
  return `${routeType}:${ruta}|${nombre}|${candidates.join('|')}`;
}

function startLiveRequest(
  key: string,
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal',
  nombreCandidates: string[]
): Promise<LiveBusResult> {
  const entry: PendingLive = {
    key,
    settledAt: null,
    promise: requestLiveBuses(ruta, nombre, routeType, nombreCandidates).then((result) => {
      entry.settledAt = Date.now();
      return result;
    }),
  };
  pendingLive = entry;
  return entry.promise;
}

/** The in-flight (or just-settled) request for this route, if it can be shared.
 *  `inFlightOnly` drops the settled-result window, so a caller that explicitly
 *  wants new data never gets an already-delivered one. */
function reusableLiveRequest(key: string, inFlightOnly = false): Promise<LiveBusResult> | null {
  const entry = pendingLive;
  if (!entry || entry.key !== key) return null;
  if (entry.settledAt === null) return entry.promise; // still in flight
  if (inFlightOnly) return null;
  return Date.now() - entry.settledAt < LIVE_REUSE_MS ? entry.promise : null;
}

/**
 * Start the live fetch for a route NOW, without waiting for the caller to be
 * ready to render it. Fire-and-forget: the result is picked up by the next
 * {@link api.getLiveBuses} for the same route, so the tracking layer's first
 * poll resolves against a request that has been running the whole time the UI
 * was loading. Safe to call repeatedly — an in-flight request is not duplicated.
 */
export function prefetchLiveBuses(
  ruta: string,
  nombre: string,
  routeType: 'troncal' | 'zonal' = 'troncal',
  nombreCandidates: string[] = []
): void {
  if (!ruta) return;
  const key = liveKey(routeType, ruta, nombre, nombreCandidates);
  if (reusableLiveRequest(key)) return;
  void startLiveRequest(key, ruta, nombre, routeType, nombreCandidates);
}

export const api = {
  // Inside the Android app the data-layer requests hit the official government /
  // public hosts DIRECTLY via native HTTP (spec §5.2.1b) — no web server in the
  // path. The browser client keeps calling our `/api/*` backend. Each method
  // below routes on `isNativeLiveAvailable()`; the two clients share this one
  // module so they never drift (spec §1.1 R2). ArcGIS/arrivals/card/walking have
  // official-host equivalents (below); the catalog + POI/demand datasets have no
  // single official endpoint and are read from APK-bundled assets instead
  // (`client/mobile/src/data.ts`).
  getTroncalRoutes: () =>
    isNativeLiveAvailable()
      ? officialApi.getTroncalRoutes()
      : fetchJson<ApiResponse<TroncalRouteFeature>>('/troncal/routes'),

  getTroncalStations: () =>
    fetchJson<ApiResponse<TroncalStationFeature>>('/troncal/stations'),

  getTroncalCorridors: () =>
    isNativeLiveAvailable()
      ? officialApi.getTroncalCorridors()
      : fetchJson<ApiResponse<TroncalCorridorFeature>>('/troncal/corridors'),

  getZonalRoutes: () =>
    isNativeLiveAvailable()
      ? officialApi.getZonalRoutes()
      : fetchJson<ApiResponse<any>>('/zonal/routes'),

  getZonalStops: () =>
    isNativeLiveAvailable()
      ? officialApi.getZonalStops()
      : fetchJson<ApiResponse<any>>('/zonal/stops'),

  getZonalStopRoutes: () =>
    isNativeLiveAvailable()
      ? officialApi.getZonalStopRoutes()
      : fetchJson<ApiResponse<any>>('/zonal/stop-routes'),

  getCableStations: () =>
    isNativeLiveAvailable()
      ? officialApi.getCableStations()
      : fetchJson<ApiResponse<any>>('/cable/stations'),

  getCableTrazado: () =>
    isNativeLiveAvailable()
      ? officialApi.getCableTrazado()
      : fetchJson<ApiResponse<any>>('/cable/trazado'),

  getMasterCatalog: () =>
    fetchJson<MasterCatalogResponse>('/troncal/master-catalog', MASTER_CATALOG_TIMEOUT_MS),

  getRouteDetail: (code: string) =>
    fetchJson<any>(`/troncal/route/${encodeURIComponent(code)}`),

  readCardBalance: (numeroTarjeta: string, consultar: 'true' | 'false' = 'false') =>
    isNativeLiveAvailable()
      ? officialApi.readCardBalance(numeroTarjeta, consultar)
      : fetchJson<CardBalanceResponse>('/card/read', 15_000, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ numero_tarjeta: numeroTarjeta, consultar }),
        }, 0),

  /**
   * Resolve live buses through the tiered cascade, always returning a structured
   * {@link LiveBusResult} — it NEVER throws (spec §4: "a request never fails
   * again"). When no tier reaches upstream the result is `unreachable`, so the
   * caller distinguishes a silent API from a genuine absence of buses.
   *
   * Shares an already-running {@link prefetchLiveBuses} request for the same
   * route so the first poll of a tracking session doesn't restart work that is
   * already in flight.
   */
  getLiveBuses: (
    ruta: string,
    nombre: string,
    routeType: 'troncal' | 'zonal' = 'troncal',
    nombreCandidates: string[] = [],
    options: { fresh?: boolean } = {}
  ): Promise<LiveBusResult> => {
    const key = liveKey(routeType, ruta, nombre, nombreCandidates);
    // `fresh` (manual refresh button) skips a settled result — the user asked
    // for new data — but still joins a request that is already in flight.
    const shared = reusableLiveRequest(key, options.fresh === true);
    return shared ?? startLiveRequest(key, ruta, nombre, routeType, nombreCandidates);
  },

  /** Approximate location from the client IP — fallback when native geolocation is blocked. */
  getGeoIp: () =>
    fetchJson<GeoIpResponse>('/geoip', 8_000, undefined, 1),

  /** Query Bogotá-bounded geocoding API. */
  geocodeAddress: (q: string) =>
    fetchJson<any>(`/geocode?q=${encodeURIComponent(q)}`, 8_000, undefined, 1),

  getWalkingRoute: (from: [number, number], to: [number, number]) =>
    isNativeLiveAvailable()
      ? officialApi.getWalkingRoute(from, to)
      : fetchJson<WalkingRouteResponse>(
          `/walking-route?from=${encodeURIComponent(from.join(','))}&to=${encodeURIComponent(to.join(','))}`,
          10_000,
          undefined,
          1
        ),

  /** tullave recharge-point POIs (static catalog, spec §5.8). */
  getRechargePoints: () => fetchJson<RechargePointsResponse>('/recarga-points', 15_000, undefined, 1),

  /** Per-station mean weekday demand from the open Salidas dataset (spec §5.8). */
  getStationDemand: () => fetchJson<StationDemandResponse>('/station-demand', 15_000, undefined, 1),

  /** TransMiBici bike-parking POIs (static catalog, spec §5.3). */
  getTransmibici: () => fetchJson<TransmibiciResponse>('/transmibici', 15_000, undefined, 1),

  /** Real-time arrivals/ETAs at a paradero (spec §5.8). Never hard-fails.
   *  15 s (not 12 s) so prod's proxy-fallback budget (~14.5 s) isn't cut off;
   *  0 retries — live requests must not stack (spec §3.4). */
  getArrivals: (paradero: string) =>
    isNativeLiveAvailable()
      ? officialApi.getArrivals(paradero)
      : fetchJson<ArrivalsResponse>('/arrivals', 15_000, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paradero }),
        }, 0),

  /** Global per-route ETA for any stop (paradero or estación), computed from
   *  live bus positions projected onto each serving route's trace (spec §5.8).
   *  Works for both TM…-coded estaciones and zonal cenefas. Never hard-fails. */
  getStopArrivals: (code: string) =>
    isNativeLiveAvailable()
      ? officialApi.getStopArrivals(code)
      : fetchJson<StopArrivalsResponse>('/stop-arrivals', 16_000, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        }, 0),
};

export interface StopArrival {
  codigo: string;
  destino: string;
  color: string;
  type: 'troncal' | 'zonal';
  etaMinutes: number;
  distanceMeters: number;
  busCount: number;
}
export interface StopArrivalsResponse {
  success: boolean;
  count?: number;
  routesServing?: number;
  arrivals?: StopArrival[];
  error?: string;
}

export interface ArrivalItem {
  codigo: string;
  idRuta: string;
  destino: string;
  color: string;
  paradero: string;
  tiempo: string;
  distancia: string;
}
export interface ArrivalsResponse {
  success: boolean;
  count?: number;
  arrivals?: ArrivalItem[];
  source?: string | null;
  error?: string;
}

export interface RechargePoint {
  nombre: string;
  direccion: string;
  localidad: string;
  latitud: number;
  longitud: number;
  hds?: string;
  exs?: string;
  wks?: string;
}
export interface RechargePointsResponse {
  success: boolean;
  count?: number;
  points?: RechargePoint[];
  error?: string;
}

export interface StationDemand {
  codigo: string;
  nodo: number | null;
  nombre: string;
  lat: number;
  lon: number;
  entradas: number;
  salidas: number;
  total: number;
  rank: number;
}
export interface StationDemandResponse {
  success: boolean;
  days?: number;
  window?: { from: string; to: string } | null;
  count?: number;
  stations?: StationDemand[];
  error?: string;
}

export interface BikeParking {
  nombre: string;
  nodo: number | null;
  cupos: number | null;
  ocupacion: number | null;
  lat: number;
  lon: number;
}
export interface TransmibiciResponse {
  success: boolean;
  count?: number;
  points?: BikeParking[];
  error?: string;
}

export interface GeoIpResponse {
  success: boolean;
  source?: string;
  latitude?: number;
  longitude?: number;
  city?: string;
  error?: string;
}

export interface WalkingRouteResult {
  coordinates: [number, number][];
  distance: number;
  time: number;
  source: 'osrm';
}

export interface WalkingRouteResponse {
  success: boolean;
  data?: WalkingRouteResult;
  error?: string;
}

export interface CardBalanceMovement {
  source: 'server' | 'card';
  numeroTarjeta: string;
  type: string;
  amount?: string;
  finalBalance?: string;
  occurredAt?: string;
}

export interface CardBalanceRead {
  numeroTarjeta: string;
  consultar: 'true' | 'false';
  balance?: string;
  balanceSource?: 'server' | 'card';
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

export interface CardBalanceResponse {
  success: boolean;
  data?: CardBalanceRead;
  error?: string;
}
