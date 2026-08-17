/**
 * TransMilenio Explorer — Main Entry Point
 *
 * Bootstraps the map, loads data from the backend proxy,
 * and wires up the sidebar UI.
 */

import maplibregl from 'maplibre-gl';
import { createMap, initMapImages } from './map';
import { api, prefetchLiveBuses, type RechargePointsResponse } from './services/api';
import { addStationsLayer, bringStationsLayerToFront, catalogStationsToFeatures, getStationDisplayPoints, isVisibleTroncalStation, setCatalog, toggleStationsLayer, showStationPopupByCode } from './layers/stations';
import { addStopsLayer, bringStopsLayerToFront, toggleStopsLayer, buildStopRoutesMap, updateSelectedRouteStops, updateStopsLayer, showStopPopupByCode } from './layers/stops';
import { showPopup } from './layers/popup';
import { addCableLayers, toggleCableLayers, toggleCableStationsLayer, bringCableLayersToFront, showCableStationPopup } from './layers/cable';
import { addDemandLayer, toggleDemandLayer, bringDemandLayerToFront } from './layers/demandLayer';
import {
  addTroncalCorridorsLayer,
  addTroncalRoutesLayer,
  addZonalRoutesLayer,
  catalogCorridorsToFeatures,
  toggleTroncalRoutes,
  toggleZonalRoutes,
  highlightRoute,
  clearHighlight,
  bringTroncalLayersToFront,
  updateZonalRoutes,
} from './layers/routes';
import { initSidebar, setRoutes, updateCounts, refreshRouteDetail, selectRouteByCode, selectRouteByIdOrCode, updateLiveBusStatus, setLiveRefreshHandler, openSidebar, setAvailableZones, setSearchPoints, shareLink, routesWithCode } from './ui/sidebar';
import { adoptRoutePage, initRoutePage, isRoutePageOpen, openRoutePage, refreshRoutePage } from './ui/routePage';
import { initStationPage, openStationPage, refreshStationPage } from './ui/stationPage';
import { dismissOverlayPage, initPageShell, isOverlayPageOpen } from './ui/pageShell';
import { parseRoutePathname, parseStationPathname } from './ui/routeDetail';
import { buildZonalAreas, getZones } from './data/zones';
import { initNativeBack } from './services/nativeBack';
import { getRouteAccentColor, getZonalRouteColor } from './utils/routeColors';
import { setCatalogIndexes } from './utils/routeType';
import { clearLegacyExactLocation, getSessionExactLocation, setSessionExactLocation } from './utils/sessionLocation';
import { formatDistance, haversineMeters, isWithinBogota, walkMinutes } from './utils/geo';
import { initCerca, setCercaLocation, setNearbyPoints, type NearbyPoint } from './ui/cerca';
import { POINT_KIND_META } from './data/pointKinds';
import { planActionsHtml } from './layers/popupActions';
import { escapeHTML, safeColor } from './utils/html';
import {
  applyZonalStopEnrichment,
  buildCatalogRouteList,
  buildRouteList,
  buildZonalStopGroups,
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

/**
 * A boot failure is usually transient (cold backend, a dropped request), so
 * offer the one recovery that exists instead of leaving a frozen overlay the
 * user has to diagnose as "reload the page".
 */
function showBootRetry(): void {
  const btn = document.getElementById('loading-retry');
  if (!btn) return;
  btn.classList.remove('hidden');
  btn.addEventListener('click', () => window.location.reload(), { once: true });
  (btn as HTMLButtonElement).focus();
}

function hideLoading(): void {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.remove(), 700);
  }
  revealPrerenderedPanel();
}

/**
 * Hands the prerendered panel (spec §5.5.4) to the reader instead of deleting it.
 *
 * These pages ship their content as real HTML so crawlers — and anyone whose
 * bundle has not run — get the stops, horarios and the estación plan without JS.
 * It used to be removed the moment the map went live, which meant a visitor
 * arriving from a search result read for about four seconds and then had the
 * page replaced under them by the map.
 *
 * Normally the panel is not dismissed here at all: a `/ruta/` or `/estacion/`
 * path opens its interactive page (§5.5.5, §5.5.6), which says everything the
 * static body says and adds the live data and the links, so it takes the body
 * over. This is the fallback for the case where no page opens — a station or
 * route this catalog cannot describe — where the panel stays until the reader
 * dismisses it. The button is injected here rather than emitted in the static
 * HTML on purpose: without JS there is no map to switch to, and a dead control
 * is worse than none.
 */
