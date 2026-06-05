/**
 * Live Bus Tracking Layer
 *
 * Fetches real-time bus locations and renders each one as a 3D bus model
 * (`bus.glb`) via the MapLibre custom WebGL layer in `busModelLayer.ts`.
 * The same model is used for every bus type (troncal / zonal / alimentador).
 * Bus details are shown in a popup when a model is clicked (pixel-picked).
 */

import maplibregl from 'maplibre-gl';
import { api } from '../services/api';
import { escapeHTML } from '../utils/html';
import { setBusModels, clearBusModels, type LiveBusInput } from './busModelLayer';

let trackingInterval: number | null = null;
let fetchInFlight = false;
let trackingSessionId = 0;

// Current frame's buses + context, kept for click-to-popup picking.
let currentBuses: LiveBus[] = [];
let currentRouteType: 'troncal' | 'zonal' = 'troncal';
let busPopup: maplibregl.Popup | null = null;
let clickHandler: ((e: maplibregl.MapMouseEvent) => void) | null = null;
let boundMap: maplibregl.Map | null = null;

type LiveBus = {
  id: string;
  route_id?: number | string;
  latitude: number;
  longitude: number;
  label: string;
  lasttime?: string;
  ruta_extraida?: string;
  destino_limpio?: string;
  posicion?: number;
  angulo?: number;
  nombre_sistema?: string;
};

function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isBusLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;

  const bus = value as { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown; lon?: unknown };
  return toFiniteNumber(bus.latitude ?? bus.lat) !== null &&
    toFiniteNumber(bus.longitude ?? bus.lng ?? bus.lon) !== null;
}

function busValuesFromObject(value: unknown): unknown[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const buses = Object.values(value).filter(isBusLike);
  return buses.length > 0 ? buses : null;
}

function findBusPayloadArray(payload: any): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;

  const candidates = [
    payload.data,
    payload.buses,
    payload.result,
    payload.results,
    payload.vehiculos,
    payload.vehicles,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  for (const candidate of candidates) {
    const buses = busValuesFromObject(candidate);
    if (buses) return buses;
  }

  return busValuesFromObject(payload);
}

function normalizeLiveBus(rawBus: unknown, index: number, routeCode: string): LiveBus | null {
  if (!rawBus || typeof rawBus !== 'object') return null;

  const raw = rawBus as Record<string, unknown>;
  const latitude = toFiniteNumber(raw.latitude ?? raw.lat);
  const longitude = toFiniteNumber(raw.longitude ?? raw.lng ?? raw.lon);
  if (latitude === null || longitude === null) return null;

  const fallbackId = `${routeCode}-${latitude.toFixed(6)}-${longitude.toFixed(6)}-${index}`;
  const rawId = raw.id ?? raw.vehicle_id ?? raw.vehiculo_id ?? raw.label ?? fallbackId;
  const rawLabel = raw.label ?? rawId;
  const angulo = toFiniteNumber(raw.angulo ?? raw.angle ?? raw.heading);
  const posicion = toFiniteNumber(raw.posicion);

  return {
    ...raw,
    id: String(rawId),
    label: String(rawLabel),
    latitude,
    longitude,
    route_id: raw.route_id as number | string | undefined,
    lasttime: typeof raw.lasttime === 'string' ? raw.lasttime : undefined,
    ruta_extraida: typeof raw.ruta_extraida === 'string' ? raw.ruta_extraida : undefined,
    destino_limpio: typeof raw.destino_limpio === 'string' ? raw.destino_limpio : undefined,
    nombre_sistema: typeof raw.nombre_sistema === 'string' ? raw.nombre_sistema : undefined,
    ...(angulo !== null ? { angulo } : {}),
    ...(posicion !== null ? { posicion } : {}),
  };
}

function extractLiveBuses(response: any, routeCode: string): LiveBus[] | null {
  if (!response || response.success === false) return null;

  const payloadArray = findBusPayloadArray(response);
  if (!payloadArray) return null;

  return payloadArray
    .map((bus, index) => normalizeLiveBus(bus, index, routeCode))
    .filter((bus): bus is LiveBus => bus !== null);
}

// ─── Tracking API Logic ──────────────────────────────────

export function stopBusTracking(): void {
  trackingSessionId++;
  fetchInFlight = false;

  if (trackingInterval !== null) {
    window.clearInterval(trackingInterval);
    trackingInterval = null;
  }

  currentBuses = [];
  if (boundMap) {
    clearBusModels(boundMap);
    if (clickHandler) boundMap.off('click', clickHandler);
  }
  clickHandler = null;
  busPopup?.remove();
  busPopup = null;
}

