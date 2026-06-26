/**
 * Route and trunk polyline layers.
 */

import maplibregl from 'maplibre-gl';
import type { RouteListItem, TroncalCorridorFeature, TroncalRouteFeature } from '../types/transmilenio';
import {
  DEFAULT_TRONCAL_COLOR,
  DEFAULT_ZONAL_COLOR,
  getRouteColor,
  getRouteZoneLetters,
  getTroncalColor,
  getTroncalLetter,
  getZonalRouteColor,
  normalizeRouteCode,
  normalizeRouteCodeForMatch,
  TRONCAL_COLORS,
} from '../utils/routeColors';

export {
  getRouteColor,
  getRouteZoneLetters,
  getTroncalColor,
  getTroncalLetter,
  getZonalRouteColor,
  normalizeRouteCode,
  normalizeRouteCodeForMatch,
  TRONCAL_COLORS,
};

let claimedClickEvent: Event | null = null;

export function markClickHandled(e: maplibregl.MapMouseEvent): boolean {
  const originalEvent = e.originalEvent as Event | undefined;
  if (originalEvent && claimedClickEvent === originalEvent) return false;

  e.preventDefault();
  originalEvent?.stopPropagation();

  if (originalEvent) {
    claimedClickEvent = originalEvent;
    window.setTimeout(() => {
      if (claimedClickEvent === originalEvent) claimedClickEvent = null;
    }, 0);
  }

  return true;
}

function routeItemsToGeoJSON(
  routes: RouteListItem[]
): GeoJSON.FeatureCollection {
  // We only draw routes that actually have a geometry
  const featuresWithGeom = routes.filter((r) => r.geometry && r.geometry.paths && r.geometry.paths.length > 0);

  return {
    type: 'FeatureCollection',
    features: featuresWithGeom.map((r) => ({
      type: 'Feature' as const,
      properties: {
        id: r.id,
        code: r.code,
        originalCode: r.code,
        letter: r.type === 'troncal' ? getTroncalLetter(r.code) : undefined,
        color: r.color,
        name: r.name,
        type: r.type,
        origin: r.origin,
        destination: r.destination,
        busType: r.busType,
        schedule: r.schedule,
        operator: r.operator,
        length: r.length,
      },
      geometry: {
        type: 'MultiLineString' as const,
        coordinates: r.geometry!.paths,
      },
    })),
  };
}

function corridorsToGeoJSON(features: TroncalCorridorFeature[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((f) => {
      const letter = getTroncalLetter(f.attributes.letra_trazado_troncal);
      return {
        type: 'Feature' as const,
        properties: {
          id: f.attributes.objectid,
          letter,
          color: letter ? getTroncalColor(letter) : DEFAULT_TRONCAL_COLOR,
          troncal: f.attributes.troncal,
          start: f.attributes.inicio_trazado,
          end: f.attributes.fin_trazado,
        },
        geometry: {
          type: 'MultiLineString' as const,
          coordinates: f.geometry.paths,
        },
      };
    }),
  };
}

export function addTroncalCorridorsLayer(
  map: maplibregl.Map,
  corridors: TroncalCorridorFeature[]
): void {
  const geojson = corridorsToGeoJSON(corridors);
  map.addSource('troncal-corridors', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'troncal-corridors-casing',
    type: 'line',
    source: 'troncal-corridors',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#050812',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 17, 10],
      'line-opacity': 0.72,
    },
  });

  map.addLayer({
    id: 'troncal-corridors-line',
    type: 'line',
    source: 'troncal-corridors',
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      'line-sort-key': ['index-of', ['get', 'letter'], 'ABCDEFGHIJKLMPT'],
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 6],
      'line-opacity': 0.95,
    },
  });

  map.addLayer({
    id: 'troncal-corridors-labels',
    type: 'symbol',
    source: 'troncal-corridors',
    minzoom: 12,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'letter'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 14],
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': '#FFFFFF',
      'text-halo-color': '#050812',
      'text-halo-width': 1.2,
    },
  });
}

