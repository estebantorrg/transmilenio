/**
 * HTTP client for the backend proxy API.
 */

const API_BASE = 'http://localhost:3001/api';

async function fetchJson<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

import type {
  ApiResponse,
  TroncalRouteFeature,
  TroncalStationFeature,
  TroncalWagonFeature,
  ZonalRouteFeature,
} from '../types/transmilenio';

export const api = {
  getTroncalRoutes: () =>
    fetchJson<ApiResponse<TroncalRouteFeature>>('/troncal/routes'),

  getTroncalStations: () =>
    fetchJson<ApiResponse<TroncalStationFeature>>('/troncal/stations'),

  getTroncalWagons: () =>
    fetchJson<ApiResponse<TroncalWagonFeature>>('/troncal/wagons'),

  getZonalRoutes: () =>
    fetchJson<ApiResponse<ZonalRouteFeature>>('/zonal/routes'),

  getZonalStops: () =>
    fetchJson<ApiResponse<any>>('/zonal/stops'),

  getZonalStopRoutes: () =>
    fetchJson<ApiResponse<any>>('/zonal/stop-routes'),
};
