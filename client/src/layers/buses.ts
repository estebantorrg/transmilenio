/**
 * Live Bus Tracking Layer
 *
 * Fetches real-time bus locations and renders each one as a 3D bus model
 * (`bus.glb`) via the MapLibre custom WebGL layer in `busModelLayer.ts`.
 * The same model is used for every bus type (troncal / zonal / alimentador).
 * Bus details are shown in a popup when a model is clicked (pixel-picked).
 */

import maplibregl from 'maplibre-gl';
import { api, type LiveStatus } from '../services/api';
import { escapeHTML } from '../utils/html';
import { findBusPayloadArray, toFiniteNumber } from '../utils/liveBus';
import { setBusModels, clearBusModels, setFollow, getRenderedBusLngLat, type LiveBusInput } from './busModelLayer';

// Re-exported so callers that lazy-load this module can warm the 3D assets
// before any route is selected (see `preloadBusModels`).
export { preloadBusModels } from './busModelLayer';

/** Status reported to the route-detail card. `loading` is the in-flight state;
 *  the rest mirror {@link LiveStatus} from the API layer. */
export type TrackingStatus = 'loading' | LiveStatus;

let trackingInterval: number | null = null;
let fetchInFlight = false;
let trackingSessionId = 0;

// Current frame's buses + context, kept for click-to-popup picking.
let currentBuses: LiveBus[] = [];
let currentRouteType: 'troncal' | 'zonal' = 'troncal';
let currentRouteColor = '#FB2C17';
// Selected trip's stops, ordered origin→destination, for next-stop lookup.
let currentRouteStops: PopupStop[] = [];
let selectedBusId: string | null = null;
let busPopup: maplibregl.Popup | null = null;
let clickHandler: ((e: maplibregl.MapMouseEvent) => void) | null = null;
let boundMap: maplibregl.Map | null = null;
// Bound poll for the active session, so the UI's manual-refresh button can force
// an immediate fetch without re-plumbing all the route params.
let pollNow: ((fresh?: boolean) => void) | null = null;

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

/** Normalize the live result's `data` into the typed bus model, dropping any
 *  entries without finite coordinates. */
function extractLiveBuses(data: unknown, routeCode: string): LiveBus[] {
  const payloadArray = findBusPayloadArray(data) ?? [];
  return payloadArray
    .map((bus, index) => normalizeLiveBus(bus, index, routeCode))
    .filter((bus): bus is LiveBus => bus !== null);
}

const DIRECTION_TOLERANCE_DEG = 90;

/**
 * Keep only buses travelling the SELECTED trip's direction.
 *
 * The live API returns BOTH directions of a route whenever the requested
 * `Nombre` doesn't match a destination — and catalog names often differ from,
 * or are absent vs, the API's `destino_limpio` (route 6: catalog carries no
 * destination; the API returns "Portal 80"/"Universidades"), so matching on the
 * destination string is unreliable. Instead we classify each bus geometrically:
 * its heading (`angulo`) must align (within `DIRECTION_TOLERANCE_DEG`) with the
 * route's forward direction at the bus's nearest stop. Validated on live data —
 * it separates the two directions cleanly (forward diffs ~0–17°, reverse ~167–179°).
 *
 * Safety: with fewer than two stops, or a bus that reports no heading, we can't
 * classify, so the bus is kept rather than blanking the map.
 */
function filterBusesByDirection(buses: LiveBus[], stops: PopupStop[]): LiveBus[] {
  if (stops.length < 2) return buses;

  const matched = buses.filter((bus) => {
    const heading = Number.isFinite(bus.angulo as number) ? (bus.angulo as number) : null;
    if (heading == null) return true; // no heading → can't classify → keep
    const fwd = forwardBearingAtNearestStop(bus, stops);
    if (fwd == null) return true;
    return angleDiff(heading, fwd) <= DIRECTION_TOLERANCE_DEG;
  });

  return matched.length > 0 ? matched : buses;
}

// ─── Tracking API Logic ──────────────────────────────────

export function stopBusTracking(): void {
  trackingSessionId++;
  fetchInFlight = false;
  pollNow = null;

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
    // closeOnClick:false — the map click handler owns selection (switch buses /
    // dismiss on empty click); leaving it on makes a second bus-click fight the
    // auto-close and flicker the popup.
    busPopup = new maplibregl.Popup({ className: 'tm-popup tm-bus-popup', closeButton: true, closeOnClick: false, maxWidth: '264px', offset: 18 });
    busPopup.on('close', () => { selectedBusId = null; setFollow(null, null); });
  }
  // Open at the model's live drawn position so the popup lands on the bus, not
  // its last fix; the per-frame follow hook keeps it glued thereafter.
  const ll = getRenderedBusLngLat(bus.id) ?? { lng: bus.longitude, lat: bus.latitude };
  busPopup.setLngLat([ll.lng, ll.lat]).setHTML(buildBusPopupHTML(bus, currentRouteType)).addTo(map);
  setFollow(bus.id, (ll) => busPopup?.setLngLat([ll.lng, ll.lat]));
}