export function startBusTracking(
  map: maplibregl.Map,
  routeCode: string,
  destinationName: string,
  routeType: 'troncal' | 'zonal',
  nombreCandidates: string[] = [],
  onUpdate?: (busCount: number, status: 'loading' | 'success' | 'empty' | 'error' | 'stale', asOf?: number) => void
): void {
  stopBusTracking();

  console.log(`[Tracking] Started live tracking for ${routeCode} -> ${destinationName}`);
  const sessionId = ++trackingSessionId;
  currentRouteType = routeType;
  boundMap = map;

  // Click-to-inspect: pick the nearest bus model to the click in screen space.
  clickHandler = (e) => {
    let best: LiveBus | null = null;
    let bestDist = Infinity;
    for (const bus of currentBuses) {
      const p = map.project([bus.longitude, bus.latitude]);
      const d = Math.hypot(p.x - e.point.x, p.y - e.point.y);
      if (d < bestDist) { bestDist = d; best = bus; }
    }
    if (best && bestDist < 26) {
      if (!busPopup) {
        busPopup = new maplibregl.Popup({ className: 'tm-popup', closeButton: true, closeOnClick: true, maxWidth: '240px', offset: 18 });
      }
      busPopup.setLngLat([best.longitude, best.latitude]).setHTML(buildBusPopupHTML(best, currentRouteType)).addTo(map);
    }
  };
  map.on('click', clickHandler);

  // Initial fetch
  onUpdate?.(0, 'loading');
  fetchAndRenderBuses(map, routeCode, destinationName, routeType, nombreCandidates, sessionId, onUpdate);

  // Poll every 15 seconds
  trackingInterval = window.setInterval(() => {
    fetchAndRenderBuses(map, routeCode, destinationName, routeType, nombreCandidates, sessionId, onUpdate);
  }, 15000);
}

async function fetchAndRenderBuses(
  map: maplibregl.Map,
  routeCode: string,
  destinationName: string,
  routeType: 'troncal' | 'zonal',
  nombreCandidates: string[],
  sessionId: number,
  onUpdate?: (busCount: number, status: 'loading' | 'success' | 'empty' | 'error' | 'stale', asOf?: number) => void
): Promise<void> {
  if (fetchInFlight) {
    console.debug(`[Tracking] Skipping poll for ${routeCode}; previous live request still pending`);
    return;
  }

  fetchInFlight = true;

  try {
    const res = await api.getLiveBuses(routeCode, destinationName, routeType, nombreCandidates);

    // Check if tracking was stopped while the async request was in flight
    if (trackingInterval === null || sessionId !== trackingSessionId) return;

    const buses = extractLiveBuses(res, routeCode);
    if (!buses) {
      console.warn(`[Tracking] Invalid API response for ${routeCode}:`, res);
      onUpdate?.(0, 'error');
      return;
    }

    console.log(`[Tracking] Fetched ${buses.length} live buses for ${routeCode}`);
    currentBuses = buses;

    const inputs: LiveBusInput[] = buses.map((bus) => ({
      id: bus.id,
      lng: bus.longitude,
      lat: bus.latitude,
      heading: bus.angulo,
    }));
    setBusModels(map, inputs);

    // Server tags `stale` when it served last-known positions during an upstream
    // outage (spec §4.2) — render them, but flag the data as delayed.
    const stale = !!(res && (res as any).stale);
    const asOf = res && typeof (res as any).asOf === 'number' ? (res as any).asOf : undefined;
    if (buses.length === 0) {
      onUpdate?.(0, 'empty');
    } else {
      onUpdate?.(buses.length, stale ? 'stale' : 'success', asOf);
    }
  } catch (err) {
    console.error(`[Tracking] Failed to fetch live buses for ${routeCode}:`, err);
    if (trackingInterval !== null && sessionId === trackingSessionId) {
      onUpdate?.(0, 'error');
    }
  } finally {
    if (sessionId === trackingSessionId) {
      fetchInFlight = false;
    }
  }
}

// ─── Popup ───────────────────────────────────────────────

function buildBusPopupHTML(bus: LiveBus, routeType: 'troncal' | 'zonal'): string {
  const sysClass = routeType === 'troncal' ? 'troncal' : 'zonal';
  const sysLabel = bus.nombre_sistema || (routeType === 'troncal' ? 'TransMilenio' : 'SITP Zonal');

  return `
    <div class="bus-popup-card">
      <div class="bus-popup-title">
        <span>🚌 ${escapeHTML(bus.label)}</span>
        <span class="bus-popup-system ${sysClass}">${escapeHTML(sysLabel)}</span>
      </div>
      <div class="bus-popup-row">
        <span>Última act.</span>
        <span class="bus-popup-value">${escapeHTML(bus.lasttime || 'Reciente')}</span>
      </div>
      <div class="bus-popup-row">
        <span>Ángulo</span>
        <span class="bus-popup-value">${bus.angulo != null ? `${bus.angulo}°` : '—'}</span>
      </div>
      ${bus.posicion != null ? `
      <div class="bus-popup-row">
        <span>Progreso</span>
        <span class="bus-popup-value">${(bus.posicion / 1000).toFixed(2)} km</span>
      </div>` : ''}
    </div>
  `;
}
