/**
 * Core data pipeline for the mobile app.
 *
 * Reuses the website's service layer verbatim — the shared `api` client and the
 * shared `buildRouteList` (spec §1.1 R2). The mobile app only differs in *how*
 * it presents this data, never in how it's fetched or normalized.
 */

import { api } from '@shared/services/api';
import { applyZonalStopEnrichment, buildRouteList, buildZonalStopGroups, isStationStopCode } from '@shared/data/routeCatalog';
import { buildZonalAreas, getZoneLabel, getZones } from '@shared/data/zones';
import { setRouteTypeIndex } from '@shared/utils/routeType';
import { isNativeLiveAvailable } from '@shared/services/nativeLive';
import { isLiveBridgeAvailable } from '@shared/services/liveBridge';
import type {
  BikeParking,
  RechargePoint,
  RechargePointsResponse,
  StationDemandResponse,
  TransmibiciResponse,
} from '@shared/services/api';
import type { MasterCatalog, MasterCatalogResponse } from '@shared/types/catalog';
import type { ApiResponse, RouteListItem, TroncalRouteFeature } from '@shared/types/transmilenio';
import { bus, setRoutes, state, type DemandRecord, type HealthInfo, type StationRecord } from './state';
import { idbGet, idbSet } from './lib/cache';

// APK-bundled offline datasets. On a Colombian phone the app hits the official
// government hosts directly for everything dynamic (spec §5.2.1b), but the master
// catalog and the offline-aggregated POI/demand payloads have no single official
// endpoint — so they ship inside the APK, generated from the committed server
// data by `npm run bundle:mobile` (see server/src/bundle_mobile_data.ts). `?url`
// keeps the heavy catalog out of the JS bundle; Capacitor serves it locally.
import catalogAssetUrl from './generated/catalog.light.json?url';
import recargaAssetUrl from './generated/recarga_points.json?url';
import personalizacionAssetUrl from './generated/personalizacion_points.json?url';
import transmibiciAssetUrl from './generated/transmibici.json?url';
import demandAssetUrl from './generated/station_demand.json?url';

const CATALOG_KEY = 'catalog:v1';

const LIVE_RELAY_URL = String(import.meta.env.VITE_LIVE_RELAY_URL || '');

/** Fetch a bundled JSON asset from the local APK origin (no network). */
async function loadBundledJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bundled asset ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** Catalog: bundled asset in the app, our API on the website. */
function fetchCatalogResponse(): Promise<MasterCatalogResponse> {
  return state.native ? loadBundledJson<MasterCatalogResponse>(catalogAssetUrl) : api.getMasterCatalog();
}

// Static POI/demand datasets: bundled assets in the app (each wrapped in the same
// `{ success, ... }` envelope its API endpoint returns), our API on the website.
async function fetchRechargePoints(): Promise<RechargePointsResponse> {
  if (!state.native) return api.getRechargePoints();
  const points = await loadBundledJson<RechargePoint[]>(recargaAssetUrl);
  return { success: true, count: points.length, points };
}

async function fetchPersonalizacionPoints(): Promise<RechargePointsResponse> {
  if (!state.native) return api.getPersonalizacionPoints();
  const points = await loadBundledJson<RechargePoint[]>(personalizacionAssetUrl);
  return { success: true, count: points.length, points };
}

async function fetchTransmibici(): Promise<TransmibiciResponse> {
  if (!state.native) return api.getTransmibici();
  const points = await loadBundledJson<BikeParking[]>(transmibiciAssetUrl);
  return { success: true, count: points.length, points };
}

async function fetchStationDemand(): Promise<StationDemandResponse> {
  if (!state.native) return api.getStationDemand();
  const demand = await loadBundledJson<Omit<StationDemandResponse, 'success'>>(demandAssetUrl);
  return { success: true, ...demand };
}

function parseLatLng(coordenada: string | undefined): [number, number] | null {
  if (!coordenada || !coordenada.includes(',')) return null;
  const [lat, lng] = coordenada.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lng, lat];
}

/**
 * Splits the master catalog's `stations` map — which mixes troncal ESTACIONES
 * and zonal PARADEROS — into the two typed lists the UI needs. The light catalog
 * served by the API carries no `sistema`, so classification is by CODE: canonical
 * `TM…`-coded nodes (≈140) are troncal estaciones, everything else is a paradero
 * (cenefa-coded, ≈7000). Both are catalog-derived so they're available instantly
 * on a cache boot — no ArcGIS round-trip needed.
 */