export function startBusTracking(
  map: maplibregl.Map,
  routeCode: string,
  destinationName: string,
  routeType: 'troncal' | 'zonal',
  nombreCandidates: string[] = [],
  routeColor = '#FB2C17',
  stops: PopupStop[] = [],
  onUpdate?: (busCount: number, status: TrackingStatus, asOf?: number) => void
): void {
  stopBusTracking();

  console.log(`[Tracking] Started live tracking for ${routeCode} -> ${destinationName}`);
  const sessionId = ++trackingSessionId;
  currentRouteType = routeType;
  currentRouteColor = routeColor || '#FB2C17';
  currentRouteStops = stops;
  boundMap = map;

  // Click-to-inspect: pick the nearest bus model to the click in screen space.
  clickHandler = (e) => {
    let best: LiveBus | null = null;
    let bestDist = Infinity;
    for (const bus of currentBuses) {
      // Hit-test against the model's live drawn position (interpolated tween +
      // declump), falling back to the last fix if it isn't rendered yet.
      const ll = getRenderedBusLngLat(bus.id) ?? { lng: bus.longitude, lat: bus.latitude };
      const p = map.project([ll.lng, ll.lat]);
      const d = Math.hypot(p.x - e.point.x, p.y - e.point.y);
      if (d < bestDist) { bestDist = d; best = bus; }
    }
    // Click on a bus → open/switch its popup; click on empty map → dismiss.
    if (best && bestDist < 26) openBusPopup(map, best);
    else if (busPopup) busPopup.remove();
  };
  map.on('click', clickHandler);

  pollNow = (fresh = false) =>
    fetchAndRenderBuses(map, routeCode, destinationName, routeType, nombreCandidates, sessionId, onUpdate, fresh);

  // Initial fetch
  onUpdate?.(0, 'loading');
  pollNow();

  // Poll every 15 seconds (spec §3.4)
  trackingInterval = window.setInterval(() => pollNow?.(), 15000);
}

/** Force an immediate live poll for the active route (manual refresh button).
 *  No-op when nothing is being tracked or a request is already in flight. */
export function refreshLiveBusesNow(): void {
  pollNow?.(true); // explicit user intent → never answered from the shared-result window
}

