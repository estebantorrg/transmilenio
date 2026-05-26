/**
 * Live Bus Tracking Layer
 *
 * Fetches real-time bus locations and renders them on the map
 * using gorgeous high-performance glassmorphic markers with pulsing glows.
 */

import maplibregl from 'maplibre-gl';
import { api } from '../services/api';
import { escapeHTML } from '../utils/html';

let activeMarkers: maplibregl.Marker[] = [];
let trackingInterval: number | null = null;
let styleInjected = false;

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

// ─── Style Injection ─────────────────────────────────────

function injectMarkerStyles(): void {
  if (styleInjected) return;
  styleInjected = true;

  const style = document.createElement('style');
  style.id = 'live-bus-marker-styles';
  style.textContent = `
    .live-bus-marker {
      position: relative;
      width: 58px;
      height: 58px;
      cursor: pointer;
      z-index: 120;
      transition: transform 0.2s ease-out;
    }
    .bus-badge-container {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .bus-badge-circle {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: rgba(10, 15, 30, 0.88);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 2;
    }
    .live-bus-marker:hover .bus-badge-circle {
      transform: scale(1.18);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.7);
    }
    .bus-badge-circle.troncal {
      border: 2px solid #EF4444; /* TransMi Red */
    }
    .bus-badge-circle.zonal {
      border: 2px solid #3B82F6; /* SITP Blue */
    }
    .bus-emoji {
      font-size: 30px;
      line-height: 1;
      user-select: none;
    }
    .bus-badge-glow {
      position: absolute;
      width: 54px;
      height: 54px;
      border-radius: 50%;
      filter: blur(6px);
      animation: bus-pulse-anim 1.8s infinite alternate ease-in-out;
      z-index: 1;
      opacity: 0.75;
    }
    .bus-badge-glow.troncal {
      background: rgba(239, 68, 68, 0.45);
    }
    .bus-badge-glow.zonal {
      background: rgba(59, 130, 246, 0.45);
    }
    .bus-direction-indicator {
      position: absolute;
      width: 100%;
      height: 100%;
      top: 0;
      left: 0;
      z-index: 3;
      pointer-events: none;
      transition: transform 0.3s ease;
    }
    .direction-arrow {
      position: absolute;
      top: -3px;
      left: calc(50% - 5px);
      width: 0;
      height: 0;
      border-left: 5px solid transparent;
      border-right: 5px solid transparent;
      border-bottom: 8px solid #10B981; /* Neon green indicator */
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
    }
    .bus-popup-card {
      padding: 10px 12px;
      font-family: 'Inter', system-ui, sans-serif;
      min-width: 150px;
    }
    .bus-popup-title {
      font-size: 13px;
      font-weight: 700;
      color: #F8FAFC;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .bus-popup-system {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
      padding: 2px 5px;
      border-radius: 3px;
      background: rgba(255,255,255,0.08);
    }
    .bus-popup-system.troncal {
      color: #F87171;
    }
    .bus-popup-system.zonal {
      color: #60A5FA;
    }
    .bus-popup-row {
      font-size: 11px;
      color: #94A3B8;
      display: flex;
      justify-content: space-between;
      margin-top: 3px;
    }
    .bus-popup-value {
      color: #E2E8F0;
      font-weight: 500;
    }
    @keyframes bus-pulse-anim {
      0% { transform: scale(0.9); opacity: 0.45; }
      100% { transform: scale(1.22); opacity: 0.9; }
    }
  `;
  document.head.appendChild(style);
}

// ─── Tracking API Logic ──────────────────────────────────

export function stopBusTracking(): void {
  if (trackingInterval !== null) {
    window.clearInterval(trackingInterval);
    trackingInterval = null;
  }

  activeMarkers.forEach((marker) => marker.remove());
  activeMarkers = [];
}

export function startBusTracking(
  map: maplibregl.Map,
  routeCode: string,
  destinationName: string,
  routeType: 'troncal' | 'zonal',
  onUpdate?: (busCount: number, status: 'loading' | 'success' | 'empty' | 'error') => void
): void {
  injectMarkerStyles();
  stopBusTracking();

  console.log(`[Tracking] Started live tracking for ${routeCode} -> ${destinationName}`);
  
  // Initial fetch
  onUpdate?.(0, 'loading');
  fetchAndRenderBuses(map, routeCode, destinationName, routeType, onUpdate);

  // Poll every 15 seconds
  trackingInterval = window.setInterval(() => {
    fetchAndRenderBuses(map, routeCode, destinationName, routeType, onUpdate);
  }, 15000);
}