function revealPrerenderedPanel(): void {
  const panel = document.getElementById('seo-prerender');
  if (!panel || panel.querySelector('.seo-dismiss')) return;
  // A full page has already taken this panel's place with a live, richer copy of
  // the same content (spec §5.5.5, §5.5.6) — nothing left to hand over.
  if (isOverlayPageOpen()) return;

  const bar = document.createElement('div');
  bar.className = 'seo-dismiss';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Ver en el mapa';
  button.addEventListener('click', () => panel.remove(), { once: true });
  bar.appendChild(button);
  panel.querySelector('.wrap')?.prepend(bar);
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

// ─── ArcGIS Layer Recovery ────────────────────────────────
// The map layers fed by ArcGIS are fetched once, in parallel, at page open. A
// single transient upstream failure there used to be permanent for the session:
// the layer rendered empty (or from the catalog fallback) and nothing ever tried
// again, so a reload was the only cure — the "sometimes the trazado, sometimes
// the station pins are missing" symptom. Whatever degraded at boot is retried
// here on a widening schedule until it is whole, and applied in place through
// the layers' own update paths (spec §4.2, §1 priority 3 Stability).

const RECOVERY_DELAYS_MS = [4_000, 12_000, 30_000, 60_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ArcGIS cable stations → searchable/nearby points (Cerca + Explore search). */
function toCableNearbyPoints(cableStations: any[]): NearbyPoint[] {
  return cableStations
    .map((s: any): NearbyPoint => ({
      codigo: String(s.attributes?.cod_nodo ?? ''),
      name: s.attributes?.nom_est || 'Estación TransMiCable',
      coordinate: [Number(s.geometry?.x), Number(s.geometry?.y)],
      direccion: '',
      kind: 'cable',
    }))
    .filter((p) => p.codigo && Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));
}

/** ArcGIS cable stations → the shape the journey router indexes them by. */
function toCableRouterStations(cableStations: any[]): import('./services/router').CableStationInput[] {
  return cableStations
    .map((s: any) => ({
      codigo: String(s.attributes?.cod_nodo ?? ''),
      nombre: s.attributes?.nom_est || 'TransMiCable',
      coordinate: [Number(s.geometry?.x), Number(s.geometry?.y)] as [number, number],
      orden: Number(s.attributes?.num_est) || 0,
    }))
    .filter((s) => s.codigo && Number.isFinite(s.coordinate[0]) && Number.isFinite(s.coordinate[1]));
}

/** Retries `attempt` until it reports the layer whole (`true`) or the schedule
 *  runs out. Fire-and-forget: never blocks or rejects into the boot path. */
function recoverLayer(label: string, attempt: () => Promise<boolean>): void {
  void (async () => {
    for (const delay of RECOVERY_DELAYS_MS) {
      await sleep(delay);
      try {
        if (await attempt()) {
          console.info(`[Recovery] ${label} restored from upstream.`);
          return;
        }
      } catch (error) {
        console.warn(`[Recovery] ${label} retry failed:`, error);
      }
    }
    console.warn(`[Recovery] ${label} still unavailable after ${RECOVERY_DELAYS_MS.length} attempts.`);
  })();
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
/** Manual "actualizar ahora" — shared by the sidebar card and the route page. */
function refreshLiveNow(): void {
  void getBusesModule().then((buses) => buses.refreshLiveBusesNow()).catch(() => {});
}

setLiveRefreshHandler(refreshLiveNow);

// The full pages are URL-driven views over the same map, so the shell they open
// in is wired once at module scope: its Back/Forward listener and its in-app
// link interception have to exist before the first navigation, not after the
// catalog resolves (spec §5.5.5, §5.5.6).
initPageShell({ onShare: (url) => void shareLink(url) });

initRoutePage({
  onShowOnMap: (route) => {
    openSidebar();
    selectRouteByIdOrCode(route.id, route.code);
  },
  onLiveRefresh: refreshLiveNow,
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
let nearbyPersonalizacionPoints: NearbyPoint[] = [];
let nearbyBikeParkingPoints: NearbyPoint[] = [];
// TransMiCable gondola stations. They render on the map and the app already
// lists them under Cerca, but on the website they were in neither lookup
// surface — a rider could see Juan Pablo II on the map and not find it by name.
let nearbyCablePoints: NearbyPoint[] = [];
function pushNearbyPoints(): void {
  const union = [
    ...nearbyStationPoints,
    ...nearbyStopPoints,
    ...nearbyRechargePoints,
    ...nearbyPersonalizacionPoints,
    ...nearbyBikeParkingPoints,
    ...nearbyCablePoints,
  ];
  setNearbyPoints(union);
  // Same universe feeds the Explore search's station/paradero hits (§1.1 R2).
  setSearchPoints(union);
}

/**
 * Drops (or moves) the user-location marker, recentring the map when `fly`.
 * Geolocation is processed entirely client-side (no PII stored).
 *
 * It deliberately opens NOTHING. Placing the marker used to also open the popup
 * of the closest troncal station: the rider asked "what is near me", got the
 * ranked Cerca list they asked for AND a popup for one station they never
 * picked, covering the map — and, because the drag handler re-enters here, the
 * same popup re-opened on every nudge of the location dot. Choosing a point is
 * the list's job (`focusNearbyPoint`) and the map's; locating is not a choice.
 */
function placeUserMarker(
  map: maplibregl.Map,
  longitude: number,
  latitude: number,
  fly = true
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
}

/** Accent per POI kind — matches the `.near-dot` colours in style.css and the
 *  app's own POI sheet accents (spec §1.1 R2). */
const POI_ACCENT: Record<string, string> = {
  recharge: '#22c55e',
  personalizacion: '#a855f7',
  transmibici: '#38bdf8',
};

/**
 * Popup for a catalog POI — a tullave recharge or personalization counter, or a
 * TransMiBici cicloparqueadero. One renderer for all three: they differ only in
 * their accent, their kind label and their detail rows, and three near-copies is
 * exactly how the recharge card ended up the thinnest of them (spec §1.1 R2).
 *
 * These POIs have **no layer of their own**, so unlike an estación or a paradero
 * there is nothing on the map under the card: it asks for a `pinColor` so the
 * rider can see WHICH doorway on the block it is describing, and it carries the
 * same distance/walking line the Cerca row promised plus the `Desde aquí /
 * Hasta aquí` actions every other place popup has. It used to be an eyebrow, a
 * name, an address and one unlabelled time range.
 */
function showPoiPopup(map: maplibregl.Map, point: NearbyPoint): void {
  const meta = POINT_KIND_META[point.kind];
  const accent = POI_ACCENT[point.kind] ?? '#22c55e';

  const rows = (point.details ?? [])
    .map(
      (d) =>
        `<div class="popup-detail-row"><span class="popup-detail-label">${escapeHTML(d.label)}</span>` +
        `<span class="popup-detail-value">${escapeHTML(d.value)}</span></div>`
    )
    .join('');

  // The walk is measured from wherever the user dot currently sits — the same
  // origin the Cerca ranking used, so the two can never disagree.
  const from = userMarker?.getLngLat();
  const meters = from ? haversineMeters([from.lng, from.lat], point.coordinate) : NaN;
  const walk = Number.isFinite(meters)
    ? `<div class="popup-meta"><span>A ${escapeHTML(formatDistance(meters))} · ${walkMinutes(meters)} min a pie</span></div>`
    : '';

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow" style="color:${safeColor(accent)}">${escapeHTML(meta.fallback)}</div>
      <div class="popup-title">${escapeHTML(point.name)}</div>
      ${point.direccion ? `<div class="popup-meta"><span>${escapeHTML(point.direccion)}</span></div>` : ''}
      ${walk}
      ${rows ? `<div class="popup-details">${rows}</div>` : ''}
      ${planActionsHtml(point.name, point.coordinate)}
    </div>`;

  // Reuse the shared single-popup helper so a POI popup replaces (not stacks on
  // top of) any open station/stop popup — and so its pin dies with it. The
  // offset clears the pin's own height (34 px), or the card covers the marker it
  // exists to show.
  showPopup(map, point.coordinate, html, { offset: 38, maxWidth: '290px', pinColor: accent });
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

  // The master catalog is asked for **before** the map is waited on, and its
  // promise is reused by the parallel fetch below.
  //
  // Boot used to await the map style, then start every request. For a visitor
  // arriving on `/ruta/…` or `/estacion/…` from a search result that ordering is
  // backwards twice over: the page they came for is drawn from the catalog and
  // covers the map entirely, so they were made to wait for a style they cannot
  // see before the download they need was even issued (spec §1 priority 2).
  const catalogPromise = api.getMasterCatalog();

  // 1. Initialize map
  updateProgress(5, 'Cargando mapa...');
  const map = createMap('map');
  // Diagnostic handle for remote-devtools debugging of deployed builds (same
  // rationale as window.__tmStationAudit) — e.g. inspecting layer/source state
  // inside the Android webview via chrome://inspect.
  (window as Window & { __tmMap?: maplibregl.Map }).__tmMap = map;

  // The estación page (spec §5.5.6). Wired here rather than at module scope
  // because every one of its exits goes back to *this* map — the popup it came
  // from, the planner seeded with its coordinate — and the map does not exist
  // until boot. The URL resolver it registers is only consulted by a navigation,
  // which cannot happen before the page it navigates from is on screen.
  initStationPage({
    onShowOnMap: (station) => {
      if (!showStationPopupByCode(map, station.code, station.coordinate)) {
        // No rendered station to open a popup on (ArcGIS degraded, §4.2) — put
        // the reader over the place anyway rather than leaving them at the
        // city-wide view with nothing to show for the dismissal.
        map.easeTo({ center: station.coordinate, zoom: Math.max(map.getZoom(), 15) });
      }
    },
    onPlan: (role, station) => {
      // Dismiss without handing the station back to the map: re-opening its
      // popup here would fight the planner panel the reader just asked for.
      dismissOverlayPage();
      openSidebar();
      getPlannerModule()
        .then((planner) => planner.planFromPopup(role, station.name, station.coordinate, station.code))
        .catch((error) => console.error('[Planner] plan-from-station-page failed:', error));
    },
    onOpenRoute: (code) => {
      const route = routesWithCode(code)[0];
      if (!route) return;
      // Page first, then the map: `pushRouteHash` leaves a `/ruta/<code>/` path
      // that already names the selected route alone, so selecting afterwards
      // costs no second history entry — and it starts the live tracking whose
      // card this page is about to show.
      openRoutePage(route);
      selectRouteByIdOrCode(route.id, route.code);
    },
  });

  // A visitor from a prerendered estación page (`/estacion/<slug>-<codigo>/`,
  // spec §5.5.4) gets the interactive page as soon as the **catalog** lands —
  // not at the end of boot. Everything that page draws is catalog data, so
  // making it wait for the ArcGIS layers, the route list and four GeoJSON
  // sources the reader cannot see behind it cost about ten seconds of staring
  // at the static copy on a free-tier instance (§5.5.6). The ArcGIS extras it
  // *can* use — WiFi, biciestación, the node id the ridership dataset is keyed
  // on — arrive later and are patched in by `refreshStationPage` below.
  // Same for a route page (`/ruta/<code>/`, §5.5.5). It needs one route, not the
  // network, so the catalog build is scoped to that código — the full list walks
  // every route in the catalog and is the boot's own heaviest synchronous step.
  // `setRoutes` selects the route from the same path once that list exists, and
  // the enriched item is adopted then (`adoptRoutePage`), which is also what
  // starts live tracking.
  const deepRouteCode = parseRoutePathname();
  if (deepRouteCode) {
    void catalogPromise
      .then((res) => {
        if (!res.data?.routes) return;
        const target = buildCatalogRouteList(res.data, { onlyCode: deepRouteCode })[0];
        if (target) openRoutePage(target, { push: false });
      })
      .catch((error) => console.warn('[Deep link] Route page could not open early:', error));
  }

  const deepStationCode = parseStationPathname();
  if (deepStationCode) {
    void catalogPromise
      .then((res) => {
        const deepCatalog = res.data;
        if (!deepCatalog?.stations) return;
        setCatalog(deepCatalog);
        // `push: false` — the URL is already this page; pushing would wedge a
        // duplicate entry in front of the Back that should leave the site.
        openStationPage(deepStationCode, { push: false });
      })
      .catch((error) => console.warn('[Deep link] Estación page could not open early:', error));
  }

  // Wait for map to load (handle case where it might already be loaded).
  //
  // Boot is gated on this event, and it can legitimately never arrive: MapLibre
  // renders on requestAnimationFrame, which the browser freezes in a background
  // tab, so a page opened in a background tab (or restored from one) sat on the
  // loading overlay forever with no explanation. The wait itself is unchanged —
  // the style genuinely does finish once the tab is shown — but after a grace
  // period we say WHY nothing is happening instead of implying a hang.
  const MAP_LOAD_HINT_MS = 12_000;
  if (!map.loaded()) {
    let hintTimer: number | undefined = window.setTimeout(() => {
      setLoadingStatus(
        document.visibilityState === 'hidden'
          ? 'Esperando a que la pestaña esté visible para dibujar el mapa…'
          : 'El mapa está tardando más de lo normal…'
      );
      showBootRetry();
    }, MAP_LOAD_HINT_MS);
    await new Promise<void>((resolve) => {
      map.once('load', async () => {
        window.clearTimeout(hintTimer);
        hintTimer = undefined;
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
  let demandCount = 0;
  let cableRouterStations: import('./services/router').CableStationInput[] = [];

  let activeRouteId: string | null = null;
  // Routes whose geometry has already been upgraded from the light (320-pt,
  // spec §5.1.4) overview trace to the full-resolution official `trazado`.
  const fullTraceLoaded = new Set<string>();
  // ArcGIS-backed layers that opened degraded (upstream failed or answered
  // empty) and are therefore handed to the recovery pass below.
  const degradedLayers = new Set<'corridors' | 'stations' | 'cable' | 'stops'>();

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
      catalogPromise.then((res) => { incrementProgress(30, 'Descargando catálogo maestro...'); return res; }),
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
    // Indexed before anything reads the catalog: the station substitution below
    // asks which nodes are estaciones, and that answer comes from the catalog's
    // own stamp (§5.5.6). Indexing after it would drop every station whose code
    // is not `TM…` from the fallback layer — exactly when ArcGIS has failed and
    // the fallback is all there is.
    setCatalogIndexes(catalog);

    // ArcGIS is the primary station source; if it failed or came back empty,
    // rebuild the layer from the (required) master catalog so stations never
    // silently vanish from the map (spec §4.2).
    let stations = stationsRes.features.filter(isVisibleTroncalStation);
    if (stations.length === 0) {
      stations = catalogStationsToFeatures(catalog).filter(isVisibleTroncalStation);
      degradedLayers.add('stations');
      console.warn(`⚠️ ArcGIS stations unavailable — rebuilt ${stations.length} stations from master catalog`);
    }

    if (cableStations.length === 0 || cableTraces.length === 0) {
      // TransMiCable exists only in ArcGIS — there is no catalog equivalent, so
      // this layer can only be recovered, not substituted.
      degradedLayers.add('cable');
    }

    console.log(`✅ Troncal routes: ${troncalRoutes.length}`);
    console.log(`✅ Troncal corridors: ${corridorsRes.features.length}`);
    console.log(`✅ Stations: ${stations.length}`);
    console.log(`✅ Cable stations: ${cableStations.length}`);
    console.log(`✅ Cable traces: ${cableTraces.length}`);
    console.log(`✅ Master catalog: ${catalogRes.count} stations${catalogRes.stale ? ' (stale — sync in progress)' : ''}`);

    // Set catalog for station popups (route service types + station kinds are
    // already indexed above, before the station fallback reads them).
    setCatalog(catalog);

    // 2. Pre-calculate unified route list from API
    updateProgress(80, 'Procesando catálogo...');
    routeList = buildRouteList(troncalRoutes, catalog);
    const troncalListItems = routeList.filter(r => r.type === 'troncal');
    const zonalListItems = routeList.filter(r => r.type === 'zonal');

    // 3. Add route/corridor layers. The trunk corridors are ArcGIS-only survey
    // geometry, so when that fetch degrades they are reconstructed from the
    // official catalog traces of the routes that ride them (spec §4.2).
    updateProgress(85, 'Dibujando troncales...');
    let corridorFeatures = corridorsRes.features;
    if (corridorFeatures.length === 0) {
      corridorFeatures = catalogCorridorsToFeatures(troncalListItems);
      degradedLayers.add('corridors');
      console.warn(`⚠️ ArcGIS corridors unavailable — rebuilt ${corridorFeatures.length} trunk corridors from catalog traces`);
    }
    addTroncalCorridorsLayer(map, corridorFeatures);

    updateProgress(90, 'Dibujando rutas...');
    addTroncalRoutesLayer(map, troncalListItems);

    updateProgress(95, 'Renderizando estaciones...');
    addStationsLayer(map, stations);
    stationCount = stations.length;

    // The resolved ArcGIS stations are what carry a station's WiFi, its
    // biciestación and — the one that matters — the node id the open ridership
    // dataset is keyed on (§5.5.6). A page opened early off the catalog has none
    // of that yet, so it is re-rendered here now that it does.
    refreshStationPage();

    // Seed the Cerca point universe with troncal estaciones (zonal paraderos
    // are appended once the background load resolves them). Names come from the
    // layer's RESOLVED points so verified splits (Av. Jiménez, Ricaurte) list
    // under the same label the map shows, not the raw ArcGIS name.
    nearbyStationPoints = getStationDisplayPoints().map((p): NearbyPoint => ({
      codigo: p.codigo,
      name: p.name,
      coordinate: p.coordinate,
      direccion: p.direccion,
      kind: 'station',
    }));

    // 4. Mappings and Stops (Initialize empty stops layer first, background load will update it)
    updateProgress(98, 'Renderizando rutas zonales...');
    addZonalRoutesLayer(map, zonalListItems);

    addStopsLayer(map, [], new Map());

    addCableLayers(map, cableStations, cableTraces);
    cableStationsCount = cableStations.length;
    cableTracesCount = cableTraces.length;

    // Build the cable-station list the router uses for the TransMiCable line,
    // and make the same stations findable by name (Cerca + Explore search).
    cableRouterStations = toCableRouterStations(cableStations);
    nearbyCablePoints = toCableNearbyPoints(cableStations);

    bringTroncalLayersToFront(map);
    bringStationsLayerToFront(map);
    bringStopsLayerToFront(map);
    bringCableLayersToFront(map);
  } catch (error) {
    console.error('❌ Error loading data:', error);
    // Prerendered pages (spec §5.5.4) suppress the boot overlay so a visitor from
    // a search result reads the stops immediately instead of a progress bar. The
    // overlay is also the only surface an error has, so a *real* failure takes
    // the suppression off. Deliberately not wired to `showBootRetry()`: that also
    // fires as a 12 s "this is slow" hint, which would cover perfectly good
    // prerendered content with a spinner whenever the tab was merely backgrounded.
    document.body.classList.remove('seo-static');
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.classList.add('error-state');
    }
    setLoadingStatus(`Error al cargar datos. ${getErrorMessage(error)}`);
    showBootRetry();
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

  // Shared point-focus flow: move to the point and open its popup. Used by the
  // Cerca rows and the Explore search's station/paradero hits (spec §1.1 R2).
  //
  // `jumpTo`, not `flyTo`: every popup here ends up in `showPopup`
  // (layers/popup.ts), which runs its own `easeTo` to slide the point clear of
  // the sidebar — and that ease carries no zoom, so it cancelled the animated
  // zoom started here a frame earlier. The result was that tapping a Cerca or
  // Explore result recentred the map but never actually zoomed in, for every
  // point kind. Setting the zoom instantly means the popup's recentre inherits
  // it and still animates the pan.
  const focusNearbyPoint = (point: NearbyPoint): void => {
    map.jumpTo({ center: point.coordinate, zoom: 15 });
    if (point.kind === 'recharge' || point.kind === 'personalizacion' || point.kind === 'transmibici') {
      showPoiPopup(map, point);
    } else if (point.kind === 'cable') {
      showCableStationPopup(map, { name: point.name, code: point.codigo, coordinate: point.coordinate });
    } else if (point.kind === 'station') {
      const resolved = showStationPopupByCode(map, point.codigo, point.coordinate);
      if (!resolved) showStopPopupByCode(map, point.codigo, point.name, point.coordinate, point.direccion);
    } else {
      showStopPopupByCode(map, point.codigo, point.name, point.coordinate, point.direccion);
    }
  };

  initSidebar({
    onRouteSelect: async (route: RouteListItem) => {
      activeRouteId = route.id;

      // Cold-start removal: the live request is the slowest thing in this
      // handler (CO egress, spec §5.2), so it starts HERE — before the full
      // trace fetch, the 3D layer import and the map work below — and runs
      // alongside them. `startBusTracking`'s first poll then lands on this
      // same in-flight request instead of beginning one (services/api.ts).
      route.liveNameCandidates = getLiveNameCandidates(route);
      prefetchLiveBuses(
        route.code,
        route.liveNameCandidates[0] || route.catalogNombre || route.name || route.destination,
        route.type,
        route.liveNameCandidates
      );
      void getBusesModule();

      await stopLiveBusTracking();

      // Upgrade the selected route to its FULL official trace + stops. The
      // overview list carries the light (320-pt, spec §5.1.4) trace, so the
      // highlighted route is re-hydrated from the route-detail endpoint
      // (full-resolution `variant.trazado`, straight from the catalog) to be
      // displayed 100% as the TransMi app provides it. Done once per route.
      // It is a resolution upgrade only: since ArcGIS stopped overwriting the
      // catalog trace (`routeCatalog.ts`, spec §4.2/§5.6.3) the list already
      // carries the same `trazado`, just simplified for transport.
      if (route.source === 'catalog' && !fullTraceLoaded.has(route.id)) {
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
              if (detailGeometry) {
                route.geometry = detailGeometry;
                // The planner holds this same object and indexed its trace at
                // boot (§5.6.3); re-index so it rides the trace the route now
                // claims instead of the coarser one it was built from.
                const { refreshRouteTrace } = await import('./services/router');
                refreshRouteTrace(route.id);
              }
              // Same precedence as `buildCatalogRouteList`: the dual test is a
              // heuristic over the stop mix, and a feeder that reaches a portal
              // trips it — promoting alimentador 1-1 to "padrón" the moment its
              // detail arrived, undoing the classification the list got right.
              if (routeHasDualStops(vStops) && route.subType !== 'alimentador') {
                route.subType = 'dual';
              }
              if (!route.stops || route.stops.length === 0) {
                route.stops = dedupeStops(vStops.map((stop: any) => parseCatalogStop(stop, variant, catalog)).filter((stop: RouteStop | null): stop is RouteStop => Boolean(stop)));
              }
              fullTraceLoaded.add(route.id);
            }
          }
        } catch (error) {
          console.error(`❌ Error fetching details for route ${route.code}:`, error);
          if (activeRouteId !== route.id) return;
        }
      }

      refreshRouteDetail(route);
      // The paradas and the full trace land here, after selection — a route page
      // opened from a search result would otherwise sit on "Cargando paradas…".
      refreshRoutePage(route);
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
    onPointSelect: focusNearbyPoint,
    onRouteOpenPage: (route: RouteListItem) => openRoutePage(route),
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
        case 'demand':
          toggleDemandLayer(map, visible);
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
      bringDemandLayerToFront(map);
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

  // Cerca tab — nearest stations/paraderos by GPS. Reuses the map's location
  // cascade + user marker so nothing is duplicated (spec §1.1 R2).
  initCerca({
    resolveLocation: () => resolveUserLocation(),
    onLocated: (lng, lat, source) => placeUserMarker(map, lng, lat, source === 'gps'),
    onSelect: focusNearbyPoint,
  });
  pushNearbyPoints();

  // The two tullave POI catalogues (static, spec §5.8) → the "Recargas" and
  // "Personalización" kinds in Cerca and the Explore search. One upstream model
  // serves both, so one loader does too (spec §1.1 R2).
  const loadTuLlavePoints = (
    fetchPoints: () => Promise<RechargePointsResponse>,
    kind: 'recharge' | 'personalizacion',
    prefix: string,
    assign: (points: NearbyPoint[]) => void
  ) =>
    fetchPoints()
      .then((res) => {
        if (!res.success || !res.points) return;
        assign(
          res.points
            .map((p, i): NearbyPoint => ({
              codigo: `${prefix}-${i}`,
              name: p.nombre,
              coordinate: [p.longitud, p.latitud],
              direccion: [p.direccion, p.localidad].filter(Boolean).join(' · '),
              kind,
              // `hds` is the weekday row. This read `wks` — Sundays/holidays —
              // so a counter open right now could show its "No Opera" Sunday
              // value as if it were closed (spec §1 certainty).
              hours: p.hds,
              // The popup has room for all three windows, each under the day it
              // actually covers (§5.5.1): the row's single line cannot say
              // whether a counter is open on the Saturday the rider is planning.
              details: [
                { label: 'Lun–Vie', value: p.hds },
                { label: 'Sábados', value: p.exs },
                { label: 'Dom y festivos', value: p.wks },
              ].filter((d): d is { label: string; value: string } => Boolean(d.value)),
            }))
            .filter((p) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]))
        );
        pushNearbyPoints();
      })
      .catch((error) => console.warn(`[tullave] Failed to load ${kind} points:`, error));

  loadTuLlavePoints(api.getRechargePoints, 'recharge', 'rp', (points) => { nearbyRechargePoints = points; });
  loadTuLlavePoints(api.getPersonalizacionPoints, 'personalizacion', 'pp', (points) => { nearbyPersonalizacionPoints = points; });

  // Station demand heat overlay (open Salidas dataset, spec §5.8). Off by
  // default; adds its own toggle-driven layer without touching station render.
  api.getStationDemand()
    .then((res) => {
      if (!res.success || !res.stations?.length) return;
      addDemandLayer(map, res.stations);
      demandCount = res.stations.length;
      bringDemandLayerToFront(map);
      updateCounts({ demand: demandCount });
    })
    .catch((error) => console.warn('[Demand] Failed to load station demand:', error));

  // TransMiBici bike-parking POIs (static catalog, spec §5.3) → Cerca "Bici" kind.
  api.getTransmibici()
    .then((res) => {
      if (!res.success || !res.points) return;
      nearbyBikeParkingPoints = res.points
        .map((p, i): NearbyPoint => ({
          codigo: `tb-${i}`,
          name: p.nombre,
          coordinate: [p.lon, p.lat],
          direccion: '',
          kind: 'transmibici',
          hours: p.cupos != null ? `${p.cupos} cupos${p.ocupacion != null ? ` · ocupación ~${p.ocupacion}` : ''}` : undefined,
          details: [
            p.cupos != null ? { label: 'Cupos', value: String(p.cupos) } : null,
            p.ocupacion != null ? { label: 'Ocupación', value: `~${p.ocupacion}` } : null,
          ].filter((d): d is { label: string; value: string } => d !== null),
        }))
        .filter((p) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));
      pushNearbyPoints();
    })
    .catch((error) => console.warn('[TransMiBici] Failed to load bike parking:', error));

  // Android hardware-back close chain (native shell only; no-op on the web).
  initNativeBack();

  // One place builds the counts payload — boot, background enrichment and the
  // recovery pass all push the same shape (spec §1.1 R2).
  const refreshLayerCounts = (): void => {
    updateCounts({
      troncal: routeCounts.troncal,
      zonal: routeCounts.zonal,
      stations: stationCount,
      stops: stopsCount,
      cable: cableTracesCount,
      cableStations: cableStationsCount,
    });
  };

  setRoutes(routeList);
  refreshLayerCounts();

  // The page itself opened as soon as the catalog landed (above), on an item
  // built for that código alone. Now that the merged list exists — ArcGIS
  // geometry folded in, and `setRoutes` having selected the route from the same
  // path, so the map behind is drawing it and live tracking is running — the
  // page adopts the enriched item in place. `openRoutePage` still covers the
  // case where the early build found nothing (a código only ArcGIS knows).
  if (deepRouteCode) {
    const target = routesWithCode(deepRouteCode)[0];
    if (target) {
      if (isRoutePageOpen()) adoptRoutePage(target);
      else openRoutePage(target, { push: false });
    }
  }

  // The estación page itself opened as soon as the catalog landed (above); what
  // is left is the map *underneath* it, so that dismissing the page is an
  // arrival rather than a search. Deferred to the map's first idle: boot is
  // still settling the initial camera at this point and a move issued into that
  // window is discarded, which used to leave the reader at the city-wide
  // default.
  if (deepStationCode) {
    const station = catalog.stations[deepStationCode] ?? Object.values(catalog.stations).find(
      (s) => String(s.codigo).toUpperCase() === deepStationCode
    );
    const [lat, lon] = String(station?.coordenada ?? '').split(',').map((n) => Number(n.trim()));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      map.once('idle', () => map.jumpTo({ center: [lon, lat], zoom: 15 }));
    }
  }

  // 4. Done with initial render!
  console.log('🎉 TransMilenio Explorer initial render ready!');
  updateProgress(100, '¡Listo!');
  setTimeout(() => {
    hideLoading();
    getPlannerModule()
      .then(({ initPlanner }) => initPlanner(map, routeList, cableRouterStations))
      .catch((error) => console.error('[Planner] Failed to load planner module:', error));
  }, 400);

  // Applies a zonal stops + stop-route-mapping payload to the map, the route
  // stop lists, the Cerca universe and the routing graph. Shared by the initial
  // background load and by the recovery pass, so a late-arriving payload lands
  // through exactly the same pipeline (spec §1.1 R2). Reports whether the
  // payload was usable.
  const applyZonalStops = (zonalStops: any[], zonalStopRoutes: any[]): boolean => {
    if (zonalStops.length === 0 || zonalStopRoutes.length === 0) return false;

    // Enrich stop lists only (direction-split + orden-sorted, shared with
    // buildRouteList and the mobile app — spec §1.1 R2). Route lines must
    // come from official trazado data.
    applyZonalStopEnrichment(routeList, buildZonalStopGroups(zonalStops, zonalStopRoutes));

    // Update zonal routes map source with newly loaded geometries
    updateZonalRoutes(map, routeList.filter(r => r.type === 'zonal'));

    // Build complete stopRoutesMap and update the stops layer
    updateStopsLayer(map, zonalStops, buildStopRoutesMap(zonalStopRoutes, catalog));

    stopsCount = zonalStops.length;

    // Append zonal paraderos to the Cerca point universe.
    nearbyStopPoints = zonalStops
      .map((s: any): NearbyPoint => ({
        codigo: String(s.attributes?.cenefa ?? ''),
        name: s.attributes?.nombre || 'Paradero',
        coordinate: [Number(s.geometry?.x), Number(s.geometry?.y)],
        direccion: s.attributes?.direccion_bandera || s.attributes?.via || '',
        kind: 'stop',
      }))
      .filter((p: NearbyPoint) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));
    pushNearbyPoints();
    refreshLayerCounts();

    // Rebuild the routing graph with the fully enriched zonal stops.
    getRouterModule()
      .then(({ initRouter }) => initRouter(routeList, cableRouterStations))
      .catch((error) => console.error('[Router] Failed to refresh graph:', error));

    return true;
  };

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

      if (applyZonalStops(zonalStopsRes.features, zonalStopRoutesRes.features)) {
        console.log('🎉 TransMilenio Explorer background load & enrichment complete!');
      } else {
        degradedLayers.add('stops');
        console.warn('⚠️ Zonal paraderos unavailable — scheduling recovery');
      }

      if (zonalRoutesRes.features.length === 0) {
        recoverLayer('SITP zones', async () => {
          const res = await api.getZonalRoutes();
          if (!res.features?.length) return false;
          buildZonalAreas(res.features, routeList);
          setAvailableZones(getZones());
          return true;
        });
      }

      // Warm the live-tracking assets while the app is idle: the bus layer
      // chunk (three.js) and the Draco-decoded LOD model are otherwise both
      // downloaded *after* the user selects a route, delaying the first buses
      // by a chunk + model load on top of the live request itself.
      getBusesModule()
        .then((buses) => buses.preloadBusModels())
        .catch((error) => console.warn('[Live] Bus asset preload skipped:', error));
    } catch (bgError) {
      console.error('❌ Error during background load:', bgError);
    }

    // 6. Recovery: upgrade every layer that opened degraded. Scheduled after the
    //    background load so the retries don't compete with it for the server's
    //    (single, shared-CPU) request budget.
    if (degradedLayers.has('corridors')) {
      recoverLayer('Troncal corridors', async () => {
        const res = await api.getTroncalCorridors();
        if (!res.features?.length) return false;
        addTroncalCorridorsLayer(map, res.features);
        bringTroncalLayersToFront(map);
        return true;
      });
    }

    if (degradedLayers.has('stations')) {
      recoverLayer('Troncal stations', async () => {
        const res = await api.getTroncalStations();
        const stations = res.features?.filter(isVisibleTroncalStation) ?? [];
        if (stations.length === 0) return false;
        addStationsLayer(map, stations);
        stationCount = stations.length;
        nearbyStationPoints = getStationDisplayPoints().map((p): NearbyPoint => ({
          codigo: p.codigo,
          name: p.name,
          coordinate: p.coordinate,
          direccion: p.direccion,
          kind: 'station',
        }));
        pushNearbyPoints();
        refreshLayerCounts();
        bringStationsLayerToFront(map);
        return true;
      });
    }

    if (degradedLayers.has('cable')) {
      recoverLayer('TransMiCable', async () => {
        const [stationsRes, tracesRes] = await Promise.all([api.getCableStations(), api.getCableTrazado()]);
        const stations = stationsRes.features ?? [];
        const traces = tracesRes.features ?? [];
        if (stations.length === 0 || traces.length === 0) return false;
        addCableLayers(map, stations, traces);
        cableStationsCount = stations.length;
        cableTracesCount = traces.length;
        refreshLayerCounts();
        bringCableLayersToFront(map);
        // The router indexed an empty cable line at boot — rebuild it so the
        // planner can route over TransMiCable again, and make the recovered
        // stations searchable too.
        cableRouterStations = toCableRouterStations(stations);
        nearbyCablePoints = toCableNearbyPoints(stations);
        pushNearbyPoints();
        getRouterModule()
          .then(({ initRouter }) => initRouter(routeList, cableRouterStations))
          .catch((error) => console.error('[Router] Failed to refresh graph:', error));
        return true;
      });
    }

    if (degradedLayers.has('stops')) {
      recoverLayer('Zonal paraderos', async () => {
        const [stopsRes, stopRoutesRes] = await Promise.all([api.getZonalStops(), api.getZonalStopRoutes()]);
        if (!applyZonalStops(stopsRes.features ?? [], stopRoutesRes.features ?? [])) return false;
        bringStopsLayerToFront(map);
        return true;
      });
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
