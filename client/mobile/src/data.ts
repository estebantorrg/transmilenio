/**
 * Core data pipeline for the mobile app.
 *
 * Reuses the website's service layer verbatim — the shared `api` client and the
 * shared `buildRouteList` (spec §1.1 R2). The mobile app only differs in *how*
 * it presents this data, never in how it's fetched or normalized.
 */

import { api } from '@shared/services/api';
import { buildRouteList, dedupeStops } from '@shared/data/routeCatalog';
import { normalizeRouteCodeForMatch } from '@shared/utils/routeColors';
import { setRouteTypeIndex } from '@shared/utils/routeType';
import { isNativeLiveAvailable } from '@shared/services/nativeLive';
import { isLiveBridgeAvailable } from '@shared/services/liveBridge';
import { nativeJsonRequest } from '@shared/services/nativeLive';
import type { MasterCatalog, MasterCatalogResponse } from '@shared/types/catalog';
import type { ApiResponse, RouteListItem, TroncalRouteFeature } from '@shared/types/transmilenio';
import { bus, setRoutes, state, type HealthInfo, type StationRecord } from './state';
import { idbGet, idbSet } from './lib/cache';

const CATALOG_KEY = 'catalog:v1';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const LIVE_RELAY_URL = String(import.meta.env.VITE_LIVE_RELAY_URL || '');

function parseLatLng(coordenada: string | undefined): [number, number] | null {
  if (!coordenada || !coordenada.includes(',')) return null;
  const [lat, lng] = coordenada.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lng, lat];
}

/** Station records straight from the master catalog (always available). */
function catalogStationRecords(catalog: MasterCatalog): StationRecord[] {
  const out: StationRecord[] = [];
  for (const st of Object.values(catalog.stations || {})) {
    const coordinate = parseLatLng(st.coordenada);
    if (!coordinate) continue;
    out.push({
      code: st.codigo || st.id,
      name: st.nombre || 'Estación',
      direccion: st.direccion || '',
      coordinate,
      wagonCount: st.wagons ? Object.keys(st.wagons).length : 0,
      kind: 'station',
    });
  }
  return out;
}

function unwrap<T>(res: PromiseSettledResult<ApiResponse<T>>): T[] {
  return res.status === 'fulfilled' && res.value.success ? res.value.features || [] : [];
}

/** Wake the (possibly cold) backend before firing heavy requests. */
export function wakeBackend(): Promise<unknown> {
  return fetch(`${API_BASE}/health`).catch(() => undefined);
}

/** Build routes/stations/counts from a catalog (+ optional ArcGIS troncal geometry). */
function applyCatalog(catalog: MasterCatalog, troncalRoutes: TroncalRouteFeature[] = [], corridorCount?: number): void {
  state.catalog = catalog;
  setRouteTypeIndex(catalog);
  const routes = buildRouteList(troncalRoutes, catalog);
  const stations = catalogStationRecords(catalog);
  state.stations = stations;
  state.counts = {
    troncal: routes.filter((r) => r.type === 'troncal').length,
    zonal: routes.filter((r) => r.type === 'zonal').length,
    stations: stations.length,
    stops: state.counts.stops,
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
    api.getMasterCatalog(),
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

/** Background pass: enrich zonal routes with their stops and expose stop records. */
export async function loadBackground(): Promise<void> {
  const [stopsRes, mapRes] = await Promise.allSettled([api.getZonalStops(), api.getZonalStopRoutes()]);
  const stops = unwrap<any>(stopsRes as PromiseSettledResult<ApiResponse<any>>);
  const mappings = unwrap<any>(mapRes as PromiseSettledResult<ApiResponse<any>>);
  if (stops.length === 0) return;

  const stopLookup = new Map<string, any>();
  for (const s of stops) {
    const cenefa = s.attributes?.cenefa;
    if (cenefa) stopLookup.set(cenefa, s);
  }

  // Enrich zonal routes missing stops (same rule as the website — spec §5.4.2).
  if (mappings.length > 0) {
    const routeToStops = new Map<string, any[]>();
    for (const m of mappings) {
      const routeCode = normalizeRouteCodeForMatch(m.attributes?.ruta);
      const cenefa = m.attributes?.cenefa;
      const stop = cenefa ? stopLookup.get(cenefa) : null;
      if (!routeCode || !stop?.geometry || stop.geometry.x == null || stop.geometry.y == null) continue;
      if (!routeToStops.has(routeCode)) routeToStops.set(routeCode, []);
      routeToStops.get(routeCode)!.push({
        nombre: stop.attributes?.nombre || 'Paradero',
        codigo: cenefa,
        coordinate: [stop.geometry.x, stop.geometry.y] as [number, number],
        direccion: stop.attributes?.direccion_bandera || stop.attributes?.via || '',
        kind: 'stop',
      });
    }
    for (const route of state.routes as RouteListItem[]) {
      if (route.type === 'zonal' && (!route.stops || route.stops.length === 0)) {
        const enriched = routeToStops.get(normalizeRouteCodeForMatch(route.code));
        if (enriched) route.stops = dedupeStops(enriched);
      }
    }
  }

  const stopRecords: StationRecord[] = [];
  for (const s of stops) {
    const x = s.geometry?.x;
    const y = s.geometry?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    stopRecords.push({
      code: s.attributes?.cenefa || '',
      name: s.attributes?.nombre || 'Paradero',
      direccion: s.attributes?.direccion_bandera || s.attributes?.via || '',
      coordinate: [x, y],
      wagonCount: 0,
      kind: 'stop',
    });
  }
  state.zonalStops = stopRecords;
  state.counts.stops = stopRecords.length;
  bus.emit('stops:ready', undefined);
}

/** Poll `/api/health` and derive whether live tracking can reach the CO API. */
export async function fetchHealth(): Promise<void> {
  const liveCapable =
    isNativeLiveAvailable() || (await isLiveBridgeAvailable().catch(() => false)) || Boolean(LIVE_RELAY_URL);

  let payload: any = null;
  try {
    const native = await nativeJsonRequest(`${API_BASE}/health`, undefined, 8000).catch(() => null);
    if (native && native.data != null) {
      payload = typeof native.data === 'string' ? JSON.parse(native.data) : native.data;
    } else {
      const res = await fetch(`${API_BASE}/health`);
      payload = res.ok ? await res.json() : null;
    }
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