async function fetchAndRenderBuses(
  map: maplibregl.Map,
  routeCode: string,
  destinationName: string,
  routeType: 'troncal' | 'zonal',
  onUpdate?: (busCount: number, status: 'loading' | 'success' | 'empty' | 'error') => void
): Promise<void> {
  try {
    const res = await api.getLiveBuses(routeCode, destinationName, routeType);
    
    // Check if tracking was stopped while the async request was in flight
    if (trackingInterval === null) return;

    console.log(`[Tracking] Raw API response for ${routeCode}:`, JSON.stringify(res).slice(0, 500));
    const buses = extractLiveBuses(res, routeCode);
    if (!buses) {
      console.warn(`[Tracking] Invalid API response for ${routeCode}:`, res);
      onUpdate?.(0, 'error');
      return;
    }

    console.log(`[Tracking] Fetched ${buses.length} live buses for ${routeCode}`);

    // Map existing markers by bus ID to update them smoothly instead of rebuilding everything
    const busMap = new Map<string, LiveBus>();
    buses.forEach((bus) => {
      busMap.set(bus.id, bus);
    });

    // Remove markers for buses that are no longer active
    const nextMarkers: maplibregl.Marker[] = [];
    activeMarkers.forEach((marker) => {
      const el = marker.getElement();
      const busId = el.getAttribute('data-bus-id');
      if (busId && busMap.has(busId)) {
        const bus = busMap.get(busId)!;
        // Smoothly update location
        marker.setLngLat([bus.longitude, bus.latitude]);
        
        // Update direction arrow angle
        const arrow = el.querySelector('.bus-direction-indicator') as HTMLElement;
        if (arrow && bus.angulo != null) {
          arrow.style.transform = `rotate(${bus.angulo}deg)`;
        }
        
        // Update popup info in case lasttime changed
        const popup = marker.getPopup();
        if (popup) {
          popup.setHTML(buildBusPopupHTML(bus, routeType));
        }
        
        nextMarkers.push(marker);
        busMap.delete(busId); // Handled
      } else {
        marker.remove();
      }
    });

    // Add new markers for newly discovered buses
    busMap.forEach((bus) => {
      const marker = createBusMarker(bus, routeType);
      marker.addTo(map);
      nextMarkers.push(marker);
    });

    activeMarkers = nextMarkers;

    if (buses.length === 0) {
      onUpdate?.(0, 'empty');
    } else {
      onUpdate?.(buses.length, 'success');
    }
  } catch (err) {
    console.error(`[Tracking] Failed to fetch live buses for ${routeCode}:`, err);
    if (trackingInterval !== null) {
      onUpdate?.(0, 'error');
    }
  }
}

// ─── Helper Functions ────────────────────────────────────

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

function createBusMarker(bus: LiveBus, routeType: 'troncal' | 'zonal'): maplibregl.Marker {
  const el = document.createElement('div');
  el.className = 'live-bus-marker';
  el.setAttribute('data-bus-id', String(bus.id));

  const sysClass = routeType === 'troncal' ? 'troncal' : 'zonal';
  const angulo = bus.angulo != null ? bus.angulo : 0;

  el.innerHTML = `
    <div class="bus-badge-container">
      <div class="bus-badge-glow ${sysClass}"></div>
      <div class="bus-badge-circle ${sysClass}">
        <span class="bus-emoji">🚌</span>
      </div>
      <div class="bus-direction-indicator" style="transform: rotate(${angulo}deg);">
        <div class="direction-arrow"></div>
      </div>
    </div>
  `;

  // Create popup for bus info
  const popup = new maplibregl.Popup({
    className: 'tm-popup',
    closeButton: false,
    closeOnClick: false,
    focusAfterOpen: false,
    maxWidth: '220px',
    offset: 16,
  }).setHTML(buildBusPopupHTML(bus, routeType));

  const marker = new maplibregl.Marker({
    element: el,
    anchor: 'center',
  }).setLngLat([bus.longitude, bus.latitude]).setPopup(popup);

  // Show popup on hover
  el.addEventListener('mouseenter', () => {
    marker.togglePopup();
  });
  el.addEventListener('mouseleave', () => {
    marker.togglePopup();
  });

  return marker;
}
