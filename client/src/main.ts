/**
 * TransMilenio Explorer — Main Entry Point
 *
 * Bootstraps the map, loads data from the backend proxy,
 * and wires up the sidebar UI.
 */

import maplibregl from 'maplibre-gl';
import { createMap, initMapImages } from './map';
import { api } from './services/api';
import { addStationsLayer, bringStationsLayerToFront, isVisibleTroncalStation, setCatalog, toggleStationsLayer } from './layers/stations';
import { addStopsLayer, bringStopsLayerToFront, toggleStopsLayer, buildStopRoutesMap, updateSelectedRouteStops } from './layers/stops';
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
} from './layers/routes';
import { initSidebar, setRoutes, updateCounts } from './ui/sidebar';
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


function buildCatalogRouteList(catalog: MasterCatalog): RouteListItem[] {
  const items: RouteListItem[] = [];
  if (!catalog.routes) return items;

  // Track seen route combinations to deduplicate. Key = code + normalized name
  const seen = new Map<string, number>();

  for (const [code, variants] of Object.entries(catalog.routes)) {
    for (const route of variants) {
      const service = `${route.sistema} ${route.tipoServicio}`.toUpperCase();
      const isAlimentador = service.includes('ALIMENTADOR');
      const type = service.includes('ZONAL') || service.includes('TRANSMIZONAL') || isAlimentador ? 'zonal' : 'troncal';
      const subType = isAlimentador ? 'alimentador' : type;

      const stops = route.stops || [];
      const origin = stops[0]?.nombre || code;
      const destination = stops[stops.length - 1]?.nombre || route.nombre;
      
      // Use the official catalog name if available, otherwise fallback to the origin/dest string
      const displayName = route.nombre || `${origin} → ${destination}`;

      // Deduplication: same code + same normalized name = duplicate
      const dedupKey = `${code}|${normalizeRouteText(displayName)}`;
      const existingIdx = seen.get(dedupKey);
      if (existingIdx !== undefined) {
        // Merge geometry/stops into existing entry if the existing one lacks them
        const existing = items[existingIdx];
        if (!existing.geometry && route.trazado && route.trazado.length > 0) {
          existing.geometry = { paths: [route.trazado] };
        }
        if ((!existing.stops || existing.stops.length === 0) && stops.length > 0) {
          existing.stops = stops
            .filter((s) => s?.coordenada && typeof s.coordenada === 'string' && s.coordenada.includes(','))
            .map((s) => {
              const parts = s.coordenada.split(',');
              const lat = Number(parts[0]);
              const lng = Number(parts[1]);
              return { nombre: s.nombre, codigo: s.codigo, coordinate: [lng, lat] as [number, number] };
            })
            .filter((s) => !isNaN(s.coordinate[0]) && !isNaN(s.coordinate[1]));
        }
        continue; // Skip this duplicate
      }

      // Use official trazado (high-fidelity street-following paths) if available
      // Otherwise fallback to connecting dots between paraderos
      const geometryCoords = route.trazado && route.trazado.length > 0
        ? route.trazado
        : stops
            .filter((s) => s?.coordenada && typeof s.coordenada === 'string')
            .map((s) => {
              const [lat, lng] = s.coordenada.split(',').map(Number);
              return [lng, lat];
            })
            .filter((c) => !isNaN(c[0]) && !isNaN(c[1])) as [number, number][];

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
        geometry: geometryCoords.length > 1 ? { paths: [geometryCoords] } : undefined,
        stops: stops
          .filter((s) => s?.coordenada && typeof s.coordenada === 'string' && s.coordenada.includes(','))
          .map((s) => {
            const parts = s.coordenada.split(',');
            const lat = Number(parts[0]);
            const lng = Number(parts[1]);
            return { nombre: s.nombre, codigo: s.codigo, coordinate: [lng, lat] as [number, number] };
          })
          .filter((s) => !isNaN(s.coordinate[0]) && !isNaN(s.coordinate[1])),
      };

      seen.set(dedupKey, items.length);
      items.push(newItem);
    }
  }

  return items;
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

  // Add all catalog items keyed by id
  catalogItems.forEach((catRoute) => {
    mergedRoutes.set(catRoute.id, catRoute);
  });

  // 2. Process Troncal geometries
  troncalRoutes.forEach((r) => {
    let code = r.attributes.route_name_ruta_troncal;
    if (!code) return;

    const baseCode = code.replace(/-\d$/, '');

    let foundAny = false;
    for (const [id, activeRoute] of mergedRoutes.entries()) {
      if (activeRoute.code === baseCode && activeRoute.source === 'catalog') {
        foundAny = true;
        if (r.geometry) activeRoute.geometry = r.geometry;
        if (!activeRoute.length && r.attributes.longitud_ruta_troncal) {
          activeRoute.length = r.attributes.longitud_ruta_troncal;
        }
      }
    }

    if (!foundAny) {
      mergedRoutes.set(code, {
        id: `t-${r.attributes.objectid}`,
        code,
        name: `${r.attributes.origen_ruta_troncal} → ${r.attributes.destino_ruta_troncal}`,
        origin: r.attributes.origen_ruta_troncal,
        destination: r.attributes.destino_ruta_troncal,
        type: 'troncal',
        source: 'arcgis',
        busType: r.attributes.desc_tipo_bus_ruta_troncal,
        schedule: r.attributes.horario_lunes_viernes,
        length: r.attributes.longitud_ruta_troncal || undefined,
        color: getRouteColor(code, 'troncal'),
        geometry: r.geometry,
      });
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
          coordinate: [stop.geometry.x, stop.geometry.y] as [number, number]
        });
      }
    });

    // Apply to mergedRoutes
    for (const route of mergedRoutes.values()) {
      if (route.type === 'zonal' && (!route.stops || route.stops.length === 0)) {
        const stops = routeToStops.get(normalizeRouteCodeForMatch(route.code));
        if (stops) {
          route.stops = stops;
        }
      }
    }
  }

  return Array.from(mergedRoutes.values());
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

  try {
    // 1. Fetch data in parallel. The cached master catalog is required; live
    // ArcGIS layers are allowed to degrade so the app can still open.
    const [
      troncalRoutesResult,
      corridorsResult,
      stationsResult,
      catalogResult,
      zonalStopsResult,
      zonalStopRoutesResult
    ] = await Promise.allSettled([
      api.getTroncalRoutes(),
      api.getTroncalCorridors(),
      api.getTroncalStations(),
      api.getMasterCatalog(),
      api.getZonalStops(),
      api.getZonalStopRoutes(),
    ]);

    const catalogRes = requireLoaded<MasterCatalogResponse>('Master catalog', catalogResult);
    const troncalRoutesRes = optionalFeatures('Troncal routes', troncalRoutesResult);
    const corridorsRes = optionalFeatures('Troncal corridors', corridorsResult);
    const stationsRes = optionalFeatures('Troncal stations', stationsResult);
    const zonalStopsRes = optionalFeatures('Zonal stops', zonalStopsResult);
    const zonalStopRoutesRes = optionalFeatures('Zonal stop-route mappings', zonalStopRoutesResult);

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
    routeList = buildRouteList(troncalRoutes, catalog, zonalStopsRes.features, zonalStopRoutesRes.features);
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

    // 4. Mappings and Stops
    const stopRoutesMap = buildStopRoutesMap(zonalStopRoutesRes.features, catalog);
    console.log(`✅ Zonal stops: ${zonalStopsRes.features.length}`);
    console.log(`✅ Stop-route mappings: ${zonalStopRoutesRes.features.length} → ${stopRoutesMap.size} stops`);

    setLoadingStatus('Dibujando rutas zonales...');
    addZonalRoutesLayer(map, zonalListItems);

    setLoadingStatus('Colocando paraderos...');
    addStopsLayer(map, zonalStopsRes.features, stopRoutesMap);
    stopsCount = zonalStopsRes.features.length;

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
    onRouteSelect: (route: RouteListItem) => {

      highlightRoute(map, route.code, route.type, route.geometry, getRouteAccentColor(route));
      updateSelectedRouteStops(map, route.stops, route.type);

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
      clearHighlight(map);
      updateSelectedRouteStops(map, [], 'zonal');
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

  setRoutes(routeList);
  updateCounts({
    troncal: routeCounts.troncal,
    zonal: routeCounts.zonal,
    stations: stationCount,
    stops: stopsCount,
  });

  // 4. Done!
  console.log('🎉 TransMilenio Explorer ready!');
  hideLoading();
}

// Launch!
main().catch(console.error);
