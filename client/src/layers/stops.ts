/**
 * Zonal stop marker layer.
 */

import maplibregl from 'maplibre-gl';
import { markClickHandled } from './routes';

export type StopRoutesMap = Map<string, string[]>;

const STOP_LAYERS = ['stops-circle', 'stops-hitbox', 'stops-labels'];

export function buildStopRoutesMap(stopRoutes: any[]): StopRoutesMap {
  const map = new Map<string, string[]>();

  for (const sr of stopRoutes) {
    const cenefa: string = sr.attributes?.cenefa;
    const route: string = sr.attributes?.ruta;
    if (!cenefa || !route) continue;

    const existing = map.get(cenefa);
    if (existing) {
      if (!existing.includes(route)) existing.push(route);
    } else {
      map.set(cenefa, [route]);
    }
  }

  for (const routes of map.values()) {
    routes.sort();
  }

  return map;
}

function routeTags(routes: string[]): string {
  return routes
    .map(
      (route) =>
        `<span class="route-tag zonal-route-tag">${route}</span>`
    )
    .join('');
}

function showStopPopup(map: maplibregl.Map, e: maplibregl.MapLayerMouseEvent): void {
  markClickHandled(e);
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const coords = (feature.geometry as GeoJSON.Point).coordinates;
  let routes: string[] = [];
  try {
    routes = JSON.parse(p.routes || '[]');
  } catch {
    routes = [];
  }

  const html = `
    <div class="popup-station">
      <div class="popup-station-name">${p.name}</div>
      <div class="popup-station-corridor" style="color: #34D399">Paradero Zonal</div>
      <div class="popup-station-meta">
        ${p.cenefa ? `<span># ${p.cenefa}</span>` : ''}
        ${p.address ? `<span>${p.address}</span>` : ''}
        ${p.locality ? `<span>${p.locality}</span>` : ''}
      </div>
      ${routes.length ? `<div class="popup-station-routes">${routeTags(routes)}</div>` : ''}
    </div>
  `;

  new maplibregl.Popup({ offset: 6, maxWidth: '280px' })
    .setLngLat(coords as [number, number])
    .setHTML(html)
    .addTo(map);
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

  ['stops-circle', 'stops-hitbox'].forEach((layer) => {
    map.on('click', layer, (e) => showStopPopup(map, e));
    map.on('mouseenter', layer, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layer, () => {
      map.getCanvas().style.cursor = '';
    });
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
