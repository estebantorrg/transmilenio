/**
 * TransMilenio Explorer — Main Entry Point
 *
 * Bootstraps the map, loads data from the backend proxy,
 * and wires up the sidebar UI.
 */

import maplibregl from 'maplibre-gl';
import { createMap, initMapImages } from './map';
import { api } from './services/api';
import { addStationsLayer, bringStationsLayerToFront, getNearestVisibleStation, isVisibleTroncalStation, setCatalog, toggleStationsLayer, showStationPopupByCode } from './layers/stations';
import { addStopsLayer, bringStopsLayerToFront, toggleStopsLayer, buildStopRoutesMap, updateSelectedRouteStops, updateStopsLayer, showStopPopupByCode } from './layers/stops';
import { addCableLayers, toggleCableLayers, toggleCableStationsLayer, bringCableLayersToFront } from './layers/cable';
import {
  addTroncalCorridorsLayer,
  addTroncalRoutesLayer,
  addZonalRoutesLayer,
  getRouteColor,
  getZonalRouteColor,
  toggleTroncalRoutes,
  toggleZonalRoutes,
  highlightRoute,
  clearHighlight,
  normalizeRouteCodeForMatch,
  bringTroncalLayersToFront,
  updateZonalRoutes,
} from './layers/routes';
import { initSidebar, setRoutes, updateCounts, refreshRouteDetail, selectRouteByCode, selectRouteByIdOrCode, updateLiveBusStatus } from './ui/sidebar';
import { getRouteAccentColor, getStopTagColor } from './utils/routeColors';
import { setRouteTypeIndex } from './utils/routeType';
import { clearLegacyExactLocation, getSessionExactLocation, setSessionExactLocation } from './utils/sessionLocation';
import type { ApiResponse, RouteListItem, TroncalRouteFeature } from './types/transmilenio';
import type { CatalogRoute, MasterCatalog, MasterCatalogResponse } from './types/catalog';

// ─── Status Updates ───────────────────────────────────────

function updateProgress(percent: number, statusText: string): void {
  const bar = document.getElementById('loading-bar-fill');
  const status = document.getElementById('loading-status');
  const percentText = document.getElementById('loading-percent');
  
  if (bar) bar.style.width = `${percent}%`;
  if (status) status.textContent = statusText;
  if (percentText) percentText.textContent = `${percent}%`;
}

function setLoadingStatus(text: string): void {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = text;
}

function hideLoading(): void {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.remove(), 700);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireLoaded<T>(label: string, result: PromiseSettledResult<T>): T {
  if (result.status === 'fulfilled') return result.value;
  throw new Error(`${label}: ${getErrorMessage(result.reason)}`);
}

function optionalFeatures<T>(
  label: string,
  result: PromiseSettledResult<ApiResponse<T>>
): ApiResponse<T> {
  if (result.status === 'fulfilled') return result.value;

  console.warn(`[Data] ${label} unavailable. Continuing with cached catalog data.`, result.reason);
  return {
    success: false,
    count: 0,
    features: [],
    error: getErrorMessage(result.reason),
  };
}

