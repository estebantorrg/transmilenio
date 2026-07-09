/**
 * Core data pipeline for the mobile app.
 *
 * Reuses the website's service layer verbatim — the shared `api` client and the
 * shared `buildRouteList` (spec §1.1 R2). The mobile app only differs in *how*
 * it presents this data, never in how it's fetched or normalized.
 */

import { api } from '@shared/services/api';
import { buildRouteList, dedupeStops, isStationStopCode } from '@shared/data/routeCatalog';
import { isAlimentadorRoute, normalizeRouteCodeForMatch } from '@shared/utils/routeColors';
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

/** Wake the (possibly cold) backend before firing heavy requests. */
export function wakeBackend(): Promise<unknown> {
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

/**
 * Normalizes a route code to match the ArcGIS zonal-routes feed against the
 * catalog: strips a trailing direction/variant (`-2`, `A`) and the catalog's
 * zero-padding after the zone letter (`F019` → `F19`). Applied to BOTH sides so
 * the two spellings collapse to the same key.
 */
export function variantBase(code: string): string {
  let s = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  s = s.replace(/[A-Z]$/, ''); // trailing variant letter (…E / …A / …C)
  // Direction suffix "-<n>" only for LETTERED codes (F405-2 → F405). For numeric
  // codes the hyphen is structural (10-12, 6-2) — keep it, or we'd collide route
  // 10-12 onto route 10 and tag the wrong buses.
  if (/^[A-Z]/.test(s)) s = s.replace(/-\d+$/, '');
  s = s.replace(/^([A-Z]+)0+(\d)/, '$1$2'); // drop catalog zero-padding F019 → F19
  return normalizeRouteCodeForMatch(s);
}

/** SITP numeric zones (1–13) a route touches, from the ArcGIS feed. */
export function getZonalAreas(code: string): number[] {
  return state.zonalAreas.get(variantBase(code)) ?? [];
}

/**
 * Builds `state.zonalAreas` (code → SITP zone numbers) + `state.zones` from the
 * ArcGIS `consulta_rutas_zonales` feed. A route is assigned only to its home zone
 * (`zona_origen`, 1–13); `zona_destino` is deliberately ignored (see below). This
 * is authoritative — it covers even numeric-coded routes that carry no zone letter.
 */
function buildZonalAreas(features: any[]): void {
  const map = new Map<string, Set<number>>();
  const present = new Set<number>();
  for (const f of features) {
    const a = f.attributes ?? {};
    const key = variantBase(a.route_name_ruta_zonal || a.codigo_definitivo_ruta_zonal || '');
    if (!key) continue;
    // Home zone only (`zona_origen`). `zona_destino` is frequently 0 (portal) or
    // a corridor the route merely reaches, which leaked non-belonging routes into
    // a zone — the browse must be strict about what actually operates there.
    const zone = Number(a.zona_origen_ruta_zonal);
    if (!Number.isInteger(zone) || zone < 1 || zone > 13) continue;
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(zone);
    present.add(zone);
  }
  state.zonalAreas = new Map([...map].map(([k, v]) => [k, [...v].sort((x, y) => x - y)]));
  state.zones = [...present].sort((x, y) => x - y);
  buildZoneLabels();
}

// Recognizable Bogotá areas/portals. A zone's label is whichever of these its
// routes' endpoints mention most — grounded in the real catalog, so no zone
// name is fabricated (the official number→name map is not public).
const ZONE_LANDMARKS = [
  'Ciudad Bolivar', 'Rafael Uribe', 'San Cristobal', 'Antonio Nariño', 'Puente Aranda', 'Barrios Unidos',
  'Portal 20 de Julio', 'Portal Americas', 'Portal Dorado', 'Portal Tunal', 'Portal Suba', 'Portal Norte',
  'Portal Sur', 'Portal Usme', 'Portal 80', 'Patio Bonito',
  'Usaquen', 'Suba', 'Engativa', 'Fontibon', 'Kennedy', 'Bosa', 'Usme', 'Tunjuelito', 'Teusaquillo',
  'Chapinero', 'Santa Fe', 'Candelaria', 'Martires', 'Tintal', 'Britalia', 'Verbenal', 'Tunal',
] as const;
const NORM_LANDMARKS = ZONE_LANDMARKS.map((l) => ({
  raw: l,
  norm: l.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
}));

/** Picks the dominant recognizable area per SITP zone from its routes' endpoints. */
function buildZoneLabels(): void {
  const bags = new Map<number, Map<string, number>>();
  for (const r of state.routes) {
    if (r.type !== 'zonal' || isAlimentadorRoute(r)) continue;
    const zones = getZonalAreas(r.code);
    if (zones.length === 0) continue;
    const hay = `${r.origin} ${r.destination}`.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const lm of NORM_LANDMARKS) {
      if (!hay.includes(lm.norm)) continue;
      for (const z of zones) {
        let bag = bags.get(z);
        if (!bag) bags.set(z, (bag = new Map()));
        bag.set(lm.raw, (bag.get(lm.raw) ?? 0) + 1);
      }
    }
  }
  const labels = new Map<number, string>();
  for (const [z, bag] of bags) {
    let best = '';
    let bestN = 0;
    for (const [name, n] of bag) {
      if (n > bestN) {
        bestN = n;
        best = name;
      }
    }
    if (best) labels.set(z, best);
  }
  state.zoneLabels = labels;
}

/** Background pass: SITP zones + enrich zonal routes with their stops and stop records. */
export async function loadBackground(): Promise<void> {
  const [zonalRes, stopsRes, mapRes] = await Promise.allSettled([
    api.getZonalRoutes(),
    api.getZonalStops(),
    api.getZonalStopRoutes(),
  ]);

  buildZonalAreas(unwrap<any>(zonalRes as PromiseSettledResult<ApiResponse<any>>));

  const stops = unwrap<any>(stopsRes as PromiseSettledResult<ApiResponse<any>>);
  const mappings = unwrap<any>(mapRes as PromiseSettledResult<ApiResponse<any>>);
  if (stops.length === 0) {
    bus.emit('stops:ready', undefined); // still surfaces the zones we just built
    return;
  }

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

  // Paraderos themselves come from the catalog at boot (catalogPointRecords) — the
  // ArcGIS zonal stops are used only for the route-stop enrichment above and the
  // SITP zones built earlier. Signal the zones/enrichment are ready.
  bus.emit('stops:ready', undefined);

  // Recharge POIs (static catalog, spec §5.8) → Cerca "Recargas" kind. Independent
  // of the enrichment above, so it doesn't block the ready signal.
  api.getRechargePoints()
    .then((res) => {
      if (!res.success || !res.points) return;
      state.rechargePoints = res.points
        .map((p, i): StationRecord => ({
          code: `rp-${i}`,
          name: p.nombre,
          direccion: [p.direccion, p.localidad].filter(Boolean).join(', '),
          coordinate: [p.longitud, p.latitud],
          wagonCount: 0,
          kind: 'recharge',
          hours: p.wks,
        }))
        .filter((p) => Number.isFinite(p.coordinate[0]) && Number.isFinite(p.coordinate[1]));
      bus.emit('stops:ready', undefined);
    })
    .catch((err) => console.warn('[data] recharge points load failed:', err));
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
