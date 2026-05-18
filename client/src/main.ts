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


function buildCatalogRouteList(catalog: MasterCatalog): RouteListItem[] {
  const items: RouteListItem[] = [];
  if (!catalog.routes) return items;

  for (const [code, variants] of Object.entries(catalog.routes)) {
    for (const route of variants) {
      const service = `${route.sistema} ${route.tipoServicio}`.toUpperCase();
      const type = service.includes('ZONAL') || service.includes('TRANSMIZONAL') ? 'zonal' : 'troncal';

      const stops = route.stops || [];
      const origin = stops[0]?.nombre || code;
      const destination = stops[stops.length - 1]?.nombre || route.nombre;

      // Convert "lat,lng" string to [lng, lat] numbers for GeoJSON
      const geometryCoords = stops
        .map((s) => {
          const [lat, lng] = s.coordenada.split(',').map(Number);
          return [lng, lat];
        })
        .filter((c) => !isNaN(c[0]) && !isNaN(c[1])) as [number, number][];

      items.push({
        id: `catalog-${route.id || `${code}-${normalizeRouteText(route.nombre)}`}`,
        code,
        name: route.nombre,
        origin,
        destination,
        type,
        source: 'catalog',
        busType: route.tipoServicio,
        schedule: route.horarios?.data?.map((item) => `${item.convencion} ${item.hora_inicio}-${item.hora_fin}`).join(' / '),
        color: route.color || getRouteColor(code, type),
        geometry: geometryCoords.length > 1 ? { paths: [geometryCoords] } : undefined,
        stops: stops.map((s) => {
          const [lat, lng] = s.coordenada.split(',').map(Number);
          return { nombre: s.nombre, codigo: s.codigo, coordinate: [lng, lat] };
        }),
      });
    }
  }

  return items;
}

// ─── Build Route List Items ───────────────────────────────

function buildRouteList(
  troncalRoutes: TroncalRouteFeature[],
  zonalRoutes: ZonalRouteFeature[],
  catalog: MasterCatalog
): RouteListItem[] {
  const troncalItems: RouteListItem[] = troncalRoutes.map((r) => {
    const code = r.attributes.route_name_ruta_troncal;
    return {
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
    };
  });

  const zonalItems: RouteListItem[] = zonalRoutes.map((r) => {
    const code = r.attributes.codigo_definitivo_ruta_zonal;
    return {
      id: `z-${r.attributes.objectid}`,
      code,
      name: r.attributes.denominacion_ruta_zonal,
      origin: r.attributes.origen_ruta_zonal,
      destination: r.attributes.destino_ruta_zonal,
      type: 'zonal',
      source: 'arcgis',
      operator: r.attributes.operador_ruta_zonal,
      length: r.attributes.longitud_ruta_zonal,
      color: getRouteColor(code, 'zonal', r.attributes.tipo_ruta_zonal),
      geometry: r.geometry,
    };
  });

  const catalogItems = buildCatalogRouteList(catalog);
  const mergedRoutes = new Map<string, RouteListItem>();

  // 1. Base on ArcGIS data (better geometry)
  [...troncalItems, ...zonalItems].forEach((route) => {
    const key = `${route.type}|${normalizeRouteText(route.code)}`;
    mergedRoutes.set(key, route);
  });

  // 2. Merge Catalog data (better metadata, fallback geometry)
  catalogItems.forEach((catRoute) => {
    const key = `${catRoute.type}|${normalizeRouteText(catRoute.code)}`;
    const existing = mergedRoutes.get(key);

    if (existing) {
      // Merge metadata
      if (catRoute.busType && catRoute.busType !== 'Catalogo oficial app') {
        existing.busType = catRoute.busType;
      }
      if (catRoute.schedule) existing.schedule = catRoute.schedule;
      if (catRoute.color) existing.color = catRoute.color;
      if (catRoute.stops) existing.stops = catRoute.stops;
    } else {
      // Add new route from catalog
      mergedRoutes.set(key, catRoute);
    }
  });

  return Array.from(mergedRoutes.values());
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
  let catalog: MasterCatalog = { stations: {}, routes: {} };
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
    catalog = catalogRes.data || { stations: {}, routes: {} };
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

      highlightRoute(map, route.code, route.type, route.geometry);

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
