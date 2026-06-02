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
import { startBusTracking, stopBusTracking } from './layers/buses';
import { getRouteAccentColor, getStopTagColor } from './utils/routeColors';
import type { ApiResponse, RouteListItem, TroncalRouteFeature } from './types/transmilenio';
import type { MasterCatalog, MasterCatalogResponse } from './types/catalog';

// ─── Status Updates ───────────────────────────────────────

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

function isStationStopCode(code: string | null | undefined): boolean {
  return /^TM\d+$/i.test(String(code || '').trim());
}

function stopKind(code: string | null | undefined): 'station' | 'stop' {
  return isStationStopCode(code) ? 'station' : 'stop';
}

function parseCatalogStop(stop: any): RouteStop | null {
  if (!stop?.coordenada || typeof stop.coordenada !== 'string' || !stop.coordenada.includes(',')) return null;
  const [lat, lng] = stop.coordenada.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    nombre: stop.nombre,
    codigo: stop.codigo,
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
      const stops = dedupeStops(rawStops.map(parseCatalogStop).filter((stop): stop is RouteStop => Boolean(stop)));
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

  const placeUser = (longitude: number, latitude: number): void => {
    userMarker?.remove();
    const el = document.createElement('div');
    el.className = 'user-location-dot';
    userMarker = new maplibregl.Marker({ element: el })
      .setLngLat([longitude, latitude])
      .addTo(map);

    map.flyTo({ center: [longitude, latitude], zoom: 14, duration: 1200 });

    const nearest = getNearestVisibleStation(longitude, latitude);
    if (nearest) {
      map.once('moveend', () => {
        showStationPopupByCode(map, nearest.code, nearest.coordinate);
      });
    }
  };

  btn.addEventListener('click', async () => {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    try {
      const { longitude, latitude } = await resolveUserLocation();
      placeUser(longitude, latitude);
    } catch (error) {
      console.warn('[Nearby] could not resolve location:', error);
      restore('No se pudo ubicarte');
    } finally {
      btn.classList.remove('loading');
    }
  });
}

/**
 * Resolves the user's location. Tries the browser's native geolocation first
 * (precise, permission-gated); if it is unavailable or blocked — e.g. the OS
 * network-location provider errors out with POSITION_UNAVAILABLE — falls back
 * to coarse IP-based location via the backend (/api/geoip).
 */
function resolveUserLocation(): Promise<{ longitude: number; latitude: number }> {
  return getNativeLocation().catch((nativeError) => {
    console.warn('[Nearby] native geolocation failed, falling back to IP:', nativeError?.message ?? nativeError);
    return getIpLocation();
  });
}

function getNativeLocation(): Promise<{ longitude: number; latitude: number }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation API unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ longitude: pos.coords.longitude, latitude: pos.coords.latitude }),
      (error) => reject(error),
      // High accuracy + no cached fix → device GPS, not a coarse network/IP guess.
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

