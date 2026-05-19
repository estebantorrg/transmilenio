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
  getZonalRouteColor,
  toggleTroncalRoutes,
  toggleZonalRoutes,
  highlightRoute,
  clearHighlight,
  normalizeRouteCodeForMatch,
  bringTroncalLayersToFront,
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
      
      // Use the official catalog name if available, otherwise fallback to the origin/dest string
      const displayName = route.nombre || `${origin} → ${destination}`;

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
        name: displayName,
        origin,
        destination,
        type,
        source: 'catalog',
        busType: route.tipoServicio,
        schedule: route.horarios?.data?.map((item) => `${item.convencion} ${item.hora_inicio}-${item.hora_fin}`).join(' / '),
        color: type === 'troncal' ? getRouteColor(code, 'troncal') : getZonalRouteColor(code),
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
  // 1. Build authoritative catalog items
  const catalogItems = buildCatalogRouteList(catalog);
  const mergedRoutes = new Map<string, RouteListItem>();

  // Add all catalog items keyed by id to avoid squashing variants with the same code (e.g. 1, 2, C149)
  catalogItems.forEach((catRoute) => {
    mergedRoutes.set(catRoute.id, catRoute);
  });

  // 2. Process Troncal geometries
  troncalRoutes.forEach((r) => {
    const code = r.attributes.route_name_ruta_troncal;

    // Look for a matching catalog item. We find the FIRST one that matches the code.
    // (Geometry mapping for multiple variants of a troncal isn't split by ArcGIS, so we apply it to all)
    let foundAny = false;
    for (const [id, activeRoute] of mergedRoutes.entries()) {
      if (activeRoute.code === code && activeRoute.source === 'catalog') {
        foundAny = true;
        if (r.geometry) activeRoute.geometry = r.geometry;
        if (!activeRoute.length && r.attributes.longitud_ruta_troncal) {
          activeRoute.length = r.attributes.longitud_ruta_troncal;
        }
      }
    }

    if (!foundAny) {
      // Existing in ArcGIS but not catalog
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

  // 3. Process Zonal geometries
  zonalRoutes.forEach((r) => {
    const rawCode = r.attributes.codigo_definitivo_ruta_zonal;
    const arcgisName = normalizeRouteText(r.attributes.denominacion_ruta_zonal);
    const arcgisDest = normalizeRouteText(r.attributes.destino_ruta_zonal);

    const matches: RouteListItem[] = [];

    for (const catRoute of catalogItems) {
      if (catRoute.type !== 'zonal') continue;
      const catCode = catRoute.code;
      
      if (rawCode === catCode) {
        matches.push(catRoute);
        continue;
      }

      const match = rawCode.match(/^([A-Z]+)(\d+)$/);
      if (!match) continue;

      const rawLetters = match[1];
      const rawNumbers = match[2];

      const catMatch = catCode.match(/^([A-Z])(\d+)$/);
      if (!catMatch) continue;
      
      const catLetter = catMatch[1];
      const catNumbers = catMatch[2];

      // e.g. rawCode "CL149", catCode "C149" or "L149"
      if (rawNumbers === catNumbers && rawLetters.includes(catLetter)) {
        matches.push(catRoute);
      }
    }

    if (matches.length > 0) {
      matches.forEach(bestMatch => {
        if (r.geometry) bestMatch.geometry = r.geometry;
        if (!bestMatch.operator && r.attributes.operador_ruta_zonal) bestMatch.operator = r.attributes.operador_ruta_zonal;
        if (!bestMatch.length && r.attributes.longitud_ruta_zonal) bestMatch.length = r.attributes.longitud_ruta_zonal;
      });
    } else {
      // Fallback
      const fallbackCode = rawCode;
      mergedRoutes.set(`fallback-${r.attributes.objectid}`, {
        id: `z-${r.attributes.objectid}`,
        code: fallbackCode,
        name: r.attributes.denominacion_ruta_zonal,
        origin: r.attributes.origen_ruta_zonal,
        destination: r.attributes.destino_ruta_zonal,
        type: 'zonal',
        source: 'arcgis',
        operator: r.attributes.operador_ruta_zonal,
        length: r.attributes.longitud_ruta_zonal,
        color: getZonalRouteColor(fallbackCode),
        geometry: r.geometry,
      });
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
  let routeList: RouteListItem[] = [];
  let stationCount = 0;
  let stopsCount = 0;

  try {
    // 1. Fetch EVERYTHING in parallel
    const [
      troncalRoutesRes, 
      corridorsRes, 
      stationsRes, 
      catalogRes,
      zonalRoutesRes,
      zonalStopsRes,
      zonalStopRoutesRes
    ] = await Promise.all([
      api.getTroncalRoutes(),
      api.getTroncalCorridors(),
      api.getTroncalStations(),
      api.getMasterCatalog(),
      api.getZonalRoutes(),
      api.getZonalStops(),
      api.getZonalStopRoutes(),
    ]);

    troncalRoutes = troncalRoutesRes.features;
    zonalRoutes = zonalRoutesRes.features;
    const stations = stationsRes.features.filter(isVisibleTroncalStation);
    catalog = catalogRes.data || { stations: {}, routes: {} };
    
    console.log(`✅ Troncal routes: ${troncalRoutes.length}`);
    console.log(`✅ Troncal corridors: ${corridorsRes.features.length}`);
    console.log(`✅ Stations: ${stations.length}`);
    console.log(`✅ Zonal routes: ${zonalRoutes.length}`);
    console.log(`✅ Master catalog: ${catalogRes.count} stations${catalogRes.stale ? ' (stale — sync in progress)' : ''}`);

    // Set catalog for station popups
    setCatalog(catalog);

    // 2. Pre-calculate unified route list from API
    setLoadingStatus('Procesando datos de rutas...');
    routeList = buildRouteList(troncalRoutes, zonalRoutes, catalog);
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

      highlightRoute(map, route.code, route.type, route.geometry);

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