async function fetchAndRenderBuses(
  map: maplibregl.Map,
  routeCode: string,
  destinationName: string,
  routeType: 'troncal' | 'zonal',
  nombreCandidates: string[],
  sessionId: number,
  onUpdate?: (busCount: number, status: TrackingStatus, asOf?: number) => void,
  fresh = false
): Promise<void> {
  if (fetchInFlight) {
    console.debug(`[Tracking] Skipping poll for ${routeCode}; previous live request still pending`);
    return;
  }

  fetchInFlight = true;

  try {
    // getLiveBuses never throws — it always resolves to a typed status envelope.
    const res = await api.getLiveBuses(routeCode, destinationName, routeType, nombreCandidates, { fresh });

    // Check if tracking was stopped while the async request was in flight
    if (trackingInterval === null || sessionId !== trackingSessionId) return;

    // Drop the opposite-direction buses the live API mixes in (see
    // filterBusesByDirection) so only the selected trip is tracked.
    const buses = filterBusesByDirection(extractLiveBuses(res.data, routeCode), currentRouteStops);
    console.log(`[Tracking] ${routeCode}: status=${res.status} source=${res.source} → ${buses.length} buses (after direction filter)`);

    // Only mutate the map when this poll is TRUSTWORTHY. A transient
    // `unreachable` or a low-confidence `unverified` empty must NOT blank the
    // map (spec §4.2) — with a flaky upstream that would make buses flicker in
    // and out every 15 s. We clear only on a verified `no-buses`; otherwise we
    // keep the last rendered positions until a real fix arrives.
    const hasFix = buses.length > 0;
    const render = hasFix || res.status === 'no-buses';
    if (render) {
      currentBuses = buses;
      setBusModels(map, buses.map((bus) => ({
        id: bus.id,
        lng: bus.longitude,
        lat: bus.latitude,
        heading: bus.angulo,
      })));

      // Keep the open popup in sync with the latest fix (or close it if its bus left).
      if (selectedBusId) {
        const sel = buses.find((b) => b.id === selectedBusId);
        if (sel) busPopup?.setHTML(buildBusPopupHTML(sel, currentRouteType));
        else busPopup?.remove();
      }
    }

    // Surface the honest status. `asOf` is the timestamp of the data on screen:
    // the cache time for `stale`, otherwise this fix's wall-clock time so the
    // card can show "actualizado hace Xs". Report the count actually on the map
    // so an uncertain poll that kept the last fix doesn't read as "0".
    const shownCount = render ? buses.length : currentBuses.length;
    const asOf = res.status === 'stale' && typeof res.asOf === 'number' ? res.asOf : Date.now();
    onUpdate?.(shownCount, res.status, asOf);
  } catch (err) {
    // Defensive: getLiveBuses is contracted not to throw, but a renderer fault
    // (e.g. WebGL) must not blank the status card either.
    console.error(`[Tracking] Unexpected error rendering live buses for ${routeCode}:`, err);
    if (trackingInterval !== null && sessionId === trackingSessionId) {
      onUpdate?.(0, 'unreachable');
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

/** Index of the stop nearest the bus (straight-line), or -1 if no stops. */
function nearestStopIndex(bus: LiveBus, stops: PopupStop[]): number {
  let nearIdx = -1;
  let nearDist = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const [lng, lat] = stops[i].coordinate;
    const d = haversineMeters(bus.longitude, bus.latitude, lng, lat);
    if (d < nearDist) { nearDist = d; nearIdx = i; }
  }
  return nearIdx;
}

/**
 * Bearing of the route's forward direction (toward the destination) at the
 * bus's nearest stop — the segment leaving that stop, or entering it at the
 * terminal. `null` when it can't be resolved.
 */
function forwardBearingAtNearestStop(bus: LiveBus, stops: PopupStop[]): number | null {
  const ni = nearestStopIndex(bus, stops);
  if (ni < 0) return null;
  const j = ni < stops.length - 1 ? ni + 1 : ni;
  const i = j === ni ? ni - 1 : ni;
  if (i < 0 || j >= stops.length || i === j) return null;
  const [aLng, aLat] = stops[i].coordinate;
  const [bLng, bLat] = stops[j].coordinate;
  return bearingDeg(aLng, aLat, bLng, bLat);
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

  const nearIdx = nearestStopIndex(bus, stops);
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

/**
 * Human "última señal" label. The telemetry `lasttime` is sometimes a parseable
 * timestamp and sometimes an opaque string — when it parses to a recent moment
 * we show a relative "hace Xs/Xm", otherwise we pass the raw string through.
 */
function formatLastSignal(lasttime: string | undefined): string {
  if (!lasttime) return 'Reciente';
  const t = Date.parse(lasttime);
  if (!Number.isFinite(t)) return lasttime;
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 0 || secs > 6 * 3600) return lasttime; // implausible → show raw
  if (secs < 10) return 'Ahora';
  if (secs < 60) return `hace ${secs} s`;
  const mins = Math.round(secs / 60);
  return mins < 60 ? `hace ${mins} min` : `hace ${Math.round(mins / 60)} h`;
}

/** Faint route-colored wash for the popup header (e.g. `#FB2C17` → rgba). */
function tintFromColor(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(216, 16, 45, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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

  // Header washed with the route's own color (spec §5.2.6), not a fixed red/blue.
  const topStyle = `background:linear-gradient(90deg, ${tintFromColor(currentRouteColor, 0.24)}, ${tintFromColor(currentRouteColor, 0)})`;

  return `
    <div class="bus-popup ${sysClass}">
      <div class="bus-popup-top" style="${topStyle}">
        <span class="bus-popup-badge" style="background:${escapeHTML(currentRouteColor)}">${code}</span>
        <div class="bus-popup-titles">
          <div class="bus-popup-id">${escapeHTML(bus.label)}</div>
          <div class="bus-popup-dest">${dest}</div>
        </div>
      </div>
      <div class="bus-popup-rows">
        ${nextRow}
        <div class="bus-popup-row"><span>Sistema</span><strong>${escapeHTML(sysLabel)}</strong></div>
        <div class="bus-popup-row"><span>Última señal</span><strong>${escapeHTML(formatLastSignal(bus.lasttime))}</strong></div>
        ${km ? `<div class="bus-popup-row"><span>Recorrido</span><strong>${km}</strong></div>` : ''}
      </div>
    </div>
  `;
}