export function addTroncalRoutesLayer(
  map: maplibregl.Map,
  routes: RouteListItem[]
): void {
  const geojson = routeItemsToGeoJSON(routes);
  map.addSource('troncal-routes', { type: 'geojson', data: geojson });
}

export function addZonalRoutesLayer(
  map: maplibregl.Map,
  routes: RouteListItem[]
): void {
  const geojson = routeItemsToGeoJSON(routes);
  map.addSource('zonal-routes', { type: 'geojson', data: geojson });

  // Insert zonal layers BEFORE any troncal layers if they exist
  const firstTroncalLayer = 'troncal-corridors-casing';
  const beforeId = map.getLayer(firstTroncalLayer) ? firstTroncalLayer : undefined;

  map.addLayer({
    id: 'zonal-routes-casing',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: {
      'line-color': '#032A3F',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3.5, 17, 5],
      'line-opacity': 0.35,
    },
  }, beforeId);

  map.addLayer({
    id: 'zonal-routes-glow',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: {
      'line-color': DEFAULT_ZONAL_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 6],
      'line-opacity': 0.16,
      'line-blur': 3,
    },
  }, beforeId);

  map.addLayer({
    id: 'zonal-routes-line',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: {
      'line-color': DEFAULT_ZONAL_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 1.5, 17, 2],
      'line-opacity': 0.78,
    },
  }, beforeId);
}

export function updateZonalRoutes(map: maplibregl.Map, routes: RouteListItem[]): void {
  const source = map.getSource('zonal-routes') as maplibregl.GeoJSONSource;
  if (source) {
    source.setData(routeItemsToGeoJSON(routes));
  }
}

export function bringTroncalLayersToFront(map: maplibregl.Map): void {
  // Order matters: Bottom to Top
  const layers = [
    'troncal-corridors-casing',
    'troncal-corridors-line',
    'highlight-route-casing',
    'highlight-route-glow',
    'highlight-route',
    'troncal-corridors-labels',
  ];
  layers.forEach((id) => {
    if (map.getLayer(id)) map.moveLayer(id);
  });
}

export function toggleTroncalRoutes(map: maplibregl.Map, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  const layers = [
    'troncal-corridors-casing',
    'troncal-corridors-line',
    'troncal-corridors-labels',
  ];
  layers.forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  });

  // Re-enforce hierarchy when turning back on
  if (visible) {
    bringTroncalLayersToFront(map);
  }
}

export function toggleZonalRoutes(map: maplibregl.Map, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  ['zonal-routes-casing', 'zonal-routes-glow', 'zonal-routes-line'].forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  });

  // If turning on zonales, make sure troncals still stay on top
  if (visible) {
    bringTroncalLayersToFront(map);
  }
}

