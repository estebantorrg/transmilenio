/**
 * Troncal station and wagon layers.
 */

import maplibregl from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { TroncalRouteFeature, TroncalStationFeature, TroncalWagonFeature } from '../types/transmilenio';
import { getTroncalColor, markClickHandled } from './routes';

type WagonRouteSides = {
  left: string[];
  right: string[];
};

const STATION_LAYERS = [
  'wagons-fill',
  'wagons-line',
  'wagons-route-labels',
  'stations-glow',
  'stations-circle',
  'stations-hitbox',
  'stations-labels',
];

function formatRouteTags(routes: string[]): string {
  return routes
    .map((route) => {
      const color = getTroncalColor(route);
      return `<span class="route-tag" style="background:${color};">${route}</span>`;
    })
    .join('');
}

function shortRouteList(routes: string[], limit = 5): string {
  if (routes.length === 0) return '-';
  const visible = routes.slice(0, limit).join(' ');
  return routes.length > limit ? `${visible} +${routes.length - limit}` : visible;
}

function getWagonRouteSides(
  wagon: GeoJSON.Feature<GeoJSON.Polygon>,
  routes: TroncalRouteFeature[]
): WagonRouteSides {
  const polygon = turf.polygon(wagon.geometry.coordinates);
  const center = turf.centerOfMass(polygon);
  const leftRoutes = new Set<string>();
  const rightRoutes = new Set<string>();

  routes.forEach((route) => {
    const routeCode = route.attributes.route_name_ruta_troncal;
    const paths = route.geometry?.paths;
    if (!paths) return;

    for (const path of paths) {
      if (path.length < 2) continue;
      const line = turf.lineString(path);
      const distance = turf.pointToLineDistance(center, line, { units: 'meters' });

      if (distance < 24) {
        const nearest = turf.nearestPointOnLine(line, center);
        const angle = turf.bearing(center, nearest);
        if (angle >= 0 && angle <= 180) {
          rightRoutes.add(routeCode);
        } else {
          leftRoutes.add(routeCode);
        }
        break;
      }
    }
  });

  return {
    left: Array.from(leftRoutes).sort(),
    right: Array.from(rightRoutes).sort(),
  };
}

function showStationPopup(
  map: maplibregl.Map,
  e: maplibregl.MapLayerMouseEvent,
  routes: TroncalRouteFeature[]
): void {
  markClickHandled(e);
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const coords = (feature.geometry as GeoJSON.Point).coordinates;
  const bikeInfo = p.bike ? `<span>Biciparqueo (${p.bikeCapacity})</span>` : '';
  const wifiInfo = p.wifi === 'SI' ? '<span>WiFi</span>' : '';
  const wagonsInfo = p.wagons ? `<span>${p.wagons} vagones</span>` : '';
  const stationPoint = turf.point(coords as [number, number]);
  const passingRoutes = new Set<string>();

  routes.forEach((route) => {
    const paths = route.geometry?.paths;
    if (!paths) return;

    for (const path of paths) {
      if (path.length < 2) continue;
      const line = turf.lineString(path);
      const distance = turf.pointToLineDistance(stationPoint, line, { units: 'meters' });
      if (distance < 40) {
        passingRoutes.add(route.attributes.route_name_ruta_troncal);
        break;
      }
    }
  });

  const routeTags = formatRouteTags(Array.from(passingRoutes).sort());
  const html = `
    <div class="popup-station">
      <div class="popup-station-name">${p.name}</div>
      <div class="popup-station-corridor">${p.corridor}</div>
      <div class="popup-station-meta">
        <span>${p.location}</span>
        ${wagonsInfo}
        ${bikeInfo}
        ${wifiInfo}
      </div>
      ${routeTags ? `<div class="popup-station-routes">${routeTags}</div>` : ''}
    </div>
  `;

  new maplibregl.Popup({ offset: 12, maxWidth: '280px' })
    .setLngLat(coords as [number, number])
    .setHTML(html)
    .addTo(map);
}

function showWagonPopup(map: maplibregl.Map, e: maplibregl.MapLayerMouseEvent): void {
  markClickHandled(e);
  const feature = e.features?.[0];
  if (!feature || !feature.properties) return;

  const p = feature.properties;
  const leftRoutes = JSON.parse(p.leftRoutes || '[]') as string[];
  const rightRoutes = JSON.parse(p.rightRoutes || '[]') as string[];
  const leftHTML = leftRoutes.length ? formatRouteTags(leftRoutes) : '<i>-</i>';
  const rightHTML = rightRoutes.length ? formatRouteTags(rightRoutes) : '<i>-</i>';
  const html = `
    <div class="popup-station">
      <div class="popup-station-name" style="font-size: 1rem;">${p.estacion}</div>
      <div class="popup-station-corridor" style="color: #9CA3AF; margin-bottom: 8px;">${p.nombre}</div>
      <div class="wagon-route-grid">
        <div>
          <div class="wagon-side-title">Sur/Occ.</div>
          <div class="wagon-route-tags">${leftHTML}</div>
        </div>
        <div>
          <div class="wagon-side-title">Norte/Ori.</div>
          <div class="wagon-route-tags">${rightHTML}</div>
        </div>
      </div>
    </div>
  `;

  new maplibregl.Popup({ offset: 0, maxWidth: '340px' })
    .setLngLat(e.lngLat)
    .setHTML(html)
    .addTo(map);
}

