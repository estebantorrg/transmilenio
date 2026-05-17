/**
 * HTTP client for the backend proxy API.
 */
const API_BASE = 'http://localhost:3001/api';
async function fetchJson(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
}
export const api = {
    getTroncalRoutes: () => fetchJson('/troncal/routes'),
    getTroncalStations: () => fetchJson('/troncal/stations'),
    getTroncalWagons: () => fetchJson('/troncal/wagons'),
    getZonalRoutes: () => fetchJson('/zonal/routes'),
    getZonalStops: () => fetchJson('/zonal/stops'),
    getZonalStopRoutes: () => fetchJson('/zonal/stop-routes'),
};