function catalogPointRecords(catalog: MasterCatalog): { stations: StationRecord[]; paraderos: StationRecord[] } {
  const stations: StationRecord[] = [];
  const paraderos: StationRecord[] = [];
  for (const st of Object.values(catalog.stations || {})) {
    const coordinate = parseLatLng(st.coordenada);
    if (!coordinate) continue;
    const isStation = isStationStopCode(st.codigo);
    (isStation ? stations : paraderos).push({
      code: st.codigo || st.id,
      name: st.nombre || (isStation ? 'Estación' : 'Paradero'),
      direccion: st.direccion || '',
      coordinate,
      wagonCount: st.wagons ? Object.keys(st.wagons).length : 0,
      kind: isStation ? 'station' : 'stop',
    });
  }
  return { stations, paraderos };
}

function unwrap<T>(res: PromiseSettledResult<ApiResponse<T>>): T[] {
  return res.status === 'fulfilled' && res.value.success ? res.value.features || [] : [];
}

/** Non-native (browser dev) API base — the app itself hits official hosts directly. */
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

/** Wake the (possibly cold) backend before firing heavy requests. In the app the
 *  catalog is a bundled asset and there is no backend to wake, so this is a no-op. */
export function wakeBackend(): Promise<unknown> {
  if (state.native) return Promise.resolve();
  return fetch(`${API_BASE}/health`).catch(() => undefined);
}

/** Build routes/stations/counts from a catalog (+ optional ArcGIS troncal geometry). */
function applyCatalog(catalog: MasterCatalog, troncalRoutes: TroncalRouteFeature[] = [], corridorCount?: number): void {
  state.catalog = catalog;
  setRouteTypeIndex(catalog);
  const routes = buildRouteList(troncalRoutes, catalog);
  const { stations, paraderos } = catalogPointRecords(catalog);
  state.stations = stations;
  state.zonalStops = paraderos;
  state.counts = {
    troncal: routes.filter((r) => r.type === 'troncal').length,
    zonal: routes.filter((r) => r.type === 'zonal').length,
    stations: stations.length,
    stops: paraderos.length,
    cable: corridorCount ?? state.counts.cable,
  };
  setRoutes(routes);
}

/** Cheap signature to detect whether a fresh catalog differs from the cached one. */
function catalogSignature(payload: MasterCatalogResponse): string {
  const c = payload.data || { stations: {}, routes: {} };
  return `${payload.count}:${Object.keys(c.routes || {}).length}:${Object.keys(c.stations || {}).length}`;
}

/** Fetch the fresh catalog + ArcGIS troncal layers. Throws if the catalog is unreachable. */
async function fetchFresh(): Promise<{ payload: MasterCatalogResponse; troncalRoutes: TroncalRouteFeature[]; corridorCount: number }> {
  const [troncalRes, corridorsRes, catalogRes] = await Promise.allSettled([
    api.getTroncalRoutes(),
    api.getTroncalCorridors(),
    fetchCatalogResponse(),
  ]);
  if (catalogRes.status !== 'fulfilled') {
    throw new Error(catalogRes.reason instanceof Error ? catalogRes.reason.message : 'catálogo no disponible');
  }
  return {
    payload: catalogRes.value as MasterCatalogResponse,
    troncalRoutes: unwrap<TroncalRouteFeature>(troncalRes as PromiseSettledResult<ApiResponse<TroncalRouteFeature>>),
    corridorCount: corridorsRes.status === 'fulfilled' ? corridorsRes.value.features.length : 0,
  };
}

/**
 * Cache-first boot (stale-while-revalidate). A returning user paints instantly
 * from the IndexedDB-cached catalog while a fresh copy is fetched in the
 * background; a first-time user waits for the network once. Throws only when
 * there is neither a cache nor a reachable catalog (spec §4.2 — catalog is
 * critical, everything else degrades).
 */
export async function loadCore(onProgress: (pct: number, label: string) => void): Promise<void> {
  const cached = await idbGet<MasterCatalogResponse>(CATALOG_KEY);
  if (cached?.data && Object.keys(cached.data.routes || {}).length > 0) {
    onProgress(85, 'Cargando desde caché…');
    applyCatalog(cached.data);
    onProgress(100, '¡Listo!');
    // Revalidate silently; don't block boot on the (possibly cold) network.
    void revalidate(catalogSignature(cached));
    return;
  }

  onProgress(14, 'Despertando el servidor…');
  await wakeBackend();
  onProgress(35, 'Descargando catálogo maestro…');
  const fresh = await fetchFresh();
  onProgress(82, 'Trazando rutas…');
  applyCatalog(fresh.payload.data || { stations: {}, routes: {} }, fresh.troncalRoutes, fresh.corridorCount);
  // Persist for next launch without delaying first paint.
  void idbSet(CATALOG_KEY, fresh.payload);
}

