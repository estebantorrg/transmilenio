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
import { setBusModels, clearBusModels, setFollow, type LiveBusInput } from './busModelLayer';

let trackingInterval: number | null = null;
let fetchInFlight = false;
let trackingSessionId = 0;

// Current frame's buses + context, kept for click-to-popup picking.
let currentBuses: LiveBus[] = [];
let currentRouteType: 'troncal' | 'zonal' = 'troncal';
let currentExpectedDestinos: string[] = [];
let currentRouteColor = '#FB2C17';
// Selected trip's stops, ordered origin→destination, for next-stop lookup.
let currentRouteStops: PopupStop[] = [];
let selectedBusId: string | null = null;
let busPopup: maplibregl.Popup | null = null;
let clickHandler: ((e: maplibregl.MapMouseEvent) => void) | null = null;
let boundMap: maplibregl.Map | null = null;

type PopupStop = { nombre: string; coordinate: [number, number] };

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

/** Normalize a destination string for loose matching (drop case/accents/punctuation/spaces). */
function normDestKey(value?: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Keep only buses doing the SELECTED trip of the route.
 *
 * The live API returns BOTH directions of a route whenever the requested
 * `Nombre` doesn't exactly match one of its destinations — common for rutas
 * fáciles (number-only codes) whose catalog name differs from the API's
 * `destino_limpio` (e.g. "Portal El Dorado" vs "Portal Eldorado"). So a route
 * tracked toward Universidades also shows Portal-bound buses. We filter by the
 * selected direction's destination(s) using loose substring matching.
 *
 * Safety: if nothing matches (our direction strings don't line up with the API
 * destinos at all) we keep every bus rather than blank the map.
 */
function filterBusesByDirection(buses: LiveBus[], expectedDestinos: string[]): LiveBus[] {
  const keys = expectedDestinos.map(normDestKey).filter((k) => k.length >= 3);
  if (keys.length === 0) return buses;

  const matched = buses.filter((bus) => {
    const dest = normDestKey(bus.destino_limpio);
    if (!dest) return true; // bus has no destination tag → can't exclude it
    return keys.some((k) => k.includes(dest) || dest.includes(k));
  });

  return matched.length > 0 ? matched : buses;
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
  currentRouteStops = [];
  selectedBusId = null;
  if (boundMap) {
    clearBusModels(boundMap); // also clears the follow hook
    if (clickHandler) boundMap.off('click', clickHandler);
  }
  clickHandler = null;
  busPopup?.remove();
  busPopup = null;
}

/** Open (or move) the info popup on a bus and make it follow the bus each frame. */
function openBusPopup(map: maplibregl.Map, bus: LiveBus): void {
  selectedBusId = bus.id;
  if (!busPopup) {
    busPopup = new maplibregl.Popup({ className: 'tm-popup tm-bus-popup', closeButton: true, closeOnClick: true, maxWidth: '230px', offset: 18 });
    busPopup.on('close', () => { selectedBusId = null; setFollow(null, null); });
  }
  busPopup.setLngLat([bus.longitude, bus.latitude]).setHTML(buildBusPopupHTML(bus, currentRouteType)).addTo(map);
  setFollow(bus.id, (ll) => busPopup?.setLngLat([ll.lng, ll.lat]));
}

export function startBusTracking(
  map: maplibregl.Map,
  routeCode: string,
  destinationName: string,
  routeType: 'troncal' | 'zonal',
  nombreCandidates: string[] = [],
  expectedDestinos: string[] = [],
  routeColor = '#FB2C17',
  stops: PopupStop[] = [],
  onUpdate?: (busCount: number, status: 'loading' | 'success' | 'empty' | 'error' | 'stale', asOf?: number) => void
): void {
  stopBusTracking();

  console.log(`[Tracking] Started live tracking for ${routeCode} -> ${destinationName}`);
  const sessionId = ++trackingSessionId;
  currentRouteType = routeType;
  currentExpectedDestinos = expectedDestinos;
  currentRouteColor = routeColor || '#FB2C17';
  currentRouteStops = stops;
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
    if (best && bestDist < 26) openBusPopup(map, best);
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

    const extracted = extractLiveBuses(res, routeCode);
    if (!extracted) {
      console.warn(`[Tracking] Invalid API response for ${routeCode}:`, res);
      onUpdate?.(0, 'error');
      return;
    }

    // Drop the opposite-direction buses the live API mixes in (see
    // filterBusesByDirection) so only the selected trip is tracked.
    const buses = filterBusesByDirection(extracted, currentExpectedDestinos);

    console.log(`[Tracking] ${extracted.length} live buses for ${routeCode}; ${buses.length} after direction filter`);
    currentBuses = buses;

    const inputs: LiveBusInput[] = buses.map((bus) => ({
      id: bus.id,
      lng: bus.longitude,
      lat: bus.latitude,
      heading: bus.angulo,
    }));
    setBusModels(map, inputs);

    // Keep the open popup in sync with the latest fix (or close it if its bus left).
    if (selectedBusId) {
      const sel = buses.find((b) => b.id === selectedBusId);
      if (sel) busPopup?.setHTML(buildBusPopupHTML(sel, currentRouteType));
      else busPopup?.remove();
    }

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

// ─── Next-stop resolution ────────────────────────────────

const DEG2RAD = Math.PI / 180;
const EARTH_R = 6371000; // metres

function haversineMeters(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLat = (bLat - aLat) * DEG2RAD;
  const dLng = (bLng - aLng) * DEG2RAD;
  const la1 = aLat * DEG2RAD;
  const la2 = bLat * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing (0=N, clockwise) from A to B, matching telemetry `angulo`. */
function bearingDeg(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const la1 = aLat * DEG2RAD;
  const la2 = bLat * DEG2RAD;
  const dLng = (bLng - aLng) * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
}

/** Smallest absolute difference between two compass bearings (0–180). */
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Next stop on the selected trip for a live bus. Stops are ordered
 * origin→destination, so the next stop is the nearest stop — bumped one forward
 * when the telemetry heading shows the bus has already passed that nearest stop
 * (bearing to it points backwards). Heading-agnostic fallback (no `angulo`):
 * the nearest stop. Works the same for troncal and zonal.
 */
function computeNextStop(bus: LiveBus, stops: PopupStop[]): { stop: PopupStop; meters: number } | null {
  if (stops.length === 0) return null;

  let nearIdx = -1;
  let nearDist = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const [lng, lat] = stops[i].coordinate;
    const d = haversineMeters(bus.longitude, bus.latitude, lng, lat);
    if (d < nearDist) { nearDist = d; nearIdx = i; }
  }
  if (nearIdx < 0) return null;

  let idx = nearIdx;
  const heading = Number.isFinite(bus.angulo as number) ? (bus.angulo as number) : null;
  if (heading != null && nearIdx < stops.length - 1) {
    const [lng, lat] = stops[nearIdx].coordinate;
    const toNear = bearingDeg(bus.longitude, bus.latitude, lng, lat);
    if (angleDiff(heading, toNear) > 90) idx = nearIdx + 1; // nearest is behind → already passed
  }

  const stop = stops[idx];
  const [lng, lat] = stop.coordinate;
  return { stop, meters: haversineMeters(bus.longitude, bus.latitude, lng, lat) };
}

function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

// ─── Popup ───────────────────────────────────────────────

function buildBusPopupHTML(bus: LiveBus, routeType: 'troncal' | 'zonal'): string {
  const sysClass = routeType === 'troncal' ? 'troncal' : 'zonal';
  const sysLabel = bus.nombre_sistema || (routeType === 'troncal' ? 'TransMilenio' : 'SITP Zonal');
  const code = bus.ruta_extraida ? escapeHTML(bus.ruta_extraida) : '•';
  const dest = bus.destino_limpio ? `→ ${escapeHTML(bus.destino_limpio)}` : escapeHTML(sysLabel);
  const km = bus.posicion != null ? `${(bus.posicion / 1000).toFixed(1)} km` : null;

  const next = computeNextStop(bus, currentRouteStops);
  const nextRow = next
    ? `<div class="bus-popup-row bus-popup-next"><span>Próxima parada</span><strong>${escapeHTML(next.stop.nombre)} · ${formatDistance(next.meters)}</strong></div>`
    : '';

  return `
    <div class="bus-popup ${sysClass}">
      <div class="bus-popup-top">
        <span class="bus-popup-badge" style="background:${escapeHTML(currentRouteColor)}">${code}</span>
        <div class="bus-popup-titles">
          <div class="bus-popup-id">${escapeHTML(bus.label)}</div>
          <div class="bus-popup-dest">${dest}</div>
        </div>
      </div>
      <div class="bus-popup-rows">
        ${nextRow}
        <div class="bus-popup-row"><span>Sistema</span><strong>${escapeHTML(sysLabel)}</strong></div>
        <div class="bus-popup-row"><span>Última señal</span><strong>${escapeHTML(bus.lasttime || 'Reciente')}</strong></div>
        ${km ? `<div class="bus-popup-row"><span>Recorrido</span><strong>${km}</strong></div>` : ''}
      </div>
    </div>
  `;
}
