/**
 * HTTP client for the backend proxy API.
 */

import type {
  ApiResponse,
  TroncalCorridorFeature,
  TroncalRouteFeature,
  TroncalStationFeature,
  TroncalWagonFeature,
  ZonalRouteFeature,
} from '../types/transmilenio';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 30_000;

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

async function fetchJson<T>(endpoint: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body ? ` ${body.slice(0, 180)}` : '';
      throw new ApiError(endpoint, `API ${response.status} ${response.statusText}.${detail}`, response.status);
    }
    return response.json();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    throw new ApiError(
      endpoint,
      isAbort
        ? `La API no respondio despues de ${REQUEST_TIMEOUT_MS / 1000}s: ${endpoint}`
        : `No se pudo conectar con ${API_BASE}: ${message}`
    );
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export const api = {
  getTroncalRoutes: () =>
    fetchJson<ApiResponse<TroncalRouteFeature>>('/troncal/routes'),

  getTroncalStations: () =>
    fetchJson<ApiResponse<TroncalStationFeature>>('/troncal/stations'),

  getTroncalWagons: () =>
    fetchJson<ApiResponse<TroncalWagonFeature>>('/troncal/wagons'),

  getTroncalCorridors: () =>
    fetchJson<ApiResponse<TroncalCorridorFeature>>('/troncal/corridors'),

  getZonalRoutes: () =>
    fetchJson<ApiResponse<ZonalRouteFeature>>('/zonal/routes'),

  getZonalStops: () =>
    fetchJson<ApiResponse<any>>('/zonal/stops'),

  getZonalStopRoutes: () =>
    fetchJson<ApiResponse<any>>('/zonal/stop-routes'),
};