/**
 * Background refresh after a cache-first boot. Only re-applies (and re-caches)
 * when the catalog actually changed — avoids re-rendering the list under the
 * user on the common no-change launch.
 */
async function revalidate(cachedSig: string): Promise<void> {
  try {
    const fresh = await fetchFresh();
    if (catalogSignature(fresh.payload) === cachedSig) return; // unchanged — keep cache paint
    applyCatalog(fresh.payload.data || { stations: {}, routes: {} }, fresh.troncalRoutes, fresh.corridorCount);
    await idbSet(CATALOG_KEY, fresh.payload);
  } catch (err) {
    console.warn('[data] catalog revalidation failed (using cache):', err);
  }
}

// SITP zone taxonomy (spec §5.4.2a) — `variantBase`, the zone index and the
// landmark-derived zone labels live in `@shared/data/zones`, shared verbatim with
// the website. They used to be a ~95-line copy here, including a hand-curated
// 33-entry landmark list that had to stay byte-identical in two files for the two
// clients to agree on what "Zona 4" means (spec §1.1 R2, §5.2.1b).
export { getZonalAreas, variantBase } from '@shared/data/zones';

/** Mirrors the shared zone index into the app's own reactive state. */
function applyZonalAreas(features: any[]): void {
  buildZonalAreas(features, state.routes);
  state.zones = getZones();
  state.zoneLabels = new Map(
    getZones()
      .map((zone) => [zone, getZoneLabel(zone)] as const)
      .filter(([, label]) => label !== '')
  );
}

