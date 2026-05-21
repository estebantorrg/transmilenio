/**
 * Zonal stop marker layer.
 */

import maplibregl from 'maplibre-gl';
import type { MasterCatalog } from '../types/catalog';
import type { RouteListItem } from '../types/transmilenio';
import { markClickHandled, normalizeRouteCode, normalizeRouteCodeForMatch } from './routes';
import { showPopup } from './popup';
import { escapeHTML, safeColor } from '../utils/html';
import { getStopTagColor } from '../utils/routeColors';

export type StopRouteTag = {
  code: string;
  color: string;
};

export type StopRoutesMap = Map<string, StopRouteTag[]>;

const STOP_LAYERS = ['stops-circle', 'stops-hitbox', 'stops-labels'];
const SELECTED_ROUTE_STOPS_LAYERS = ['selected-route-stops-bubble'];





function addStopRoute(map: StopRoutesMap, cenefa: string, routeTag: StopRouteTag): void {
  const code = normalizeRouteCodeForMatch(routeTag.code);
  const existing = map.get(cenefa);
  if (existing) {
    if (!existing.some((item) => normalizeRouteCodeForMatch(item.code) === code)) existing.push(routeTag);
  } else {
    map.set(cenefa, [routeTag]);
  }
}

function addCatalogStopRoutes(map: StopRoutesMap, catalog: MasterCatalog): void {
  const stations = Object.values(catalog.stations || {});
  for (const station of stations) {
    if (/^TM\d+$/i.test(station.codigo)) continue;

    for (const routes of Object.values(station.wagons)) {
      for (const route of routes) {
        addStopRoute(map, station.codigo, {
          code: route.codigo,
          color: getStopTagColor(route.codigo, route.color),
        });
      }
    }
  }
}

export function buildStopRoutesMap(
  stopRoutes: any[],
  catalog: MasterCatalog = { stations: {}, routes: {} }
): StopRoutesMap {
  const map = new Map<string, StopRouteTag[]>();

  for (const sr of stopRoutes) {
    const cenefa: string = sr.attributes?.cenefa;
    const route: string = sr.attributes?.ruta;
    if (!cenefa || !route) continue;
    
    const routeTag = {
      code: route,
      color: getStopTagColor(route),
    };

    addStopRoute(map, cenefa, routeTag);
  }

  addCatalogStopRoutes(map, catalog);

  for (const routes of map.values()) {
    routes.sort((a, b) => normalizeRouteCode(a.code).localeCompare(normalizeRouteCode(b.code), undefined, { numeric: true }));
  }

  return map;
}

function routeTags(routes: StopRouteTag[]): string {
  return routes
    .map(
      (route) =>
        `<span class="route-tag" style="background:${safeColor(route.color)};">${escapeHTML(route.code)}</span>`
    )
    .join('');
}

