/**
 * TransMilenio Explorer — Main Entry Point
 *
 * Bootstraps the map, loads data from the backend proxy,
 * and wires up the sidebar UI.
 */

import maplibregl from 'maplibre-gl';
import { createMap } from './map';
import { api } from './services/api';
import { addStationsLayer, bringStationsLayerToFront, isVisibleTroncalStation, setCatalog, toggleStationsLayer } from './layers/stations';
import { addStopsLayer, bringStopsLayerToFront, toggleStopsLayer, buildStopRoutesMap, filterZonalRoutesWithStops } from './layers/stops';
import {
  addTroncalCorridorsLayer,
  addTroncalRoutesLayer,
  addZonalRoutesLayer,
  getRouteColor,
  toggleTroncalRoutes,
  toggleZonalRoutes,
  highlightRoute,
  clearHighlight,
  normalizeRouteCodeForMatch,
} from './layers/routes';
import { initSidebar, setRoutes, updateCounts } from './ui/sidebar';
import type { RouteListItem, TroncalRouteFeature, ZonalRouteFeature } from './types/transmilenio';
import type { CatalogRoute, CatalogStation, MasterCatalog } from './types/catalog';

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

function normalizeRouteText(value: string | null | undefined): string {
  return normalizeRouteCodeForMatch(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function routeListKey(route: RouteListItem): string {
  return [
    route.type,
    normalizeRouteText(route.code),
    normalizeRouteText(route.origin),
    normalizeRouteText(route.destination),
    normalizeRouteText(route.name),
  ].join('|');
}

function catalogRouteKey(route: CatalogRoute): string {
  return [
    route.id ?? '',
    normalizeRouteText(route.codigo),
    normalizeRouteText(route.nombre),
    route.sistema ?? '',
    route.tipoServicio ?? '',
    route.color ?? '',
  ].join('|');
}

function catalogRouteType(route: CatalogRoute, stations: CatalogStation[]): 'troncal' | 'zonal' {
  const service = `${route.sistema ?? ''} ${route.tipoServicio ?? ''}`.toUpperCase();
  if (service.includes('TRANSMIZONAL')) return 'zonal';
  if (service.includes('TRONCAL') || service.includes('TRANSMILENIO')) return 'troncal';
  return stations.some((station) => /^TM\d+$/i.test(station.codigo)) ? 'troncal' : 'zonal';
}

function buildCatalogRouteList(catalog: MasterCatalog): RouteListItem[] {
  const grouped = new Map<string, { route: CatalogRoute; stations: CatalogStation[] }>();

  for (const station of Object.values(catalog)) {
    for (const routes of Object.values(station.wagons)) {
      for (const route of routes) {
        const key = catalogRouteKey(route);
        const entry = grouped.get(key);
        if (entry) {
          entry.stations.push(station);
        } else {
          grouped.set(key, { route, stations: [station] });
        }
      }
    }
  }

  return Array.from(grouped.values()).map(({ route, stations }) => {
    const code = route.codigo.trim();
    const destination = route.nombre.trim() || code;
    const type = catalogRouteType(route, stations);

    return {
      id: `catalog-${route.id ?? `${normalizeRouteText(code)}-${normalizeRouteText(destination)}-${route.color ?? ''}`}`,
      code,
      name: destination,
      origin: code,
      destination,
      type,
      source: 'catalog',
      busType: route.tipoServicio || 'Catalogo oficial app',
      schedule: route.horarios?.data?.map((item) => `${item.convencion} ${item.hora_inicio}-${item.hora_fin}`).join(' / '),
      color: route.color || getRouteColor(code, type),
    };
  });
}

// ─── Build Route List Items ───────────────────────────────

function buildRouteList(
  troncalRoutes: TroncalRouteFeature[],
  zonalRoutes: ZonalRouteFeature[],
  catalog: MasterCatalog
): RouteListItem[] {
  const troncalItems: RouteListItem[] = troncalRoutes.map((r) => ({
    id: `t-${r.attributes.objectid}`,
    code: r.attributes.route_name_ruta_troncal,
    name: `${r.attributes.origen_ruta_troncal} → ${r.attributes.destino_ruta_troncal}`,
    origin: r.attributes.origen_ruta_troncal,
    destination: r.attributes.destino_ruta_troncal,
    type: 'troncal',
    source: 'arcgis',
    busType: r.attributes.desc_tipo_bus_ruta_troncal,
    schedule: r.attributes.horario_lunes_viernes,
    length: r.attributes.longitud_ruta_troncal
      ? r.attributes.longitud_ruta_troncal
      : undefined,
    color: getRouteColor(r.attributes.route_name_ruta_troncal, 'troncal'),
  }));

  const zonalItems: RouteListItem[] = zonalRoutes.map((r) => ({
    id: `z-${r.attributes.objectid}`,
    code: r.attributes.codigo_definitivo_ruta_zonal,
    name: r.attributes.denominacion_ruta_zonal,
    origin: r.attributes.origen_ruta_zonal,
    destination: r.attributes.destino_ruta_zonal,
    type: 'zonal',
    source: 'arcgis',
    operator: r.attributes.operador_ruta_zonal,
    length: r.attributes.longitud_ruta_zonal,
    color: getRouteColor(r.attributes.codigo_definitivo_ruta_zonal, 'zonal', r.attributes.tipo_ruta_zonal),
  }));

  const uniqueRoutes = new Map<string, RouteListItem>();
  [...troncalItems, ...zonalItems, ...buildCatalogRouteList(catalog)].forEach((route) => {
    const key = routeListKey(route);
    if (!uniqueRoutes.has(key)) uniqueRoutes.set(key, route);
  });

  return Array.from(uniqueRoutes.values());
}

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🚌 TransMilenio Explorer starting...');

  // 1. Initialize map
  setLoadingStatus('Cargando mapa...');
  const map = createMap('map');
  if (import.meta.env.DEV) {
    (window as Window & { __tmMap?: maplibregl.Map }).__tmMap = map;
  }

  // Wait for map to load
  await new Promise<void>((resolve) => {
    map.on('load', resolve);
  });

  // 2. Fetch data from backend
  setLoadingStatus('Descargando rutas troncales...');

  let troncalRoutes: TroncalRouteFeature[] = [];
  let zonalRoutes: ZonalRouteFeature[] = [];
  let catalog: MasterCatalog = {};
  let stationCount = 0;
  let stopsCount = 0;

  try {
    // Fetch troncal data (no more wagons or layouts!)
    const [troncalRoutesRes, corridorsRes, stationsRes, catalogRes] = await Promise.all([
      api.getTroncalRoutes(),
      api.getTroncalCorridors(),
      api.getTroncalStations(),
      api.getMasterCatalog(),
    ]);

    troncalRoutes = troncalRoutesRes.features;
    const stations = stationsRes.features.filter(isVisibleTroncalStation);
    catalog = catalogRes.data || {};
    console.log(`✅ Troncal routes: ${troncalRoutes.length}`);
    console.log(`✅ Troncal corridors: ${corridorsRes.features.length}`);
    console.log(`✅ Stations: ${stationsRes.features.length}`);
    console.log(`✅ Master catalog: ${catalogRes.count} stations${catalogRes.stale ? ' (stale — sync in progress)' : ''}`);

    // Set catalog for station popups
    setCatalog(catalog);

    // Add route/corridor layers
    setLoadingStatus('Dibujando troncales...');
    addTroncalCorridorsLayer(map, corridorsRes.features);

    setLoadingStatus('Dibujando rutas troncales...');
    addTroncalRoutesLayer(map, troncalRoutes);

    setLoadingStatus('Colocando estaciones...');
    addStationsLayer(map, stations);
    stationCount = stations.length;

    // Fetch zonal routes, stops, and stop-route mappings
    setLoadingStatus('Descargando rutas y paraderos zonales...');
    const [zonalRoutesRes, zonalStopsRes, zonalStopRoutesRes] = await Promise.all([
      api.getZonalRoutes(),
      api.getZonalStops(),
      api.getZonalStopRoutes(),
    ]);

    zonalRoutes = filterZonalRoutesWithStops(zonalRoutesRes.features, zonalStopRoutesRes.features);
    const stopRoutesMap = buildStopRoutesMap(zonalStopRoutesRes.features, zonalRoutes, catalog);
    console.log(`✅ Zonal routes: ${zonalRoutes.length} of ${zonalRoutesRes.features.length} with paradero mappings`);
    console.log(`✅ Zonal stops: ${zonalStopsRes.features.length}`);
    console.log(`✅ Stop-route mappings: ${zonalStopRoutesRes.features.length} → ${stopRoutesMap.size} stops`);

    setLoadingStatus('Dibujando rutas zonales...');
    addZonalRoutesLayer(map, zonalRoutes);

    setLoadingStatus('Colocando paraderos...');
    addStopsLayer(map, zonalStopsRes.features, stopRoutesMap);
    stopsCount = zonalStopsRes.features.length;

    bringStationsLayerToFront(map);
    bringStopsLayerToFront(map);
  } catch (error) {
    console.error('❌ Error loading data:', error);
    setLoadingStatus(`Error al cargar datos. ${getErrorMessage(error)}`);
    return;
  }

  // 3. Initialize sidebar
  const routeList = buildRouteList(troncalRoutes, zonalRoutes, catalog);
  const routeCounts = routeList.reduce(
    (counts, route) => {
      counts[route.type]++;
      return counts;
    },
    { troncal: 0, zonal: 0 }
  );

  initSidebar({
    onRouteSelect: (route: RouteListItem) => {
      if (route.source === 'catalog') {
        clearHighlight(map);
        return;
      }

      highlightRoute(map, route.code, route.type);

      // Find the route feature to get its bounds
      const source = route.type === 'troncal' ? troncalRoutes : zonalRoutes;
      const feature = source.find((f) => {
        const attrs = f.attributes as any;
        const code = route.type === 'troncal'
          ? attrs.route_name_ruta_troncal
          : attrs.codigo_definitivo_ruta_zonal;
        const origin = route.type === 'troncal'
          ? attrs.origen_ruta_troncal
          : attrs.origen_ruta_zonal;
        const destination = route.type === 'troncal'
          ? attrs.destino_ruta_troncal
          : attrs.destino_ruta_zonal;
        return code === route.code && origin === route.origin && destination === route.destination;
      });

      if (feature) {
        // Calculate bounds from the route geometry
        const bounds = new maplibregl.LngLatBounds();
        feature.geometry.paths.forEach((path) => {
          path.forEach(([lng, lat]) => {
            bounds.extend([lng, lat]);
          });
        });
        map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 400, right: 60 }, maxZoom: 15 });
      }
    },
    onRouteDeselect: () => {
      clearHighlight(map);
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