export function addStationsLayer(
  map: maplibregl.Map,
  stations: TroncalStationFeature[],
  routes: TroncalRouteFeature[] = []
): void {
  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: stations.map((s) => ({
      type: 'Feature',
      properties: {
        name: s.attributes.nombre_estacion,
        corridor: s.attributes.troncal_estacion,
        location: s.attributes.ubicacion_estacion,
        wifi: s.attributes.componente_wifi,
        bike: s.attributes.biciestacion_estacion === '1',
        bikeCapacity: s.attributes.capacidad_biciestacion_estacion,
        wagons: s.attributes.numero_vagones_estacion,
        stationType: s.attributes.tipo_estacion,
      },
      geometry: {
        type: 'Point',
        coordinates: [s.geometry.x, s.geometry.y],
      },
    })),
  };

  map.addSource('stations', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'stations-glow',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 14, 14, 17, 22],
      'circle-color': '#FBBF24',
      'circle-opacity': 0.15,
      'circle-blur': 0.8,
    },
  });

  map.addLayer({
    id: 'stations-circle',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 7, 17, 12],
      'circle-color': '#FBBF24',
      'circle-stroke-color': '#0A0E17',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2],
      'circle-opacity': 0.92,
    },
  });

  map.addLayer({
    id: 'stations-hitbox',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 18, 17, 26],
      'circle-color': '#FBBF24',
      'circle-opacity': 0.01,
    },
  });

  map.addLayer({
    id: 'stations-labels',
    type: 'symbol',
    source: 'stations',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 16, 13],
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-max-width': 10,
    },
    paint: {
      'text-color': '#FBBF24',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.5,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 15, 1],
    },
  });

  ['stations-circle', 'stations-hitbox'].forEach((layer) => {
    map.on('click', layer, (e) => showStationPopup(map, e, routes));
    map.on('mouseenter', layer, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layer, () => {
      map.getCanvas().style.cursor = '';
    });
  });
}

export function addWagonsLayer(
  map: maplibregl.Map,
  wagons: TroncalWagonFeature[],
  routes: TroncalRouteFeature[] = []
): void {
  const wagonFeatures: GeoJSON.Feature<GeoJSON.Polygon>[] = wagons.map((w) => ({
    type: 'Feature',
    properties: {
      id: w.attributes.objectid,
      tipo: w.attributes.tipo,
      troncal: w.attributes.troncal,
      estacion: w.attributes.estacion,
      nombre: w.attributes.nombre,
      idVagon: w.attributes.id_vagon,
    },
    geometry: {
      type: 'Polygon',
      coordinates: w.geometry.rings.map((ring) => [...ring].reverse()),
    },
  }));

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: wagonFeatures.map((feature) => {
      const sides = getWagonRouteSides(feature, routes);
      const label = `${feature.properties?.nombre ?? 'Vagon'}\nSO: ${shortRouteList(sides.left)}\nNE: ${shortRouteList(sides.right)}`;
      return {
        ...feature,
        properties: {
          ...feature.properties,
          leftRoutes: JSON.stringify(sides.left),
          rightRoutes: JSON.stringify(sides.right),
          label,
        },
      };
    }),
  };

  map.addSource('wagons', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'wagons-fill',
    type: 'fill',
    source: 'wagons',
    minzoom: 15,
    paint: {
      'fill-color': '#2F3B4C',
      'fill-opacity': 0.7,
      'fill-outline-color': '#FBBF24',
    },
  });

  map.addLayer({
    id: 'wagons-line',
    type: 'line',
    source: 'wagons',
    minzoom: 15,
    paint: {
      'line-color': '#FBBF24',
      'line-width': 1.5,
    },
  });

  map.addLayer({
    id: 'wagons-route-labels',
    type: 'symbol',
    source: 'wagons',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 8, 17, 10],
      'text-max-width': 12,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#FFFFFF',
      'text-halo-color': '#0A0E17',
      'text-halo-width': 1.3,
    },
  });

  map.on('click', 'wagons-fill', (e) => showWagonPopup(map, e));
  map.on('mouseenter', 'wagons-fill', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'wagons-fill', () => {
    map.getCanvas().style.cursor = '';
  });
}

export function toggleStationsLayer(map: maplibregl.Map, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  STATION_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  });
}

export function bringStationsLayerToFront(map: maplibregl.Map): void {
  STATION_LAYERS.forEach((id) => {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  });
}