export function highlightRoute(
  map: maplibregl.Map,
  routeCode: string,
  type: 'troncal' | 'zonal',
  customGeometry?: { paths: number[][][] },
  color?: string
): void {
  clearHighlight(map);

  // Dim global traces
  if (map.getLayer('troncal-corridors-line')) map.setPaintProperty('troncal-corridors-line', 'line-opacity', 0.1);
  if (map.getLayer('troncal-corridors-casing')) map.setPaintProperty('troncal-corridors-casing', 'line-opacity', 0.05);
  if (map.getLayer('troncal-corridors-labels')) map.setPaintProperty('troncal-corridors-labels', 'text-opacity', 0.1);

  if (map.getLayer('zonal-routes-line')) map.setPaintProperty('zonal-routes-line', 'line-opacity', 0.02);
  if (map.getLayer('zonal-routes-casing')) map.setPaintProperty('zonal-routes-casing', 'line-opacity', 0.01);
  if (map.getLayer('zonal-routes-glow')) map.setPaintProperty('zonal-routes-glow', 'line-opacity', 0);

  if (map.getLayer('stations-circle')) map.setPaintProperty('stations-circle', 'icon-opacity', 0.25);
  if (map.getLayer('stations-labels')) map.setPaintProperty('stations-labels', 'text-opacity', 0.2);
  if (map.getLayer('stops-circle')) map.setPaintProperty('stops-circle', 'icon-opacity', 0.25);
  if (map.getLayer('stops-labels')) map.setPaintProperty('stops-labels', 'text-opacity', 0.2);

  if (map.getLayer('cable-traces-line')) map.setPaintProperty('cable-traces-line', 'line-opacity', 0.1);
  if (map.getLayer('cable-stations-circle')) map.setPaintProperty('cable-stations-circle', 'icon-opacity', 0.25);
  if (map.getLayer('cable-stations-labels')) map.setPaintProperty('cable-stations-labels', 'text-opacity', 0.2);

  let sourceId = `${type}-routes`;
  let filter: any[] = ['==', ['get', 'code'], routeCode];

  if (customGeometry) {
    sourceId = 'highlight-temp-source';
    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { code: routeCode, color: color || getRouteColor(routeCode, type) },
        geometry: { type: 'MultiLineString', coordinates: customGeometry.paths },
      }],
    };
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    filter = ['all'];
  }

  const source = map.getSource(sourceId);
  if (!source) return;

  const glowId = 'highlight-route-glow';
  const lineId = 'highlight-route';
  const lineColor = color
    ? color
    : ['coalesce', ['get', 'color'], type === 'troncal' ? DEFAULT_TRONCAL_COLOR : DEFAULT_ZONAL_COLOR] as any;

  const beforeId = map.getLayer('stations-circle') ? 'stations-circle' : undefined;

  const casingColor = color === '#000000' || color === '#050812' ? '#FFFFFF' : '#000000';

  map.addLayer({
    id: 'highlight-route-casing',
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': casingColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 8, 17, 11] as any,
      'line-opacity': 0.85,
    },
  } as any, beforeId);

  map.addLayer({
    id: glowId,
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': lineColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 14, 12, 17, 18] as any,
      'line-opacity': 0.35,
      'line-blur': 6,
    },
  } as any, beforeId);

  map.addLayer({
    id: lineId,
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': lineColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 17, 7] as any,
      'line-opacity': 1,
    },
  } as any, beforeId);
}

export function clearHighlight(map: maplibregl.Map): void {
  if (map.getLayer('highlight-route-casing')) map.removeLayer('highlight-route-casing');
  if (map.getLayer('highlight-route')) map.removeLayer('highlight-route');
  if (map.getLayer('highlight-route-glow')) map.removeLayer('highlight-route-glow');
  if (map.getSource('highlight-temp-source')) map.removeSource('highlight-temp-source');

  // Restore global traces
  if (map.getLayer('troncal-corridors-line')) map.setPaintProperty('troncal-corridors-line', 'line-opacity', 0.95);
  if (map.getLayer('troncal-corridors-casing')) map.setPaintProperty('troncal-corridors-casing', 'line-opacity', 0.72);
  if (map.getLayer('troncal-corridors-labels')) map.setPaintProperty('troncal-corridors-labels', 'text-opacity', 1);

  if (map.getLayer('zonal-routes-line')) map.setPaintProperty('zonal-routes-line', 'line-opacity', 0.78);
  if (map.getLayer('zonal-routes-casing')) map.setPaintProperty('zonal-routes-casing', 'line-opacity', 0.35);
  if (map.getLayer('zonal-routes-glow')) map.setPaintProperty('zonal-routes-glow', 'line-opacity', 0.16);

  if (map.getLayer('stations-circle')) map.setPaintProperty('stations-circle', 'icon-opacity', 1);
  if (map.getLayer('stations-labels')) map.setPaintProperty('stations-labels', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 14, 0.6, 16, 1]);
  if (map.getLayer('stops-circle')) map.setPaintProperty('stops-circle', 'icon-opacity', 1);
  if (map.getLayer('stops-labels')) map.setPaintProperty('stops-labels', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 16, 0.5, 17, 0.9]);

  if (map.getLayer('cable-traces-line')) map.setPaintProperty('cable-traces-line', 'line-opacity', 0.85);
  if (map.getLayer('cable-stations-circle')) map.setPaintProperty('cable-stations-circle', 'icon-opacity', 1);
  if (map.getLayer('cable-stations-labels')) map.setPaintProperty('cable-stations-labels', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 13, 0.6, 15, 1]);
}
