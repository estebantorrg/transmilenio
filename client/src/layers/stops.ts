/**
 * Zonal stop marker layer.
 */

import maplibregl from 'maplibre-gl';
import type { MasterCatalog } from '../types/catalog';
import type { ZonalRouteFeature } from '../types/transmilenio';
import { getRouteColor, markClickHandled, normalizeRouteCode, normalizeRouteCodeForMatch } from './routes';
import { showPopup } from './popup';
import { escapeHTML, safeColor } from '../utils/html';

export type StopRouteTag = {
  code: string;
  color: string;
};

export type StopRoutesMap = Map<string, StopRouteTag[]>;

const STOP_LAYERS = ['stops-circle', 'stops-hitbox', 'stops-labels'];

export function buildStopRouteCodeSet(stopRoutes: any[]): Set<string> {
  const codes = new Set<string>();

  for (const sr of stopRoutes) {
    const route = sr.attributes?.ruta;
    if (route) codes.add(normalizeRouteCodeForMatch(route));
  }

  return codes;
}

export function filterZonalRoutesWithStops(
  routes: ZonalRouteFeature[],
  stopRoutes: any[]
): ZonalRouteFeature[] {
  const routeCodesWithStops = buildStopRouteCodeSet(stopRoutes);
  return routes.filter((route) =>
    routeCodesWithStops.has(normalizeRouteCodeForMatch(route.attributes.codigo_definitivo_ruta_zonal))
  );
}

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
          color: route.color || getRouteColor(route.codigo, 'zonal'),
        });
      }
    }
  }
}

export function buildStopRoutesMap(
  stopRoutes: any[],
  zonalRoutes: ZonalRouteFeature[] = [],
  catalog: MasterCatalog = { stations: {}, routes: {} }
): StopRoutesMap {
  const routeTypeByCode = new Map<string, number>();
  zonalRoutes.forEach((route) => {
    routeTypeByCode.set(
      normalizeRouteCodeForMatch(route.attributes.codigo_definitivo_ruta_zonal),
      route.attributes.tipo_ruta_zonal
    );
  });

  const map = new Map<string, StopRouteTag[]>();

  for (const sr of stopRoutes) {
    const cenefa: string = sr.attributes?.cenefa;
    const route: string = sr.attributes?.ruta;
    if (!cenefa || !route) continue;
    const code = normalizeRouteCodeForMatch(route);
    const routeTag = {
      code: route,
      color: getRouteColor(route, 'zonal', routeTypeByCode.get(code)),
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
    type: 'circle',
    source: 'stops',
    minzoom: 14,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 5, 20, 8],
      'circle-color': '#34D399',
      'circle-stroke-color': '#0A0E17',
      'circle-stroke-width': 1,
      'circle-opacity': 0.86,
    },
  });

  map.addLayer({
    id: 'stops-hitbox',
    type: 'circle',
    source: 'stops',
    minzoom: 13,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 9, 17, 15, 20, 20],
      'circle-color': '#34D399',
      'circle-opacity': 0.01,
    },
  });

  map.addLayer({
    id: 'stops-labels',
    type: 'symbol',
    source: 'stops',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 8, 17, 11],
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-max-width': 9,
    },
    paint: {
      'text-color': '#34D399',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 16, 0.9],
    },
  });

  map.on('click', 'stops-hitbox', (e) => showStopPopup(map, e));
  map.on('mouseenter', 'stops-hitbox', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stops-hitbox', () => {
    map.getCanvas().style.cursor = '';
  });
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
  STOP_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  });
}
