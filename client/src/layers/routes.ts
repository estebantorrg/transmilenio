/**
 * Route and trunk polyline layers.
 */

import maplibregl from 'maplibre-gl';
import type { RouteListItem, TroncalCorridorFeature, TroncalRouteFeature, ZonalRouteFeature } from '../types/transmilenio';

export const TRONCAL_COLORS: Record<string, string> = {
  A: '#0C3A95',
  B: '#75C347',
  C: '#FFB741',
  D: '#6867B4',
  E: '#B76416',
  F: '#FB2C17',
  G: '#00B0E8',
  H: '#FF8525',
  J: '#E49DAA',
  K: '#D3AA78',
  L: '#00B0A9',
  M: '#852D89',
  P: '#25206F',
  T: '#808000',
  RF: '#000000',
  Z: '#EAB308', // General Zonal
};

const ZONAL_ZONE_TO_LETTER: Record<number, string> = {
  0: 'A', // Centro/Chapinero
  1: 'B', // Usaquen
  2: 'C', // Suba Oriental
  3: 'C', // Suba Centro
  4: 'D', // Calle 80
  5: 'D', // Engativa
  6: 'K', // Fontibon
  7: 'F', // Kennedy
  8: 'G', // Bosa
  9: 'G', // Perdomo
  10: 'H', // Ciudad Bolivar
  11: 'H', // Usme
  12: 'L', // San Cristobal
  13: 'L', // Rafael Uribe
  14: 'A', // Chapinero
  15: 'A', // Teusaquillo
  16: 'A', // Barrios Unidos
  17: 'A', // Los Martires
  18: 'A', // Puente Aranda
  19: 'A', // Antonio Narino
};



const DEFAULT_TRONCAL_COLOR = '#FB2C17';
const DEFAULT_ZONAL_COLOR = '#EAB308'; // SITP Yellow/General Zonal color
const ROUTE_ZONE_PREFIX_RE = /^(MP|RF|[A-HJ-MPT]{1,2})(?=\d|-|\b)/;

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

export function normalizeRouteCode(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normalizeRouteCodeForMatch(value: string | null | undefined): string {
  return normalizeRouteCode(value)
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+/g, '');
}

export function getRouteZoneLetters(value: string | null | undefined): string[] {
  const normalized = normalizeRouteCodeForMatch(value);
  if (!normalized) return [];
  if (normalized.includes('RUTAFACIL')) return ['RF'];

  const prefix = normalized.match(ROUTE_ZONE_PREFIX_RE)?.[1];
  if (!prefix) return [];
  if (prefix === 'RF') return ['RF'];
  if (prefix === 'MP') return ['M', 'P'];

  return Array.from(prefix).filter((letter) => letter in TRONCAL_COLORS);
}

export function getTroncalLetter(value: string | null | undefined): string | null {
  const normalized = normalizeRouteCode(value);
  if (!normalized) return null;

  // Ruta Facil (1-8) or explicit RF strings
  if (/^\d{1,2}$/.test(normalized) || /^\d+\s*-\s*\d+/.test(normalized) || normalized.includes('RUTA FACIL')) {
    return 'RF';
  }

  // AV. 1 de Mayo belongs visually to the Carrera 10 trunk (L), not to the
  // first "A" in "AV." or "G" prefix sometimes used.
  if (/(^|\b)(AV\.?\s*)?1(\s+DE)?\s+MAYO\b/.test(normalized) || /\b(CARRERA|CRA|KR)\s*10\b/.test(normalized)) {
    return 'L';
  }

  const routeLetters = getRouteZoneLetters(normalized);
  if (routeLetters.length > 0) return routeLetters[routeLetters.length - 1];

  const letter = normalized.match(/\b(RF|[A-HJ-MPT])\b/);
  return letter ? letter[1] : null;
}

export function getTroncalColor(value: string | null | undefined): string {
  const letter = getTroncalLetter(value);
  return letter ? TRONCAL_COLORS[letter] ?? DEFAULT_TRONCAL_COLOR : DEFAULT_TRONCAL_COLOR;
}

export function getZonalRouteColor(code?: string | null): string {
  const normalized = normalizeRouteCode(code);
  
  // Alimentadores should be Green (#009944)
  if (normalized.includes('-') && (normalized.startsWith('2-') || normalized.startsWith('3-') || normalized.startsWith('4-') || normalized.startsWith('5-') || normalized.startsWith('6-') || normalized.startsWith('7-') || normalized.startsWith('8-') || normalized.startsWith('9-') || normalized.startsWith('10-') || normalized.startsWith('11-') || normalized.startsWith('12-') || normalized.startsWith('13-') || normalized.startsWith('16-') || /^\d+-\d+$/.test(normalized))) {
    // This is a simplified heuristic for alimentadores which follow the X-Y format in Bogota
    // but better yet, let's just check the catalog type in main.ts.
    // For now, let's catch the obvious ones.
    return '#009944';
  }

  // Try to get the zone color from the code (e.g. F408 -> Red)
  const zoneLetter = getTroncalLetter(normalized);
  if (zoneLetter && TRONCAL_COLORS[zoneLetter]) {
    return TRONCAL_COLORS[zoneLetter];
  }

  return DEFAULT_ZONAL_COLOR;
}

export function getRouteColor(code: string, type: 'troncal' | 'zonal'): string {
  return type === 'troncal' ? getTroncalColor(code) : getZonalRouteColor(code);
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
    layout: { 'line-cap': 'round', 'line-join': 'round' },
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
    layout: { 'line-cap': 'round', 'line-join': 'round' },
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
  customGeometry?: { paths: number[][][] }
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
        properties: { code: routeCode, color: getRouteColor(routeCode, type) },
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

  map.addLayer({
    id: glowId,
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], type === 'troncal' ? DEFAULT_TRONCAL_COLOR : DEFAULT_ZONAL_COLOR] as any,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 20, 17, 30] as any,
      'line-opacity': 0.35,
      'line-blur': 6,
    },
  } as any);

  map.addLayer({
    id: lineId,
    type: 'line',
    source: sourceId,
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], type === 'troncal' ? DEFAULT_TRONCAL_COLOR : DEFAULT_ZONAL_COLOR] as any,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7, 17, 10] as any,
      'line-opacity': 1,
    },
  } as any);
}

export function clearHighlight(map: maplibregl.Map): void {
  if (map.getLayer('highlight-route')) map.removeLayer('highlight-route');
  if (map.getLayer('highlight-route-glow')) map.removeLayer('highlight-route-glow');
  if (map.getSource('highlight-temp-source')) map.removeSource('highlight-temp-source');
}