async function getIpLocation(): Promise<{ longitude: number; latitude: number }> {
  const res = await api.getGeoIp();
  if (!res.success || typeof res.longitude !== 'number' || typeof res.latitude !== 'number') {
    throw new Error(res.error ?? 'IP geolocation failed');
  }
  return { longitude: res.longitude, latitude: res.latitude };
}

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🚌 TransMilenio Explorer starting...');

  // 0. Wake up the backend immediately (Render free tier sleeps after inactivity)
  //    Fire-and-forget: we don't need the result, just need the server to start booting.
  const wakeUpPromise = fetch(
    `${(import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')}/health`
  ).catch(() => {});

  // 1. Initialize map
  setLoadingStatus('Cargando mapa...');
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
  setLoadingStatus('Conectando con el servidor (descargando catálogo maestro)...');


  let troncalRoutes: TroncalRouteFeature[] = [];
  let catalog: MasterCatalog = { stations: {}, routes: {} };
  let routeList: RouteListItem[] = [];
  let stationCount = 0;
  let stopsCount = 0;

  let activeRouteId: string | null = null;

  try {
    // 1. Fetch data in parallel. The cached master catalog is required; live
    // ArcGIS layers are allowed to degrade so the app can still open.
    // Zonal stops/mappings are loaded asynchronously in the background.
    const [
      troncalRoutesResult,
      corridorsResult,
      stationsResult,
      catalogResult,
    ] = await Promise.allSettled([
      api.getTroncalRoutes(),
      api.getTroncalCorridors(),
      api.getTroncalStations(),
      api.getMasterCatalog(),
    ]);

    const catalogRes = requireLoaded<MasterCatalogResponse>('Master catalog', catalogResult);
    const troncalRoutesRes = optionalFeatures('Troncal routes', troncalRoutesResult);
    const corridorsRes = optionalFeatures('Troncal corridors', corridorsResult);
    const stationsRes = optionalFeatures('Troncal stations', stationsResult);

    troncalRoutes = troncalRoutesRes.features;
    const stations = stationsRes.features.filter(isVisibleTroncalStation);
    catalog = catalogRes.data || { stations: {}, routes: {} };
    
    console.log(`✅ Troncal routes: ${troncalRoutes.length}`);
    console.log(`✅ Troncal corridors: ${corridorsRes.features.length}`);
    console.log(`✅ Stations: ${stations.length}`);
    console.log(`✅ Master catalog: ${catalogRes.count} stations${catalogRes.stale ? ' (stale — sync in progress)' : ''}`);

    // Set catalog for station popups
    setCatalog(catalog);

    // 2. Pre-calculate unified route list from API
    setLoadingStatus('Procesando datos (esto puede tardar unos segundos)...');
    routeList = buildRouteList(troncalRoutes, catalog);
    const troncalListItems = routeList.filter(r => r.type === 'troncal');
    const zonalListItems = routeList.filter(r => r.type === 'zonal');

    // 3. Add route/corridor layers
    setLoadingStatus('Dibujando troncales...');
    addTroncalCorridorsLayer(map, corridorsRes.features);

    setLoadingStatus('Dibujando rutas troncales...');
    addTroncalRoutesLayer(map, troncalListItems);

    setLoadingStatus('Colocando estaciones...');
    addStationsLayer(map, stations);
    stationCount = stations.length;

    // 4. Mappings and Stops (Initialize empty stops layer first, background load will update it)
    setLoadingStatus('Dibujando rutas zonales...');
    addZonalRoutesLayer(map, zonalListItems);

    setLoadingStatus('Colocando paraderos...');
    addStopsLayer(map, [], new Map());

    bringTroncalLayersToFront(map);
    bringStationsLayerToFront(map);
    bringStopsLayerToFront(map);
  } catch (error) {
    console.error('❌ Error loading data:', error);
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
      stopBusTracking();

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
              route.stops = dedupeStops(vStops.map(parseCatalogStop).filter((stop: RouteStop | null): stop is RouteStop => Boolean(stop)));
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
      startBusTracking(
        map,
        route.code,
        route.liveNameCandidates[0] || route.catalogNombre || route.name || route.destination,
        route.type,
        route.liveNameCandidates,
        (count, status) => updateLiveBusStatus(count, status)
      );

      if (route.geometry && route.geometry.paths) {
        const bounds = new maplibregl.LngLatBounds();
        route.geometry.paths.forEach((path) => {
          path.forEach(([lng, lat]) => {
            bounds.extend([lng, lat]);
          });
        });
        map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 400, right: 60 }, maxZoom: 15 });
      }
    },
    onRouteDeselect: () => {
      activeRouteId = null;
      stopBusTracking();
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
      }

      // ─── Force Global Hierarchy ───────────────────────────────────
      // Every time a filter changes, we must re-move layers to the front
      // in order to avoid MapLibre's default rendering order messing up
      // the Troncal > Zonal hierarchy.
      bringTroncalLayersToFront(map);
      bringStationsLayerToFront(map);
      bringStopsLayerToFront(map);
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
  });

  // 4. Done with initial render!
  console.log('🎉 TransMilenio Explorer initial render ready!');
  hideLoading();

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
        });

        console.log('🎉 TransMilenio Explorer background load & enrichment complete!');
      }
    } catch (bgError) {
      console.error('❌ Error during background load:', bgError);
    }
  });
}

// Launch!
main().catch(console.error);
