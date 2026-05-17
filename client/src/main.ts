/**
 * TransMilenio Explorer — Main Entry Point
 *
 * Bootstraps the map, loads data from the backend proxy,
 * and wires up the sidebar UI.
 */

import maplibregl from 'maplibre-gl';
import { createMap } from './map';
import { api } from './services/api';
import { addStationsLayer, addWagonsLayer, toggleStationsLayer } from './layers/stations';
import { addStopsLayer, toggleStopsLayer, buildStopRoutesMap } from './layers/stops';
import {
  addTroncalRoutesLayer,
  addZonalRoutesLayer,
  toggleTroncalRoutes,
  toggleZonalRoutes,
  highlightRoute,
  clearHighlight,
} from './layers/routes';
import { initSidebar, setRoutes, updateCounts } from './ui/sidebar';
import type { RouteListItem, TroncalRouteFeature, ZonalRouteFeature } from './types/transmilenio';

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

// ─── Build Route List Items ───────────────────────────────

function buildRouteList(
  troncalRoutes: TroncalRouteFeature[],
  zonalRoutes: ZonalRouteFeature[]
): RouteListItem[] {
  const troncalItems: RouteListItem[] = troncalRoutes.map((r) => ({
    id: `t-${r.attributes.objectid}`,
    code: r.attributes.route_name_ruta_troncal,
    name: `${r.attributes.origen_ruta_troncal} → ${r.attributes.destino_ruta_troncal}`,
    origin: r.attributes.origen_ruta_troncal,
    destination: r.attributes.destino_ruta_troncal,
    type: 'troncal',
    busType: r.attributes.desc_tipo_bus_ruta_troncal,
    schedule: r.attributes.horario_lunes_viernes,
    length: r.attributes.longitud_ruta_troncal
      ? r.attributes.longitud_ruta_troncal / 1000
      : undefined,
  }));

  const zonalItems: RouteListItem[] = zonalRoutes.map((r) => ({
    id: `z-${r.attributes.objectid}`,
    code: r.attributes.codigo_definitivo_ruta_zonal,
    name: r.attributes.denominacion_ruta_zonal,
    origin: r.attributes.origen_ruta_zonal,
    destination: r.attributes.destino_ruta_zonal,
    type: 'zonal',
    operator: r.attributes.operador_ruta_zonal,
    length: r.attributes.longitud_ruta_zonal,
  }));

  return [...troncalItems, ...zonalItems];
}

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🚌 TransMilenio Explorer starting...');

  // 1. Initialize map
  setLoadingStatus('Cargando mapa...');
  const map = createMap('map');

  // Wait for map to load
  await new Promise<void>((resolve) => {
    map.on('load', resolve);
  });

  // Track zoom in stats bar
  map.on('zoom', () => {
    const zoomEl = document.getElementById('stat-zoom');
    if (zoomEl) zoomEl.textContent = map.getZoom().toFixed(1);
  });

  // 2. Fetch data from backend
  setLoadingStatus('Descargando rutas troncales...');

  let troncalRoutes: TroncalRouteFeature[] = [];
  let zonalRoutes: ZonalRouteFeature[] = [];
  let stationCount = 0;
  let stopsCount = 0;

  try {
    // Fetch troncal data
    const [troncalRoutesRes, stationsRes, wagonsRes] = await Promise.all([
      api.getTroncalRoutes(),
      api.getTroncalStations(),
      api.getTroncalWagons(),
    ]);

    troncalRoutes = troncalRoutesRes.features;
    const wagons = wagonsRes.features;
    console.log(`✅ Troncal routes: ${troncalRoutes.length}`);
    console.log(`✅ Stations: ${stationsRes.features.length}`);
    console.log(`✅ Wagons: ${wagons.length}`);

    // Add layers to map (routes first, then stations on top)
    setLoadingStatus('Dibujando rutas troncales...');
    addTroncalRoutesLayer(map, troncalRoutes);

    setLoadingStatus('Colocando estaciones...');
    addStationsLayer(map, stationsRes.features, troncalRoutes);
    stationCount = stationsRes.features.length;

    // Add wagon layer (visible at zoom 15+)
    setLoadingStatus('Dibujando vagones...');
    addWagonsLayer(map, wagons, troncalRoutes);

    // Fetch zonal routes, stops, and stop-route mappings
    setLoadingStatus('Descargando rutas y paraderos zonales...');
    const [zonalRoutesRes, zonalStopsRes, zonalStopRoutesRes] = await Promise.all([
      api.getZonalRoutes(),
      api.getZonalStops(),
      api.getZonalStopRoutes(),
    ]);

    zonalRoutes = zonalRoutesRes.features;
    const stopRoutesMap = buildStopRoutesMap(zonalStopRoutesRes.features);
    console.log(`✅ Zonal routes: ${zonalRoutes.length}`);
    console.log(`✅ Zonal stops: ${zonalStopsRes.features.length}`);
    console.log(`✅ Stop-route mappings: ${zonalStopRoutesRes.features.length} → ${stopRoutesMap.size} stops`);

    setLoadingStatus('Dibujando rutas zonales...');
    addZonalRoutesLayer(map, zonalRoutes);

    setLoadingStatus('Colocando paraderos...');
    addStopsLayer(map, zonalStopsRes.features, stopRoutesMap);
    stopsCount = zonalStopsRes.features.length;
  } catch (error) {
    console.error('❌ Error loading data:', error);
    setLoadingStatus('Error al cargar datos. ¿Está el servidor corriendo en puerto 3001?');
    return;
  }

  // 3. Initialize sidebar
  const routeList = buildRouteList(troncalRoutes, zonalRoutes);

  initSidebar({
    onRouteSelect: (route: RouteListItem) => {
      highlightRoute(map, route.code, route.type);

      // Find the route feature to get its bounds
      const source = route.type === 'troncal' ? troncalRoutes : zonalRoutes;
      const feature = source.find((f) => {
        const attrs = f.attributes as any;
        const code = route.type === 'troncal'
          ? attrs.route_name_ruta_troncal
          : attrs.codigo_definitivo_ruta_zonal;
        return code === route.code;
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
    troncal: troncalRoutes.length,
    zonal: zonalRoutes.length,
    stations: stationCount,
    stops: stopsCount,
  });

  // 4. Done!
  console.log('🎉 TransMilenio Explorer ready!');
  hideLoading();
}

// Launch!
main().catch(console.error);
