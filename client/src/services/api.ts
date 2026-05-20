/**
 * HTTP client for the backend proxy API.
 *
 * Includes automatic retry with exponential backoff to handle
 * Render free-tier cold starts (server sleeps after inactivity
 * and returns 502 for ~30s while waking up).
 */

import type {
  ApiResponse,
  TroncalCorridorFeature,
  TroncalRouteFeature,
  TroncalStationFeature,
} from '../types/transmilenio';
import type { MasterCatalogResponse } from '../types/catalog';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 60_000;  // 60s to accommodate cold starts
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

async function fetchJsonOnce<T>(endpoint: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body ? ` ${body.slice(0, 180)}` : '';
      throw new ApiError(endpoint, `API ${response.status} ${response.statusText}.${detail}`, response.status);
    }
    try {
      return await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError(endpoint, `Respuesta JSON invalida desde ${endpoint}: ${message}`, response.status);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    throw new ApiError(
      endpoint,
      isAbort
        ? `La API no respondió después de ${REQUEST_TIMEOUT_MS / 1000}s: ${endpoint}`
        : `No se pudo conectar con ${API_BASE}: ${message}`
    );
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchJson<T>(endpoint: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchJsonOnce<T>(endpoint);
    } catch (error) {
      lastError = error;

      if (attempt < MAX_RETRIES && isRetryable(error)) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        const status = error instanceof ApiError ? error.status : 'network';
        console.warn(
          `[API] ${endpoint} failed (${status}), retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms...`
        );
        await sleep(delay);
      } else {
        break;
      }
    }
  }

  throw lastError;
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
    fetchJson<MasterCatalogResponse>('/troncal/master-catalog'),
};
