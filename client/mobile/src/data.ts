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

/**
 * Loads the required catalog + optional ArcGIS layers, builds the unified route
 * list, and seeds `state`. Throws only if the master catalog itself is
 * unreachable (spec §4.2 — catalog is critical, everything else degrades).
 */
export async function loadCore(onProgress: (pct: number, label: string) => void): Promise<void> {
  onProgress(12, 'Despertando el servidor…');
  await wakeBackend();

  onProgress(22, 'Descargando catálogo maestro…');
  const [troncalRes, corridorsRes, catalogRes] = await Promise.allSettled([
    api.getTroncalRoutes(),
    api.getTroncalCorridors(),
    api.getMasterCatalog(),
  ]);

  if (catalogRes.status !== 'fulfilled') {
    throw new Error(catalogRes.reason instanceof Error ? catalogRes.reason.message : 'catálogo no disponible');
  }
  const catalogPayload = catalogRes.value as MasterCatalogResponse;
  const catalog = catalogPayload.data || { stations: {}, routes: {} };
  state.catalog = catalog;
  setRouteTypeIndex(catalog);

  onProgress(70, 'Trazando rutas…');
  const troncalRoutes = unwrap<TroncalRouteFeature>(troncalRes as PromiseSettledResult<ApiResponse<TroncalRouteFeature>>);
  const routes = buildRouteList(troncalRoutes, catalog);
  const stations = catalogStationRecords(catalog);
  state.stations = stations;

  const troncalCount = routes.filter((r) => r.type === 'troncal').length;
  const zonalCount = routes.filter((r) => r.type === 'zonal').length;
  state.counts = {
    troncal: troncalCount,
    zonal: zonalCount,
    stations: stations.length,
    stops: 0,
    cable: corridorsRes.status === 'fulfilled' ? corridorsRes.value.features.length : 0,
  };

  onProgress(88, 'Ordenando líneas…');
  setRoutes(routes);
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