function normalizeRouteText(value: string | null | undefined): string {
  return normalizeRouteCodeForMatch(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getBaseRouteCode(code: string): string {
  return code.toUpperCase()
    .replace(/(?:CV|CICLOVIA|CICLOVÍA|C)$/i, '')
    .trim();
}

function cleanRouteText(text: string): string {
  return text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bciclovia\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Accent-insensitive Ciclov\u00eda check \u2014 the catalog spells it "Ciclov\u00eda". */
function isCicloviaName(text: string | null | undefined): boolean {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .includes('ciclovia');
}

type RouteStop = NonNullable<RouteListItem['stops']>[number];
type BusesModule = typeof import('./layers/buses');
type PlannerModule = typeof import('./ui/planner');
type RouterModule = typeof import('./services/router');

let busesModulePromise: Promise<BusesModule> | null = null;
let plannerModulePromise: Promise<PlannerModule> | null = null;
let routerModulePromise: Promise<RouterModule> | null = null;

function getBusesModule(): Promise<BusesModule> {
  busesModulePromise ??= import('./layers/buses').catch((error) => {
    busesModulePromise = null;
    throw error;
  });
  return busesModulePromise;
}

async function stopLiveBusTracking(): Promise<void> {
  if (!busesModulePromise) return;
  try {
    const buses = await busesModulePromise;
    buses.stopBusTracking();
  } catch (error) {
    console.warn('[Live] Bus layer was not available to stop:', error);
  }
}

function getPlannerModule(): Promise<PlannerModule> {
  plannerModulePromise ??= import('./ui/planner').catch((error) => {
    plannerModulePromise = null;
    throw error;
  });
  return plannerModulePromise;
}

function getRouterModule(): Promise<RouterModule> {
  routerModulePromise ??= import('./services/router').catch((error) => {
    routerModulePromise = null;
    throw error;
  });
  return routerModulePromise;
}

interface SplitStopNode {
  code: string;
  sourceCode: string;
  name: string;
  direccion: string;
  coordinate: [number, number];
  wagons: Set<string>;
}

const VERIFIED_SPLIT_STOP_NODES: SplitStopNode[] = [
  {
    code: '09110',
    sourceCode: 'TM0013',
    name: 'AV. Jimenez - Caracas',
    direccion: 'CL 13 - CL 11',
    coordinate: [-74.08042807, 4.60287397],
    wagons: new Set(['A', 'B', 'C']),
  },
  {
    code: '14003',
    sourceCode: 'TM0013',
    name: 'AV. Jimenez - CL 13',
    direccion: 'CL 13 - Caracas',
    coordinate: [-74.07910861, 4.60304793],
    wagons: new Set(['D', 'E']),
  },
  {
    code: '07111',
    sourceCode: 'TM0069',
    name: 'Ricaurte - NQS',
    direccion: 'KR 30 - CL 10',
    coordinate: [-74.09386888, 4.6116862],
    wagons: new Set(['A', 'B', 'C']),
  },
  {
    code: '12003',
    sourceCode: 'TM0069',
    name: 'Ricaurte - CL 13',
    direccion: 'CL 13 - KR 28',
    coordinate: [-74.09048002, 4.61301485],
    wagons: new Set(['D', 'E', 'F']),
  },
];

function isStationStopCode(code: string | null | undefined): boolean {
  return /^TM\d+$/i.test(String(code || '').trim());
}

function stopKind(code: string | null | undefined): 'station' | 'stop' {
  return isStationStopCode(code) ? 'station' : 'stop';
}

function catalogRouteMatches(left: CatalogRoute, right: CatalogRoute): boolean {
  if (left.id && right.id && String(left.id) === String(right.id)) return true;
  return normalizeRouteCodeForMatch(left.codigo) === normalizeRouteCodeForMatch(right.codigo) &&
    cleanRouteText(left.nombre) === cleanRouteText(right.nombre);
}

function splitNodeForRouteStop(
  stop: any,
  route: CatalogRoute | null | undefined,
  catalog: MasterCatalog
): SplitStopNode | null {
  if (!route || !stop?.codigo) return null;

  const sourceCode = String(stop.codigo).toUpperCase();
  const splitNodes = VERIFIED_SPLIT_STOP_NODES.filter((node) => node.sourceCode === sourceCode);
  if (splitNodes.length === 0) return null;

  const sourceStation = catalog.stations?.[sourceCode];
  if (!sourceStation?.wagons) return null;

  for (const [wagonLabel, routes] of Object.entries(sourceStation.wagons)) {
    const splitNode = splitNodes.find((node) => node.wagons.has(wagonLabel));
    if (!splitNode) continue;
    if (routes.some((candidate) => catalogRouteMatches(candidate, route))) return splitNode;
  }

  return null;
}

function parseCatalogStop(stop: any, route?: CatalogRoute, catalog?: MasterCatalog): RouteStop | null {
  if (!stop?.coordenada || typeof stop.coordenada !== 'string' || !stop.coordenada.includes(',')) return null;
  const [lat, lng] = stop.coordenada.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const splitNode = catalog ? splitNodeForRouteStop(stop, route, catalog) : null;
  if (splitNode) {
    return {
      nombre: splitNode.name,
      codigo: splitNode.code,
      sourceCode: splitNode.sourceCode,
      coordinate: splitNode.coordinate,
      direccion: splitNode.direccion,
      kind: 'station',
    };
  }

  return {
    nombre: stop.nombre,
    codigo: stop.codigo,
    sourceCode: stop.codigo,
    coordinate: [lng, lat] as [number, number],
    direccion: stop.direccion,
    kind: stopKind(stop.codigo),
  };
}

function dedupeStops(stops: RouteListItem['stops'] | undefined): RouteStop[] {
  const seen = new Set<string>();
  const result: RouteStop[] = [];

  for (const stop of stops || []) {
    const coordinateKey = `${stop.coordinate[0].toFixed(6)},${stop.coordinate[1].toFixed(6)}`;
    const key = stop.codigo
      ? `${stop.codigo.toUpperCase()}|${coordinateKey}`
      : `${normalizeRouteText(stop.nombre)}|${coordinateKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(stop);
  }

  return result;
}

function isLngLatPair(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]));
}

function traceToGeometry(trace: number[][] | number[][][] | undefined): { paths: number[][][] } | undefined {
  if (!Array.isArray(trace) || trace.length === 0) return undefined;
  const first = trace[0];

  if (isLngLatPair(first)) {
    return trace.length > 1 ? { paths: [trace as number[][]] } : undefined;
  }

  if (Array.isArray(first) && isLngLatPair(first[0])) {
    const paths = (trace as number[][][]).filter((path) => Array.isArray(path) && path.length > 1);
    return paths.length > 0 ? { paths } : undefined;
  }

  return undefined;
}

function routeHasDualStops(stops: any[] | undefined): boolean {
  if (!stops || stops.length === 0) return false;
  const hasStation = stops.some((stop) => isStationStopCode(stop.codigo));
  const hasStop = stops.some((stop) => !isStationStopCode(stop.codigo));
  return hasStation && hasStop;
}

function buildCatalogRouteList(catalog: MasterCatalog): RouteListItem[] {
  const items: RouteListItem[] = [];
  if (!catalog.routes) return items;

  // Track seen route combinations to deduplicate. Key = baseCode|type|origin|dest
  const seen = new Map<string, number>();

  for (const [code, variants] of Object.entries(catalog.routes)) {
    for (const route of variants) {
      const service = `${route.sistema} ${route.tipoServicio}`.toUpperCase();
      const isAlimentador = service.includes('ALIMENTADOR');
      const isDual = service.includes('PADRON') || routeHasDualStops(route.stops);
      const type = service.includes('ZONAL') || service.includes('TRANSMIZONAL') || isAlimentador ? 'zonal' : 'troncal';
      const subType = isDual ? 'dual' : isAlimentador ? 'alimentador' : type;

      const rawStops = route.stops || [];
      const stops = dedupeStops(rawStops.map((stop) => parseCatalogStop(stop, route, catalog)).filter((stop): stop is RouteStop => Boolean(stop)));
      const origin = route.origin || rawStops[0]?.nombre || code;
      const destination = route.destination || rawStops[rawStops.length - 1]?.nombre || route.nombre;
      
      // Use the official catalog name if available, otherwise fallback to the origin/dest string
      const displayName = route.nombre || `${origin} → ${destination}`;

      const baseCode = getBaseRouteCode(code);
      const normOrigin = cleanRouteText(origin);
      const normDest = cleanRouteText(destination);
      const dedupKey = `${baseCode}|${type}|${normOrigin}|${normDest}`;

      const existingIdx = seen.get(dedupKey);
      if (existingIdx !== undefined) {
        // Merge geometry/stops into existing entry
        const existing = items[existingIdx];
        
        // If existing is a Ciclovía variant but the new one is regular, update metadata
        const isNewCiclovia = code.toUpperCase().endsWith('CV') || isCicloviaName(displayName);
        const isExistingCiclovia = existing.code.toUpperCase().endsWith('CV') || isCicloviaName(existing.name);
        
        if (isExistingCiclovia && !isNewCiclovia) {
          existing.id = `catalog-${route.id || `${code}-${normalizeRouteText(route.nombre)}`}`;
          existing.code = code;
          existing.name = displayName;
          existing.origin = origin;
          existing.destination = destination;
          existing.busType = route.tipoServicio;
        }

        const traceGeometry = traceToGeometry(route.trazado);
        if (!existing.geometry && traceGeometry) {
          existing.geometry = traceGeometry;
        }
        
        if ((!existing.stops || existing.stops.length === 0) && stops.length > 0) {
          existing.stops = stops;
        }
        continue;
      }

      const geometry = traceToGeometry(route.trazado);

      const newItem: RouteListItem = {
        id: `catalog-${route.id || `${code}-${normalizeRouteText(route.nombre)}`}`,
        code,
        name: displayName,
        origin,
        destination,
        type,
        subType,
        source: 'catalog',
        busType: route.tipoServicio,
        schedule: route.horarios?.data?.map((h) => `${h.convencion} ${h.hora_inicio}-${h.hora_fin}`).join(' / '),
        color: type === 'troncal' ? getRouteColor(code, 'troncal') : getStopTagColor(code, route.color),
        catalogNombre: route.nombre || '',
        geometry,
        stops,
      };

      seen.set(dedupKey, items.length);
      items.push(newItem);
    }
  }

  return items;
}

function addUniqueLiveName(candidates: string[], value: unknown): void {
  const text = String(value || '').trim();
  if (!text) return;

  const parts = text.split(/\s+[-–—]\s+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts.length > 1 ? [...parts].reverse() : parts) {
    const clean = part.trim();
    if (clean && !candidates.some((candidate) => candidate.toLowerCase() === clean.toLowerCase())) {
      candidates.push(clean);
    }
  }

  if (!candidates.some((candidate) => candidate.toLowerCase() === text.toLowerCase())) {
    candidates.push(text);
  }
}

function getLiveNameCandidates(route: RouteListItem): string[] {
  const candidates: string[] = [];
  addUniqueLiveName(candidates, route.destination);
  addUniqueLiveName(candidates, route.catalogNombre);
  addUniqueLiveName(candidates, route.name);
  addUniqueLiveName(candidates, route.origin);
  route.stops?.slice(0, 1).forEach((stop) => addUniqueLiveName(candidates, stop.nombre));
  route.stops?.slice(-1).forEach((stop) => addUniqueLiveName(candidates, stop.nombre));
  return candidates;
}

function getMapFitPadding(): { top: number; bottom: number; left: number; right: number } {
  const sidebarCollapsed = document.body.classList.contains('sidebar-collapsed');
  const sidebarWidth = sidebarCollapsed ? 0 : Math.min(360, window.innerWidth - 24);
  return {
    top: 60,
    bottom: 60,
    left: sidebarCollapsed ? 28 : Math.min(sidebarWidth + 40, window.innerWidth - 60),
    right: 60,
  };
}

// ─── Build Route List Items ───────────────────────────────

function buildRouteList(
  troncalRoutes: TroncalRouteFeature[],
  catalog: MasterCatalog,
  zonalStops: any[] = [],
  zonalMappings: any[] = []
): RouteListItem[] {
  // 1. Build authoritative catalog items
  const catalogItems = buildCatalogRouteList(catalog);
  const mergedRoutes = new Map<string, RouteListItem>();
  const catalogItemsByBaseAndType = new Map<string, RouteListItem[]>();

  const indexCatalogRoute = (route: RouteListItem) => {
    const indexKey = `${getBaseRouteCode(route.code)}|${route.type}`;
    const routes = catalogItemsByBaseAndType.get(indexKey) ?? [];
    routes.push(route);
    catalogItemsByBaseAndType.set(indexKey, routes);
  };

  const endpointMatches = (left: string, right: string) =>
    Boolean(left && right && (left.includes(right) || right.includes(left)));

  const findCatalogRouteForArcgis = (
    baseCode: string,
    type: 'troncal' | 'zonal',
    normOrigin: string,
    normDest: string
  ): RouteListItem | undefined => {
    const candidates = catalogItemsByBaseAndType.get(`${baseCode}|${type}`) ?? [];
    if (candidates.length === 0) return undefined;

    return candidates.find((candidate) => {
      const candidateOrigin = cleanRouteText(candidate.origin);
      const candidateDest = cleanRouteText(candidate.destination);
      return endpointMatches(candidateOrigin, normOrigin) && endpointMatches(candidateDest, normDest);
    }) ?? (candidates.length === 1 ? candidates[0] : undefined);
  };

  // Add all catalog items keyed by a unified baseCode|type|origin|dest key
  catalogItems.forEach((catRoute) => {
    const baseCode = getBaseRouteCode(catRoute.code);
    const normOrigin = cleanRouteText(catRoute.origin);
    const normDest = cleanRouteText(catRoute.destination);
    const key = `${baseCode}|${catRoute.type}|${normOrigin}|${normDest}`;
    
    mergedRoutes.set(key, catRoute);
    indexCatalogRoute(catRoute);
  });

  // 2. Process Troncal geometries from ArcGIS to enrich catalog items
  troncalRoutes.forEach((r) => {
    let code = r.attributes.route_name_ruta_troncal;
    if (!code) return;

    const baseCode = getBaseRouteCode(code.replace(/-\d$/, ''));
    const origin = r.attributes.origen_ruta_troncal || '';
    const destination = r.attributes.destino_ruta_troncal || '';
    const normOrigin = cleanRouteText(origin);
    const normDest = cleanRouteText(destination);

    const key = `${baseCode}|troncal|${normOrigin}|${normDest}`;

    const existing = mergedRoutes.get(key) ?? findCatalogRouteForArcgis(baseCode, 'troncal', normOrigin, normDest);
    if (existing) {
      if (r.geometry) existing.geometry = r.geometry;
      if (!existing.length && r.attributes.longitud_ruta_troncal) {
        existing.length = r.attributes.longitud_ruta_troncal;
      }
    }
  });

  // 3. Enrich Zonal routes with stops from mappings if missing
  if (zonalStops.length > 0 && zonalMappings.length > 0) {
    const stopLookup = new Map<string, any>();
    zonalStops.forEach(s => {
      const cenefa = s.attributes?.cenefa;
      if (cenefa) stopLookup.set(cenefa, s);
    });

    const routeToStops = new Map<string, any[]>();
    zonalMappings.forEach(m => {
      const routeCode = normalizeRouteCodeForMatch(m.attributes?.ruta);
      const cenefa = m.attributes?.cenefa;
      if (routeCode && cenefa && stopLookup.has(cenefa)) {
        const stop = stopLookup.get(cenefa);
        if (!stop?.geometry || stop.geometry.x == null || stop.geometry.y == null) return;
        if (!routeToStops.has(routeCode)) routeToStops.set(routeCode, []);
        routeToStops.get(routeCode)!.push({
          nombre: stop.attributes?.nombre || 'Paradero',
          codigo: cenefa,
          coordinate: [stop.geometry.x, stop.geometry.y] as [number, number],
          direccion: stop.attributes?.direccion_bandera || stop.attributes?.via || '',
          kind: 'stop',
        });
      }
    });

    // Apply to mergedRoutes
    for (const route of mergedRoutes.values()) {
      if (route.type === 'zonal' && (!route.stops || route.stops.length === 0)) {
        const stops = routeToStops.get(normalizeRouteCodeForMatch(route.code));
        if (stops) {
          route.stops = dedupeStops(stops);
        }
      }
    }
  }

  return Array.from(mergedRoutes.values());
}

// ─── Nearby Stations (geolocation) ────────────────────────

const BOGOTA_BOUNDS = {
  minLat: 4.4,
  maxLat: 4.85,
  minLng: -74.25,
  maxLng: -73.95,
};
const BOGOTA_CENTER: [number, number] = [-74.1071, 4.6486];

function isWithinBogota(lng: number, lat: number): boolean {
  return lat >= BOGOTA_BOUNDS.minLat && lat <= BOGOTA_BOUNDS.maxLat &&
         lng >= BOGOTA_BOUNDS.minLng && lng <= BOGOTA_BOUNDS.maxLng;
}

/**
 * Wires the "Estaciones cerca" footer action: locates the user, recenters
 * the map on their position and opens the popup for the closest troncal
 * station. Geolocation is processed entirely client-side (no PII stored).
 */
function initNearbyStations(map: maplibregl.Map): void {
  const btn = document.getElementById('nearby-stations') as HTMLButtonElement | null;
  if (!btn) return;

  const label = btn.querySelector('.footer-action-label');
  const defaultText = label?.textContent ?? 'Estaciones cerca';
  let userMarker: maplibregl.Marker | null = null;

  const restore = (message: string): void => {
    if (label) {
      label.textContent = message;
      window.setTimeout(() => { label.textContent = defaultText; }, 2500);
    }
  };

  const placeUser = (longitude: number, latitude: number, fly = true): void => {
    userMarker?.remove();
    const el = document.createElement('div');
    el.className = 'user-location-dot';
    el.title = 'Arrastra para ajustar tu ubicación';
    
    userMarker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat([longitude, latitude])
      .addTo(map);

    userMarker.on('dragend', () => {
      const lngLat = userMarker!.getLngLat();
      console.log('[Nearby] User adjusted exact location via drag');
      setSessionExactLocation(lngLat.lng, lngLat.lat, 'manual');
      placeUser(lngLat.lng, lngLat.lat, false);
    });

    if (fly) {
      map.flyTo({ center: [longitude, latitude], zoom: 14, duration: 1200 });
    }

    const nearest = getNearestVisibleStation(longitude, latitude);
    if (nearest) {
      if (fly) {
        map.once('moveend', () => {
          showStationPopupByCode(map, nearest.code, nearest.coordinate);
        });
      } else {
        showStationPopupByCode(map, nearest.code, nearest.coordinate);
      }
    }
  };

  btn.addEventListener('click', async () => {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    try {
      const result = await resolveUserLocation();
      const lng = result.longitude;
      const lat = result.latitude;
      
      if (!isWithinBogota(lng, lat)) {
        throw new Error('Ubicación fuera de los límites de Bogotá');
      }
      
      placeUser(lng, lat);
      
      if (result.source === 'ip') {
        restore('Ubicación aproximada (IP)');
      }
    } catch (error) {
      console.warn('[Nearby] could not resolve location:', error);
      const isOutOfBounds = error instanceof Error && error.message.includes('límites de Bogotá');
      restore(isOutOfBounds ? 'Ubicación fuera de Bogotá' : 'No se pudo ubicarte');
    } finally {
      btn.classList.remove('loading');
    }
  });
}

/**
 * Resolves the user's location with maximum accuracy. Strategy:
 *
 * 1. Try browser native geolocation (GPS / WiFi / cell). Watch for up to
 *    GEO_MAX_WAIT_MS, keeping the most accurate sample. Settle early once
 *    accuracy ≤ GEO_TARGET_ACCURACY_M.
 * 2. If native geolocation outright fails (API missing, permission denied,
 *    POSITION_UNAVAILABLE with zero fixes), fall back to IP-based via
 *    /api/geoip — but only as last resort because IP is city-center (~2 km).
 * 3. A native fix — even a coarse one (200–500 m) — is ALWAYS better than
 *    IP geolocation. Never prefer IP over any native result.
 */
function resolveUserLocation(): Promise<{ longitude: number; latitude: number; accuracy?: number; source: 'gps' | 'ip' }> {
  return getNativeLocation(true)
    .then((result) => {
      setSessionExactLocation(result.longitude, result.latitude, 'gps');
      return result;
    })
    .catch((highError) => {
      console.warn('[Nearby] native high-accuracy failed, trying low accuracy...', highError?.message ?? highError);
      return getNativeLocation(false)
        .then((result) => {
          setSessionExactLocation(result.longitude, result.latitude, 'gps');
          return result;
        })
        .catch(async (lowError) => {
          console.warn('[Nearby] native low-accuracy failed, checking session fix...', lowError?.message ?? lowError);
          const cached = getSessionExactLocation();
          if (cached && isWithinBogota(cached.lng, cached.lat)) {
            console.info('[Nearby] Using session exact location');
            return { longitude: cached.lng, latitude: cached.lat, source: 'gps' as const };
          }
          return await getIpLocation();
        });
    });
}

// Target: GPS-grade accuracy. On mobile with clear sky this is ~5–15 m.
// On desktop/laptop WiFi it's typically 20–100 m (still far better than IP).
const GEO_TARGET_ACCURACY_M = 20;
// Total budget. GPS hardware can take 10–30 s for a cold fix — give it time.
const GEO_MAX_WAIT_MS = 20_000;
// After this many ms, if we already have *any* fix below COARSE_THRESHOLD,
// accept it rather than waiting the full budget.
const GEO_COARSE_ACCEPT_MS = 8_000;
const GEO_COARSE_THRESHOLD_M = 150;

function getNativeLocation(highAccuracy = true): Promise<{ longitude: number; latitude: number; accuracy?: number; source: 'gps' }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation API unavailable'));
      return;
    }

    let best: GeolocationPosition | null = null;
    let settled = false;

    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      navigator.geolocation.clearWatch(watchId);
      window.clearTimeout(maxTimer);
      if (coarseTimer != null) window.clearTimeout(coarseTimer);
      if (best) {
        console.info(
          `[Nearby] native fix (${reason}, highAccuracy=${highAccuracy}): ` +
          `accuracy ±${Math.round(best.coords.accuracy)}m`
        );
        resolve({
          longitude: best.coords.longitude,
          latitude: best.coords.latitude,
          accuracy: best.coords.accuracy,
          source: 'gps',
        });
      } else {
        reject(new Error('No position acquired'));
      }
    };

    // Hard deadline — use whatever we have (or fail).
    const maxTimer = window.setTimeout(() => finish('max-wait'), GEO_MAX_WAIT_MS);

    // Soft deadline — accept a coarse fix rather than waiting forever.
    let coarseTimer: number | undefined;
    const startCoarseTimer = (): void => {
      if (coarseTimer != null) return;
      coarseTimer = window.setTimeout(() => {
        if (best && best.coords.accuracy <= GEO_COARSE_THRESHOLD_M) {
          finish('coarse-accept');
        }
      }, GEO_COARSE_ACCEPT_MS);
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.coords.accuracy) {
          best = pos;
          console.debug(`[Nearby] fix update: ±${Math.round(pos.coords.accuracy)}m`);
        }
        // Excellent fix — stop immediately.
        if (pos.coords.accuracy <= GEO_TARGET_ACCURACY_M) {
          finish('target-accuracy');
          return;
        }
        // We have at least one fix; start the coarse-accept countdown.
        startCoarseTimer();
      },
      (error) => {
        // Only fail if no fix ever arrived; otherwise keep the best we have.
        if (!best) {
          settled = true;
          navigator.geolocation.clearWatch(watchId);
          window.clearTimeout(maxTimer);
          if (coarseTimer != null) window.clearTimeout(coarseTimer);
          reject(error);
        }
      },
      // High accuracy + no cached fix → device GPS, not a coarse network/IP guess.
    );
  });
}

async function getIpLocation(): Promise<{ longitude: number; latitude: number; accuracy?: number; source: 'ip' }> {
  const res = await api.getGeoIp();
  if (!res.success || typeof res.longitude !== 'number' || typeof res.latitude !== 'number') {
    throw new Error(res.error ?? 'IP geolocation failed');
  }
  console.warn('[Nearby] using IP geolocation — accuracy is city-level (~2 km)');
  return { longitude: res.longitude, latitude: res.latitude, source: 'ip' };
}


// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🚌 TransMilenio Explorer starting...');
  clearLegacyExactLocation();

  // 0. Wake up the backend immediately (Render free tier sleeps after inactivity)
  //    Fire-and-forget: we don't need the result, just need the server to start booting.
  const wakeUpPromise = fetch(
    `${(import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')}/health`
  ).catch((error) => {
    console.warn('[Startup] Backend wake-up ping failed:', error);
  });

  // 1. Initialize map
  updateProgress(5, 'Cargando mapa...');
  const map = createMap('map');
  if (import.meta.env.DEV) {
    (window as Window & { __tmMap?: maplibregl.Map }).__tmMap = map;
  }

  // Wait for map to load (handle case where it might already be loaded)
  if (!map.loaded()) {
    await new Promise<void>((resolve) => {
      map.once('load', async () => {
        await initMapImages(map);
        resolve();
      });
    });
  } else {
    await initMapImages(map);
  }

  // Wait for wake-up ping to complete before firing heavy requests
  await wakeUpPromise;

  // 2. Fetch data from backend
  updateProgress(15, 'Conectando con el servidor...');


  let troncalRoutes: TroncalRouteFeature[] = [];
  let catalog: MasterCatalog = { stations: {}, routes: {} };
  let routeList: RouteListItem[] = [];
  let stationCount = 0;
  let stopsCount = 0;
  let cableStationsCount = 0;
  let cableTracesCount = 0;

  let activeRouteId: string | null = null;

  try {
    // 1. Fetch data in parallel. The cached master catalog is required; live
    // ArcGIS layers are allowed to degrade so the app can still open.
    // Zonal stops/mappings are loaded asynchronously in the background.
    let currentProgress = 15;
    const incrementProgress = (amount: number, msg: string) => {
      currentProgress += amount;
      updateProgress(currentProgress, msg);
    };

    const [
      troncalRoutesResult,
      corridorsResult,
      stationsResult,
      cableStationsResult,
      cableTracesResult,
      catalogResult,
    ] = await Promise.allSettled([
      api.getTroncalRoutes().then((res) => { incrementProgress(10, 'Descargando rutas troncales...'); return res; }),
      api.getTroncalCorridors().then((res) => { incrementProgress(5, 'Descargando corredores...'); return res; }),
      api.getTroncalStations().then((res) => { incrementProgress(5, 'Descargando estaciones...'); return res; }),
      api.getCableStations().then((res) => { incrementProgress(5, 'Descargando estaciones TransMiCable...'); return res; }),
      api.getCableTrazado().then((res) => { incrementProgress(5, 'Descargando trazado TransMiCable...'); return res; }),
      api.getMasterCatalog().then((res) => { incrementProgress(30, 'Descargando catálogo maestro...'); return res; }),
    ]);

    const catalogRes = requireLoaded<MasterCatalogResponse>('Master catalog', catalogResult);
    const troncalRoutesRes = optionalFeatures('Troncal routes', troncalRoutesResult);
    const corridorsRes = optionalFeatures('Troncal corridors', corridorsResult);
    const stationsRes = optionalFeatures('Troncal stations', stationsResult);
    const cableStationsRes = optionalFeatures('Cable stations', cableStationsResult);
    const cableTracesRes = optionalFeatures('Cable traces', cableTracesResult);

    troncalRoutes = troncalRoutesRes.features;
    const stations = stationsRes.features.filter(isVisibleTroncalStation);
    const cableStations = cableStationsRes.features || [];
    const cableTraces = cableTracesRes.features || [];
    catalog = catalogRes.data || { stations: {}, routes: {} };
    
    console.log(`✅ Troncal routes: ${troncalRoutes.length}`);
    console.log(`✅ Troncal corridors: ${corridorsRes.features.length}`);
    console.log(`✅ Stations: ${stations.length}`);
    console.log(`✅ Cable stations: ${cableStations.length}`);
    console.log(`✅ Cable traces: ${cableTraces.length}`);
    console.log(`✅ Master catalog: ${catalogRes.count} stations${catalogRes.stale ? ' (stale — sync in progress)' : ''}`);

    // Set catalog for station popups, and index route service types so popups
    // can keep troncal/zonal routes from leaking into each other.
    setCatalog(catalog);
    setRouteTypeIndex(catalog);

    // 2. Pre-calculate unified route list from API
    updateProgress(80, 'Procesando catálogo...');
    routeList = buildRouteList(troncalRoutes, catalog);
    const troncalListItems = routeList.filter(r => r.type === 'troncal');
    const zonalListItems = routeList.filter(r => r.type === 'zonal');

    // 3. Add route/corridor layers
    updateProgress(85, 'Dibujando troncales...');
    addTroncalCorridorsLayer(map, corridorsRes.features);

    updateProgress(90, 'Dibujando rutas...');
    addTroncalRoutesLayer(map, troncalListItems);

    updateProgress(95, 'Renderizando estaciones...');
    addStationsLayer(map, stations);
    stationCount = stations.length;

    // 4. Mappings and Stops (Initialize empty stops layer first, background load will update it)
    updateProgress(98, 'Renderizando rutas zonales...');
    addZonalRoutesLayer(map, zonalListItems);

    addStopsLayer(map, [], new Map());

    addCableLayers(map, cableStations, cableTraces);
    cableStationsCount = cableStations.length;
    cableTracesCount = cableTraces.length;

    bringTroncalLayersToFront(map);
    bringStationsLayerToFront(map);
    bringStopsLayerToFront(map);
    bringCableLayersToFront(map);
  } catch (error) {
    console.error('❌ Error loading data:', error);
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.classList.add('error-state');
    }
    setLoadingStatus(`Error al cargar datos. ${getErrorMessage(error)}`);
    return;
  }

  // 3. Initialize sidebar
  const routeCounts = routeList.reduce(
    (counts, route) => {
      counts[route.type]++;
      return counts;
    },
    { troncal: 0, zonal: 0 }
  );

  initSidebar({
    onRouteSelect: async (route: RouteListItem) => {
      activeRouteId = route.id;
      await stopLiveBusTracking();

      // On-demand loading of catalog routes (geometries and stops)
      if (route.source === 'catalog' && (!route.geometry || !route.stops || route.stops.length === 0)) {
        try {
          const detailRes = await api.getRouteDetail(route.code);
          if (activeRouteId !== route.id) return; // User switched routes during async load

          if (detailRes.success && Array.isArray(detailRes.data)) {
            const variant = detailRes.data.find((v: any) => {
              const vId = `catalog-${v.id || `${route.code}-${normalizeRouteText(v.nombre)}`}`;
              return vId === route.id;
            });
            if (variant) {
              const vStops = variant.stops || [];
              const detailGeometry = traceToGeometry(variant.trazado);
              if (detailGeometry) route.geometry = detailGeometry;
              if (routeHasDualStops(vStops)) route.subType = 'dual';
              route.stops = dedupeStops(vStops.map((stop: any) => parseCatalogStop(stop, variant, catalog)).filter((stop: RouteStop | null): stop is RouteStop => Boolean(stop)));
            }
          }
        } catch (error) {
          console.error(`❌ Error fetching details for route ${route.code}:`, error);
          if (activeRouteId !== route.id) return;
        }
      }

      refreshRouteDetail(route);
      highlightRoute(map, route.code, route.type, route.geometry, getRouteAccentColor(route));
      updateSelectedRouteStops(map, route.stops, route.type);
      route.liveNameCandidates = getLiveNameCandidates(route);
      let buses: BusesModule;
      try {
        buses = await getBusesModule();
      } catch (error) {
        console.error('[Live] Failed to load bus layer:', error);
        updateLiveBusStatus(0, 'error');
        return;
      }
      if (activeRouteId !== route.id) return;
      // Opposite-direction buses the live API mixes in for rutas duales/fáciles
      // are dropped geometrically by filterBusesByDirection using these stops.
      buses.startBusTracking(
        map,
        route.code,
        route.liveNameCandidates[0] || route.catalogNombre || route.name || route.destination,
        route.type,
        route.liveNameCandidates,
        getRouteAccentColor(route),
        (route.stops ?? []).map((s) => ({ nombre: s.nombre, coordinate: s.coordinate })),
        (count, status, asOf) => updateLiveBusStatus(count, status, asOf)
      );

      if (route.geometry && route.geometry.paths) {
        const bounds = new maplibregl.LngLatBounds();
        route.geometry.paths.forEach((path) => {
          path.forEach(([lng, lat]) => {
            bounds.extend([lng, lat]);
          });
        });
        map.fitBounds(bounds, { padding: getMapFitPadding(), maxZoom: 15 });
      }
    },
    onRouteDeselect: () => {
      activeRouteId = null;
      void stopLiveBusTracking();
      clearHighlight(map);
      updateSelectedRouteStops(map, [], 'zonal');
    },
    onStopSelect: (stop: any, routeType: 'troncal' | 'zonal') => {
      if (stop && stop.coordinate) {
        const kind = stop.kind ?? (routeType === 'troncal' ? 'station' : 'stop');
        if (kind === 'station') {
          const resolved = showStationPopupByCode(map, stop.codigo, stop.coordinate);
          if (!resolved) {
            showStopPopupByCode(map, stop.codigo, stop.nombre, stop.coordinate, stop.direccion);
          }
        } else {
          showStopPopupByCode(map, stop.codigo, stop.nombre, stop.coordinate, stop.direccion);
        }
      }
    },
    onLayerToggle: (layer: string, visible: boolean) => {
      switch (layer) {
        case 'troncal':
          toggleTroncalRoutes(map, visible);
          break;
        case 'zonal':
          toggleZonalRoutes(map, visible);
          break;
        case 'stations':
          toggleStationsLayer(map, visible);
          break;
        case 'stops':
          toggleStopsLayer(map, visible);
          break;
        case 'cable':
          toggleCableLayers(map, visible);
          break;
        case 'cable-stations':
          toggleCableStationsLayer(map, visible);
          break;
      }

      // ─── Force Global Hierarchy ───────────────────────────────────
      // Every time a filter changes, we must re-move layers to the front
      // in order to avoid MapLibre's default rendering order messing up
      // the Troncal > Zonal hierarchy.
      bringTroncalLayersToFront(map);
      bringStationsLayerToFront(map);
      bringStopsLayerToFront(map);
      bringCableLayersToFront(map);
    },
  });

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const clickableTag = target.closest('.route-tag.clickable');
    if (clickableTag) {
      const isAllowedRouteDetailClick = clickableTag.closest('.maplibregl-popup-content, #sidebar');
      if (!isAllowedRouteDetailClick) return;

      e.stopPropagation();
      const id = clickableTag.getAttribute('data-route-id');
      const code = clickableTag.getAttribute('data-route-code');
      if (id) {
        selectRouteByIdOrCode(id, code || '');
      } else if (code) {
        selectRouteByCode(code);
      }
    }
  });

  initNearbyStations(map);

  setRoutes(routeList);
  updateCounts({
    troncal: routeCounts.troncal,
    zonal: routeCounts.zonal,
    stations: stationCount,
    stops: stopsCount,
    cable: cableTracesCount,
    cableStations: cableStationsCount,
  });

  // 4. Done with initial render!
  console.log('🎉 TransMilenio Explorer initial render ready!');
  updateProgress(100, '¡Listo!');
  setTimeout(() => {
    hideLoading();
    getPlannerModule()
      .then(({ initPlanner }) => initPlanner(map, routeList))
      .catch((error) => console.error('[Planner] Failed to load planner module:', error));
  }, 400);

  // 5. Background Loading: fetch Zonal Stops and Zonal stop-route mappings asynchronously
  Promise.allSettled([
    api.getZonalStops(),
    api.getZonalStopRoutes()
  ]).then(([zonalStopsResult, zonalStopRoutesResult]) => {
    try {
      const zonalStopsRes = optionalFeatures('Zonal stops', zonalStopsResult);
      const zonalStopRoutesRes = optionalFeatures('Zonal stop-route mappings', zonalStopRoutesResult);

      console.log(`✅ Background load: Zonal stops: ${zonalStopsRes.features.length}`);
      console.log(`✅ Background load: Stop-route mappings: ${zonalStopRoutesRes.features.length}`);

      if (zonalStopsRes.features.length > 0 && zonalStopRoutesRes.features.length > 0) {
        // Build stop-route lookup map
        const stopLookup = new Map<string, any>();
        zonalStopsRes.features.forEach((s: any) => {
          const cenefa = s.attributes?.cenefa;
          if (cenefa) stopLookup.set(cenefa, s);
        });

        const routeToStops = new Map<string, any[]>();
        zonalStopRoutesRes.features.forEach((m: any) => {
          const routeCode = normalizeRouteCodeForMatch(m.attributes?.ruta);
          const cenefa = m.attributes?.cenefa;
          if (routeCode && cenefa && stopLookup.has(cenefa)) {
            const stop = stopLookup.get(cenefa);
            if (!stop?.geometry || stop.geometry.x == null || stop.geometry.y == null) return;
            if (!routeToStops.has(routeCode)) routeToStops.set(routeCode, []);
            routeToStops.get(routeCode)!.push({
              nombre: stop.attributes?.nombre || 'Paradero',
              codigo: cenefa,
              coordinate: [stop.geometry.x, stop.geometry.y] as [number, number],
              direccion: stop.attributes?.direccion_bandera || stop.attributes?.via || '',
              kind: 'stop',
            });
          }
        });

        // Enrich stop lists only. Route lines must come from official trazado data.
        routeList.forEach((route) => {
          if (route.type === 'zonal' && (!route.stops || route.stops.length === 0)) {
            const stops = routeToStops.get(normalizeRouteCodeForMatch(route.code));
            if (stops) {
              route.stops = dedupeStops(stops);
            }
          }
        });

        // Update zonal routes map source with newly loaded geometries
        updateZonalRoutes(map, routeList.filter(r => r.type === 'zonal'));

        // Build complete stopRoutesMap and update the stops layer
        const stopRoutesMap = buildStopRoutesMap(zonalStopRoutesRes.features, catalog);
        updateStopsLayer(map, zonalStopsRes.features, stopRoutesMap);

        stopsCount = zonalStopsRes.features.length;
        updateCounts({
          troncal: routeCounts.troncal,
          zonal: routeCounts.zonal,
          stations: stationCount,
          stops: stopsCount,
          cable: cableTracesCount,
          cableStations: cableStationsCount,
        });

        // Rebuild the routing graph with the fully enriched zonal stops.
        getRouterModule()
          .then(({ initRouter }) => initRouter(routeList))
          .catch((error) => console.error('[Router] Failed to refresh graph:', error));

        console.log('🎉 TransMilenio Explorer background load & enrichment complete!');
      }
    } catch (bgError) {
      console.error('❌ Error during background load:', bgError);
    }
  });
}

// Speed up repeat loads: cache the app shell, hashed assets, and the heavy
// master catalog (see public/sw.js). Registered after load so it never blocks
// first paint; failures are non-fatal.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[SW] registration failed', err));
  });
}

// Launch!
main().catch(console.error);
