/**
 * TransMilenio Explorer — Main Entry Point
 *
 * Bootstraps the map, loads data from the backend proxy,
 * and wires up the sidebar UI.
 */

import maplibregl from 'maplibre-gl';
import { createMap, initMapImages } from './map';
import { api } from './services/api';
import { addStationsLayer, bringStationsLayerToFront, catalogStationsToFeatures, getNearestVisibleStation, isVisibleTroncalStation, setCatalog, toggleStationsLayer, showStationPopupByCode } from './layers/stations';
import { addStopsLayer, bringStopsLayerToFront, toggleStopsLayer, buildStopRoutesMap, updateSelectedRouteStops, updateStopsLayer, showStopPopupByCode } from './layers/stops';
import { showPopup } from './layers/popup';
import { addCableLayers, toggleCableLayers, toggleCableStationsLayer, bringCableLayersToFront } from './layers/cable';
import {
  addTroncalCorridorsLayer,
  addTroncalRoutesLayer,
  addZonalRoutesLayer,
  getZonalRouteColor,
  toggleTroncalRoutes,
  toggleZonalRoutes,
  highlightRoute,
  clearHighlight,
  normalizeRouteCodeForMatch,
  bringTroncalLayersToFront,
  updateZonalRoutes,
} from './layers/routes';
import { initSidebar, setRoutes, updateCounts, refreshRouteDetail, selectRouteByCode, selectRouteByIdOrCode, updateLiveBusStatus, setLiveRefreshHandler, openSidebar, setAvailableZones } from './ui/sidebar';
import { buildZonalAreas, getZones } from './data/zones';
import { initNativeBack } from './services/nativeBack';
import { getRouteAccentColor } from './utils/routeColors';
import { setRouteTypeIndex } from './utils/routeType';
import { clearLegacyExactLocation, getSessionExactLocation, setSessionExactLocation } from './utils/sessionLocation';
import { isWithinBogota } from './utils/geo';
import { initCerca, setCercaLocation, setNearbyPoints, type NearbyPoint } from './ui/cerca';
import { escapeHTML } from './utils/html';
import {
  buildRouteList,
  dedupeStops,
  getLiveNameCandidates,
  normalizeRouteText,
  parseCatalogStop,
  routeHasDualStops,
  traceToGeometry,
  type RouteStop,
} from './data/routeCatalog';
import type { ApiResponse, RouteListItem, TroncalRouteFeature } from './types/transmilenio';
import type { MasterCatalog, MasterCatalogResponse } from './types/catalog';

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

// Manual-refresh button in the live card forces an immediate poll.
setLiveRefreshHandler(() => {
  void getBusesModule().then((buses) => buses.refreshLiveBusesNow()).catch(() => {});
});

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

// ─── Nearby Stations (geolocation) ────────────────────────

// Shared draggable "you are here" marker, placed by both the footer "Estaciones
// cerca" action and the Cerca tab so the two never fight over separate markers.
let userMarker: maplibregl.Marker | null = null;

// The Cerca tab's point universe: troncal estaciones (known at boot) plus zonal
// paraderos (enriched in the background). Kept as two lists so the stops arrival
// simply re-pushes the union.
let nearbyStationPoints: NearbyPoint[] = [];
let nearbyStopPoints: NearbyPoint[] = [];
let nearbyRechargePoints: NearbyPoint[] = [];
function pushNearbyPoints(): void {
  setNearbyPoints([...nearbyStationPoints, ...nearbyStopPoints, ...nearbyRechargePoints]);
}

/**
 * Drops (or moves) the user-location marker, recentring the map when `fly`, and
 * opens the popup for the closest troncal station. Geolocation is processed
 * entirely client-side (no PII stored).
 */
function placeUserMarker(
  map: maplibregl.Map,
  longitude: number,
  latitude: number,
  fly = true,
  openNearest = true
): void {
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
    placeUserMarker(map, lngLat.lng, lngLat.lat, false);
  });

  // Keep the Cerca ranking pinned to the marker no matter which flow moved it
  // (footer locate, Cerca locate, or a manual drag).
  setCercaLocation(longitude, latitude);

  if (fly) {
    map.flyTo({ center: [longitude, latitude], zoom: 14, duration: 1200 });
  }

  if (!openNearest) return;
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
}

