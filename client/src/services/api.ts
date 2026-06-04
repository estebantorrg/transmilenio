import type {
  ApiResponse,
  TroncalCorridorFeature,
  TroncalRouteFeature,
  TroncalStationFeature,
} from '../types/transmilenio';
import type { MasterCatalogResponse } from '../types/catalog';
import { isLiveBridgeAvailable, fetchLiveBusesViaBridge } from './liveBridge';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
// Optional Colombia relay the browser calls directly (PC + mobile, no install):
// browser → CO relay → live API, keeping the main server out of the live path.
const LIVE_RELAY_URL = String(import.meta.env.VITE_LIVE_RELAY_URL || '').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 60_000;
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
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

export const api = {
  getTroncalRoutes: () =>
    fetchJson<ApiResponse<TroncalRouteFeature>>('/troncal/routes'),

  getTroncalStations: () =>
    fetchJson<ApiResponse<TroncalStationFeature>>('/troncal/stations'),

  getTroncalCorridors: () =>
    fetchJson<ApiResponse<TroncalCorridorFeature>>('/troncal/corridors'),

  getZonalStops: () =>
    fetchJson<ApiResponse<any>>('/zonal/stops'),

  getZonalStopRoutes: () =>
    fetchJson<ApiResponse<any>>('/zonal/stop-routes'),

  getMasterCatalog: () =>
    fetchJson<MasterCatalogResponse>('/troncal/master-catalog', MASTER_CATALOG_TIMEOUT_MS),

  getRouteDetail: (code: string) =>
    fetchJson<any>(`/troncal/route/${code}`),

  getLiveBuses: async (
    ruta: string,
    nombre: string,
    routeType: 'troncal' | 'zonal' = 'troncal',
    nombreCandidates: string[] = []
  ): Promise<any> => {
    const payload = { ruta, Nombre: nombre, nombreCandidates, type: routeType };

    // Tier 1: Live Bridge extension — fetches from the user's own Colombian
    // connection, bypassing the geofence and browser CORS with no relay load.
    if (await isLiveBridgeAvailable()) {
      try {
        return await fetchLiveBusesViaBridge(ruta, nombre, routeType, nombreCandidates);
      } catch (error) {
        console.warn('[Live] Bridge failed, trying direct relay:', error);
      }
    }

    // Tier 2: Colombia relay called directly (PC + mobile, no install).
    if (LIVE_RELAY_URL) {
      try {
        return await postLiveRelayDirect(payload);
      } catch (error) {
        console.warn('[Live] Direct relay failed, falling back to server:', error);
      }
    }

    // Tier 3: main server relay (spec §4.2 graceful degradation). 0 retries — live
    // requests must not stack up behind the 15s polling window (spec §3.4).
    return fetchJson<any>('/buses', REQUEST_TIMEOUT_MS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }, 0);
  },

  /** Approximate location from the client IP — fallback when native geolocation is blocked. */
  getGeoIp: () =>
    fetchJson<GeoIpResponse>('/geoip', 8_000, undefined, 1),
};

export interface GeoIpResponse {
  success: boolean;
  source?: string;
  latitude?: number;
  longitude?: number;
  city?: string;
  error?: string;
}