function showStopPopup(map: maplibregl.Map, e: maplibregl.MapLayerMouseEvent): void {
  if (!markClickHandled(e)) return;
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const coords = (feature.geometry as GeoJSON.Point).coordinates;
  let routes: StopRouteTag[] = [];
  try {
    routes = JSON.parse(p.routes || '[]');
  } catch {
    routes = [];
  }

  const html = `
    <div class="popup-card">
      <div class="popup-eyebrow" style="color:#34D399">Paradero zonal</div>
      <div class="popup-title">${escapeHTML(p.name)}</div>
      <div class="popup-meta">
        ${p.cenefa ? `<span># ${escapeHTML(p.cenefa)}</span>` : ''}
        ${p.address ? `<span>${escapeHTML(p.address)}</span>` : ''}
        ${p.locality ? `<span>${escapeHTML(p.locality)}</span>` : ''}
      </div>
      ${routes.length ? `<div class="popup-route-tags">${routeTags(routes)}</div>` : ''}
    </div>
  `;

  showPopup(map, coords as [number, number], html, { offset: 6, maxWidth: '280px' });
}

export function addStopsLayer(
  map: maplibregl.Map,
  stops: any[],
  stopRoutesMap?: StopRoutesMap
): void {
  const validStops = stops.filter((s) => s.geometry && s.geometry.x && s.geometry.y);

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: validStops.map((s) => {
      const a = s.attributes;
      const cenefa: string = a.cenefa || '';
      const routes = stopRoutesMap?.get(cenefa) ?? [];

      return {
        type: 'Feature',
        properties: {
          id: a.objectid,
          cenefa,
          name: a.nombre || 'Paradero Zonal',
          address: a.direccion_bandera || a.via || '',
          locality: a.localidad || '',
          zone: a.zona_sitp || '',
          routes: JSON.stringify(routes),
        },
        geometry: {
          type: 'Point',
          coordinates: [s.geometry.x, s.geometry.y],
        },
      };
    }),
  };

  map.addSource('stops', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'stops-circle',
    type: 'symbol',
    source: 'stops',
    minzoom: 14,
    layout: {
      'icon-image': 'stop-blue',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 17, 0.6, 20, 0.75],
      'icon-allow-overlap': true,
      'icon-anchor': 'bottom',
      'visibility': 'none',
    },
  });

  map.addLayer({
    id: 'stops-hitbox',
    type: 'circle',
    source: 'stops',
    minzoom: 13,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 9, 17, 15, 20, 20],
      'circle-color': '#000000',
      'circle-opacity': 0,
    },
    layout: {
      'visibility': 'none',
    },
  });

  map.addLayer({
    id: 'stops-labels',
    type: 'symbol',
    source: 'stops',
    minzoom: 16,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 16, 9, 18, 12],
      'text-offset': [0, 0.6],
      'text-anchor': 'top',
      'text-max-width': 9,
      'visibility': 'none',
    },
    paint: {
      'text-color': '#3B82F6',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 16, 0.5, 17, 0.9],
    },
  });

  map.on('click', 'stops-hitbox', (e) => showStopPopup(map, e));
  map.on('mouseenter', 'stops-hitbox', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stops-hitbox', () => {
    map.getCanvas().style.cursor = '';
  });

  // ─── Selected Route Stops (Icon Markers) ─────────────
  
  map.addSource('selected-route-stops', { 
    type: 'geojson', 
    data: { type: 'FeatureCollection', features: [] } 
  });

  map.addLayer({
    id: 'selected-route-stops-bubble',
    type: 'symbol',
    source: 'selected-route-stops',
    layout: {
      'icon-image': ['match', ['get', 'type'], 'troncal', 'stop-red', 'stop-blue'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.55, 14, 0.7, 17, 0.85],
      'icon-allow-overlap': true,
      'icon-anchor': 'bottom',
      'visibility': 'none'
    }
  });
}

export function updateSelectedRouteStops(map: maplibregl.Map, stops: RouteListItem['stops'] | undefined, type: 'troncal' | 'zonal'): void {
  if (!map.getSource('selected-route-stops')) return;

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: (stops || []).map((s: any) => ({
      type: 'Feature',
      properties: {
        name: s.nombre || '',
        code: String(s.codigo || ''),
        type: type
      },
      geometry: {
        type: 'Point',
        coordinates: s.coordinate || [0, 0]
      }
    }))
  };

  const source = map.getSource('selected-route-stops') as maplibregl.GeoJSONSource;
  if (source) {
    source.setData(geojson);
  }
  
  const visibility = (stops && stops.length > 0) ? 'visible' : 'none';

  if (map.getLayer('selected-route-stops-bubble')) {
    map.setLayoutProperty('selected-route-stops-bubble', 'visibility', visibility);
  }

  bringStopsLayerToFront(map);
}

export function toggleStopsLayer(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  STOP_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  });
}

export function bringStopsLayerToFront(map: maplibregl.Map): void {
  const allLayers = [...STOP_LAYERS, ...SELECTED_ROUTE_STOPS_LAYERS];
  allLayers.forEach((id) => {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  });
}