/** Lightweight popup for a tullave recharge POI (name/address/hours). */
function showRechargePopup(map: maplibregl.Map, point: NearbyPoint): void {
  const hours = point.hours ? `<div class="popup-meta"><span>Lun–Vie ${escapeHTML(point.hours)}</span></div>` : '';
  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow" style="color:#22c55e">Punto de recarga tullave</div>
      <div class="popup-title">${escapeHTML(point.name)}</div>
      ${point.direccion ? `<div class="popup-meta"><span>${escapeHTML(point.direccion)}</span></div>` : ''}
      ${hours}
    </div>`;
  // Reuse the shared single-popup helper so recharge popups replace (not stack
  // on top of) any open station/stop popup.
  showPopup(map, point.coordinate, html, { offset: 12, maxWidth: '280px' });
}

/**
 * Wires the "Estaciones cerca" footer action: locates the user, recenters
 * the map on their position and opens the popup for the closest troncal station.
 */
function initNearbyStations(map: maplibregl.Map): void {
  const btn = document.getElementById('nearby-stations') as HTMLButtonElement | null;
  if (!btn) return;

  const label = btn.querySelector('.footer-action-label');
  const defaultText = label?.textContent ?? 'Estaciones cerca';

  const restore = (message: string): void => {
    if (label) {
      label.textContent = message;
      window.setTimeout(() => { label.textContent = defaultText; }, 2500);
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

      placeUserMarker(map, lng, lat);

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
      // Our own maxTimer owns the deadline, so give the browser the full budget.
      {
        enableHighAccuracy: highAccuracy,
        maximumAge: highAccuracy ? 0 : 60_000,
        timeout: GEO_MAX_WAIT_MS,
      },
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

  // Inside the Android shell (mobile/), mark the DOM so the stylesheet can
  // swap browser-era chrome for app ergonomics (see "Native app shell" in
  // style.css). Functionality is identical on both targets.
  if ((window as any).Capacitor?.isNativePlatform?.()) {
    document.body.classList.add('native-app');
  }

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
  // Diagnostic handle for remote-devtools debugging of deployed builds (same
  // rationale as window.__tmStationAudit) — e.g. inspecting layer/source state
  // inside the Android webview via chrome://inspect.
  (window as Window & { __tmMap?: maplibregl.Map }).__tmMap = map;

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
  let cableRouterStations: import('./services/router').CableStationInput[] = [];

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
    const cableStations = cableStationsRes.features || [];
    const cableTraces = cableTracesRes.features || [];
    catalog = catalogRes.data || { stations: {}, routes: {} };

    // ArcGIS is the primary station source; if it failed or came back empty,
    // rebuild the layer from the (required) master catalog so stations never
    // silently vanish from the map (spec §4.2).
    let stations = stationsRes.features.filter(isVisibleTroncalStation);
    if (stations.length === 0) {
      stations = catalogStationsToFeatures(catalog).filter(isVisibleTroncalStation);
      console.warn(`⚠️ ArcGIS stations unavailable — rebuilt ${stations.length} stations from master catalog`);
    }

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

    // Seed the Cerca point universe with troncal estaciones (zonal paraderos
    // are appended once the background load resolves them).
    nearbyStationPoints = stations
      .map((s): NearbyPoint => ({
        codigo: String(s.attributes?.numero_estacion ?? ''),
        name: s.attributes?.nombre_estacion || 'Estación',
        coordinate: [Number(s.geometry?.x), Number(s.geometry?.y)],
        direccion: s.attributes?.ubicacion_estacion || '',
        kind: 'station',
      }))
      .filter((p) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));

    // 4. Mappings and Stops (Initialize empty stops layer first, background load will update it)
    updateProgress(98, 'Renderizando rutas zonales...');
    addZonalRoutesLayer(map, zonalListItems);

    addStopsLayer(map, [], new Map());

    addCableLayers(map, cableStations, cableTraces);
    cableStationsCount = cableStations.length;
    cableTracesCount = cableTraces.length;

    // Build the cable-station list the router uses for the TransMiCable line.
    cableRouterStations = cableStations
      .map((s: any) => ({
        codigo: String(s.attributes?.cod_nodo ?? ''),
        nombre: s.attributes?.nom_est || 'TransMiCable',
        coordinate: [Number(s.geometry?.x), Number(s.geometry?.y)] as [number, number],
        orden: Number(s.attributes?.num_est) || 0,
      }))
      .filter((s) => s.codigo && Number.isFinite(s.coordinate[0]) && Number.isFinite(s.coordinate[1]));

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
        updateLiveBusStatus(0, 'unreachable');
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

  // Station/stop popups offer "Desde aquí / Hasta aquí" → seed the planner.
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.popup-plan-btn') as HTMLElement | null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const role = btn.dataset.planRole === 'destination' ? 'destination' : 'origin';
    const lng = Number(btn.dataset.planLng);
    const lat = Number(btn.dataset.planLat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const name = btn.dataset.planName || 'Punto seleccionado';
    const code = btn.dataset.planCode || undefined;

    openSidebar();
    getPlannerModule()
      .then((planner) => planner.planFromPopup(role, name, [lng, lat], code))
      .catch((error) => console.error('[Planner] plan-from-popup failed:', error));
  });

  initNearbyStations(map);

  // Cerca tab — nearest stations/paraderos by GPS. Reuses the map's location
  // cascade + user marker so nothing is duplicated (spec §1.1 R2).
  initCerca({
    resolveLocation: () => resolveUserLocation(),
    onLocated: (lng, lat, source) => placeUserMarker(map, lng, lat, source === 'gps', false),
    onSelect: (point) => {
      map.flyTo({ center: point.coordinate, zoom: 15, duration: 900 });
      if (point.kind === 'recharge') {
        showRechargePopup(map, point);
      } else if (point.kind === 'station') {
        const resolved = showStationPopupByCode(map, point.codigo, point.coordinate);
        if (!resolved) showStopPopupByCode(map, point.codigo, point.name, point.coordinate, point.direccion);
      } else {
        showStopPopupByCode(map, point.codigo, point.name, point.coordinate, point.direccion);
      }
    },
  });
  pushNearbyPoints();

  // Recharge POIs (static catalog, spec §5.8) → the Cerca "Recargas" kind.
  api.getRechargePoints()
    .then((res) => {
      if (!res.success || !res.points) return;
      nearbyRechargePoints = res.points
        .map((p, i): NearbyPoint => ({
          codigo: `rp-${i}`,
          name: p.nombre,
          coordinate: [p.longitud, p.latitud],
          direccion: p.direccion || p.localidad || '',
          kind: 'recharge',
          hours: p.wks,
        }))
        .filter((p) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));
      pushNearbyPoints();
    })
    .catch((error) => console.warn('[Recharge] Failed to load recharge points:', error));

  // Android hardware-back close chain (native shell only; no-op on the web).
  initNativeBack();

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
      .then(({ initPlanner }) => initPlanner(map, routeList, cableRouterStations))
      .catch((error) => console.error('[Planner] Failed to load planner module:', error));
  }, 400);

  // 5. Background Loading: fetch Zonal Stops, stop-route mappings, and the
  //    zonal-routes feed (SITP zones) asynchronously.
  Promise.allSettled([
    api.getZonalStops(),
    api.getZonalStopRoutes(),
    api.getZonalRoutes()
  ]).then(([zonalStopsResult, zonalStopRoutesResult, zonalRoutesResult]) => {
    try {
      const zonalStopsRes = optionalFeatures('Zonal stops', zonalStopsResult);
      const zonalStopRoutesRes = optionalFeatures('Zonal stop-route mappings', zonalStopRoutesResult);

      // SITP zone index (spec §5.4.2a) — drives the "Zonas SITP" browse chips.
      const zonalRoutesRes = optionalFeatures('Zonal routes (zones)', zonalRoutesResult);
      buildZonalAreas(zonalRoutesRes.features, routeList);
      setAvailableZones(getZones());
      console.log(`✅ Background load: SITP zones: ${getZones().length}`);

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

        // Append zonal paraderos to the Cerca point universe.
        nearbyStopPoints = zonalStopsRes.features
          .map((s: any): NearbyPoint => ({
            codigo: String(s.attributes?.cenefa ?? ''),
            name: s.attributes?.nombre || 'Paradero',
            coordinate: [Number(s.geometry?.x), Number(s.geometry?.y)],
            direccion: s.attributes?.direccion_bandera || s.attributes?.via || '',
            kind: 'stop',
          }))
          .filter((p: NearbyPoint) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));
        pushNearbyPoints();
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
          .then(({ initRouter }) => initRouter(routeList, cableRouterStations))
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
// The native app (mobile/) skips the SW: its assets already ship inside the
// APK and caching the webview's local scheme would only risk stale catalogs.
const isNativeApp = Boolean((window as any).Capacitor?.isNativePlatform?.());
if ('serviceWorker' in navigator && !isNativeApp) {
  // If a SW already controlled the page, a controllerchange means a new version
  // took over (skipWaiting + clients.claim). Reload once so the page actually
  // uses the fresh caches (e.g. an updated master catalog) instead of the stale
  // bytes the previous worker already served. Guarded so the very first
  // registration (no prior controller) never triggers a reload loop.
  let reloadingForSW = false;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadingForSW) return;
    reloadingForSW = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => reg.update())
      .catch((err) => console.warn('[SW] registration failed', err));
  });
}

// Launch!
main().catch(console.error);
