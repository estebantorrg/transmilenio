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
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 10, 17, 18],
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5, 17, 8],
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
    id: 'zonal-routes-glow',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 8, 17, 14],
      'line-opacity': 0.12,
      'line-blur': 3,
    },
  }, beforeId);

  map.addLayer({
    id: 'zonal-routes-line',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1.5, 17, 2.5],
      'line-opacity': 0.55,
    },
  }, beforeId);
}

export function bringTroncalLayersToFront(map: maplibregl.Map): void {
  // Order matters: Bottom to Top
  const layers = [
    'troncal-corridors-casing',
    'troncal-corridors-line',
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
  ['zonal-routes-glow', 'zonal-routes-line'].forEach((id) => {
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

  map.addLayer({
    id: glowId,
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': lineColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 20, 17, 30] as any,
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7, 17, 10] as any,
      'line-opacity': 1,
    },
  } as any, beforeId);
}

export function clearHighlight(map: maplibregl.Map): void {
  if (map.getLayer('highlight-route')) map.removeLayer('highlight-route');
  if (map.getLayer('highlight-route-glow')) map.removeLayer('highlight-route-glow');
  if (map.getSource('highlight-temp-source')) map.removeSource('highlight-temp-source');
}