/** Background pass: SITP zones + enrich zonal routes with their stops and stop records. */
export async function loadBackground(): Promise<void> {
  const [zonalRes, stopsRes, mapRes] = await Promise.allSettled([
    api.getZonalRoutes(),
    api.getZonalStops(),
    api.getZonalStopRoutes(),
  ]);

  applyZonalAreas(unwrap<any>(zonalRes as PromiseSettledResult<ApiResponse<any>>));

  const stops = unwrap<any>(stopsRes as PromiseSettledResult<ApiResponse<any>>);
  const mappings = unwrap<any>(mapRes as PromiseSettledResult<ApiResponse<any>>);
  if (stops.length === 0) {
    bus.emit('stops:ready', undefined); // still surfaces the zones we just built
    return;
  }

  // Enrich zonal routes missing stops (direction-split + orden-sorted, shared
  // with the website — spec §5.4.2, §1.1 R2).
  if (mappings.length > 0) {
    applyZonalStopEnrichment(state.routes as RouteListItem[], buildZonalStopGroups(stops, mappings));
  }

  // Paraderos themselves come from the catalog at boot (catalogPointRecords) — the
  // ArcGIS zonal stops are used only for the route-stop enrichment above and the
  // SITP zones built earlier. Signal the zones/enrichment are ready.
  bus.emit('stops:ready', undefined);

  // The two tullave POI catalogues (static, spec §5.8) → the Cerca/Buscar
  // "Recargas" and "Personalización" kinds. Independent of the enrichment above,
  // so they don't block the ready signal. One upstream model serves both, so one
  // loader does too (spec §1.1 R2).
  const loadTuLlavePoints = (
    fetchPoints: () => Promise<RechargePointsResponse>,
    kind: 'recharge' | 'personalizacion',
    prefix: string,
    assign: (points: StationRecord[]) => void
  ) =>
    fetchPoints()
      .then((res) => {
        if (!res.success || !res.points) return;
        assign(
          res.points
            .map((p, i): StationRecord => ({
              code: `${prefix}-${i}`,
              name: p.nombre,
              direccion: [p.direccion, p.localidad].filter(Boolean).join(', '),
              coordinate: [p.longitud, p.latitud],
              wagonCount: 0,
              kind,
              // `hds` is the weekday row. This read `wks` — Sundays/holidays —
              // so a counter open right now could show its "No Opera" Sunday
              // value as if it were closed (spec §1 certainty).
              hours: p.hds,
            }))
            .filter((p) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]))
        );
        bus.emit('stops:ready', undefined);
      })
      .catch((err) => console.warn(`[data] ${kind} points load failed:`, err));

  loadTuLlavePoints(fetchRechargePoints, 'recharge', 'rp', (points) => { state.rechargePoints = points; });
  loadTuLlavePoints(fetchPersonalizacionPoints, 'personalizacion', 'pp', (points) => { state.personalizacionPoints = points; });

  // TransMiBici bike-parking POIs (static catalog, spec §5.5.1) → Cerca "Bici" kind.
  fetchTransmibici()
    .then((res) => {
      if (!res.success || !res.points) return;
      state.bikeParkings = res.points
        .map((p, i): StationRecord => ({
          code: `tb-${i}`,
          name: p.nombre,
          direccion: '',
          coordinate: [p.lon, p.lat],
          wagonCount: 0,
          kind: 'transmibici',
          hours: p.cupos != null ? `${p.cupos} cupos${p.ocupacion != null ? ` · ocupación ~${p.ocupacion}` : ''}` : undefined,
        }))
        .filter((p) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));
      bus.emit('stops:ready', undefined);
    })
    .catch((err) => console.warn('[data] transmibici load failed:', err));

  // TransMiCable (spec §5.3): gondola stations + trazado. Native app fetches
  // ArcGIS directly; browser dev hits our /cable/* endpoints. Feeds the map
  // cable layer, the Cerca "Cable" kind, and the planner's cable routing — the
  // exact field mapping the website uses (main.ts) so the two never drift.
  Promise.allSettled([api.getCableStations(), api.getCableTrazado()])
    .then(([stationsRes, tracesRes]) => {
      const stations = unwrap<any>(stationsRes as PromiseSettledResult<ApiResponse<any>>);
      const traces = unwrap<any>(tracesRes as PromiseSettledResult<ApiResponse<any>>);
      if (stations.length === 0 && traces.length === 0) return;

      state.cableTraces = traces;
      state.cableStations = stations
        .map((s: any): StationRecord => ({
          code: String(s.attributes?.cod_nodo ?? ''),
          name: s.attributes?.nom_est || 'Estación TransMiCable',
          direccion: '',
          coordinate: [Number(s.geometry?.x), Number(s.geometry?.y)],
          wagonCount: 0,
          kind: 'cable',
        }))
        .filter((s) => s.code && Number.isFinite(s.coordinate[0]) && Number.isFinite(s.coordinate[1]));
      state.cableRouterStations = state.cableStations.map((s) => {
        const src = stations.find((f: any) => String(f.attributes?.cod_nodo ?? '') === s.code);
        return { codigo: s.code, nombre: s.name, coordinate: s.coordinate, orden: Number(src?.attributes?.num_est) || 0 };
      });
      state.counts.cable = state.cableStations.length;
      bus.emit('cable:ready', undefined);
    })
    .catch((err) => console.warn('[data] cable load failed:', err));

  // Station-demand overlay data (open Salidas dataset, spec §5.5.1) → Mapa
  // "Demanda" filter. Small committed payload; loads once in the background.
  fetchStationDemand()
    .then((res) => {
      if (!res.success || !res.stations?.length) return;
      state.demand = res.stations
        .map((s): DemandRecord => ({
          name: s.nombre,
          coordinate: [s.lon, s.lat],
          entradas: s.entradas,
          salidas: s.salidas,
          total: s.total,
          rank: s.rank,
        }))
        .filter((d) => Number.isFinite(d.coordinate[0]) && Number.isFinite(d.coordinate[1]));
      bus.emit('demand:ready', undefined);
    })
    .catch((err) => console.warn('[data] station demand load failed:', err));
}

/** Derive health/live-capability. In the app there is no server: the catalog is
 *  a bundled asset and live tracking runs natively from the phone's own CO IP, so
 *  health is computed locally. The browser-dev build still polls `/api/health`. */
export async function fetchHealth(): Promise<void> {
  const liveCapable =
    isNativeLiveAvailable() || (await isLiveBridgeAvailable().catch(() => false)) || Boolean(LIVE_RELAY_URL);

  if (state.native) {
    const health: HealthInfo = {
      ok: true,
      catalogStations: Object.keys(state.catalog?.stations || {}).length,
      catalogStale: false, // bundled with the app — refreshed on app update, not stale
      liveTrackingVersion: 'native',
      liveCapable,
      reachedAt: Date.now(),
    };
    state.health = health;
    bus.emit('health', health);
    return;
  }

  let payload: any = null;
  try {
    const res = await fetch(`${API_BASE}/health`);
    payload = res.ok ? await res.json() : null;
  } catch {
    payload = null;
  }

  const health: HealthInfo = {
    ok: Boolean(payload),
    catalogStations: payload?.catalogStations,
    catalogStale: payload?.catalogStale,
    liveTrackingVersion: payload?.liveTrackingVersion,
    liveCapable,
    reachedAt: payload ? Date.now() : undefined,
  };
  state.health = health;
  bus.emit('health', health);
}
