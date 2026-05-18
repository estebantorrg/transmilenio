/**
 * Route and trunk polyline layers.
 */

import maplibregl from 'maplibre-gl';
import type { TroncalCorridorFeature, TroncalRouteFeature, ZonalRouteFeature } from '../types/transmilenio';

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
};

const ZONAL_TYPE_COLORS: Record<number, string> = {
  2: '#C8102E',
  3: '#00618E',
  4: '#5EB130',
  5: '#F59E0B',
  6: '#7C3AED',
  7: '#64748B',
};

const DEFAULT_TRONCAL_COLOR = '#FB2C17';
const DEFAULT_ZONAL_COLOR = '#00618E';
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

export function getZonalRouteColor(code?: string | null, routeType?: number): string {
  const letters = getRouteZoneLetters(code);
  const destinationLetter = letters[letters.length - 1];
  if (destinationLetter) return TRONCAL_COLORS[destinationLetter] ?? DEFAULT_ZONAL_COLOR;
  return routeType ? ZONAL_TYPE_COLORS[routeType] ?? DEFAULT_ZONAL_COLOR : DEFAULT_ZONAL_COLOR;
}

export function getRouteColor(code: string, type: 'troncal' | 'zonal', zonalRouteType?: number): string {
  return type === 'troncal' ? getTroncalColor(code) : getZonalRouteColor(code, zonalRouteType);
}

function routesToGeoJSON(
  features: (TroncalRouteFeature | ZonalRouteFeature)[],
  type: 'troncal' | 'zonal'
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((f) => {
      const isTroncal = type === 'troncal';
      const attrs = f.attributes as any;
      const code = isTroncal
        ? attrs.route_name_ruta_troncal
        : attrs.codigo_definitivo_ruta_zonal;
      const color = isTroncal ? getTroncalColor(code) : getZonalRouteColor(code, attrs.tipo_ruta_zonal);

      return {
        type: 'Feature' as const,
        properties: {
          id: attrs.objectid,
          code,
          letter: isTroncal ? getTroncalLetter(code) : undefined,
          color,
          name: isTroncal
            ? `${attrs.origen_ruta_troncal} -> ${attrs.destino_ruta_troncal}`
            : attrs.denominacion_ruta_zonal,
          type,
          origin: isTroncal ? attrs.origen_ruta_troncal : attrs.origen_ruta_zonal,
          destination: isTroncal ? attrs.destino_ruta_troncal : attrs.destino_ruta_zonal,
          busType: isTroncal ? attrs.desc_tipo_bus_ruta_troncal : undefined,
          schedule: isTroncal ? attrs.horario_lunes_viernes : undefined,
          operator: !isTroncal ? attrs.operador_ruta_zonal : undefined,
          length: isTroncal ? attrs.longitud_ruta_troncal : attrs.longitud_ruta_zonal,
        },
        geometry: {
          type: 'MultiLineString' as const,
          coordinates: f.geometry.paths,
        },
      };
    }),
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
    layout: { 'line-cap': 'round', 'line-join': 'round' },
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
  routes: TroncalRouteFeature[]
): void {
  const geojson = routesToGeoJSON(routes, 'troncal');
  map.addSource('troncal-routes', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'troncal-routes-glow',
    type: 'line',
    source: 'troncal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 10, 17, 18],
      'line-opacity': 0.14,
      'line-blur': 4,
    },
  });

  map.addLayer({
    id: 'troncal-routes-line',
    type: 'line',
    source: 'troncal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3, 17, 5],
      'line-opacity': 0.82,
    },
  });
}

export function addZonalRoutesLayer(
  map: maplibregl.Map,
  routes: ZonalRouteFeature[]
): void {
  const geojson = routesToGeoJSON(routes, 'zonal');
  map.addSource('zonal-routes', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'zonal-routes-glow',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 8, 17, 14],
      'line-opacity': 0.1,
      'line-blur': 3,
    },
  });

  map.addLayer({
    id: 'zonal-routes-line',
    type: 'line',
    source: 'zonal-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2, 17, 3.5],
      'line-opacity': 0.58,
    },
  });
}

export function toggleTroncalRoutes(map: maplibregl.Map, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  [
    'troncal-corridors-casing',
    'troncal-corridors-line',
    'troncal-corridors-labels',
  ].forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  });
}

export function toggleZonalRoutes(map: maplibregl.Map, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  ['zonal-routes-glow', 'zonal-routes-line'].forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  });
}

export function highlightRoute(
  map: maplibregl.Map,
  routeCode: string,
  type: 'troncal' | 'zonal'
): void {
  clearHighlight(map);

  const sourceId = `${type}-routes`;
  const source = map.getSource(sourceId) as maplibregl.GeoJSONSource;
  if (!source) return;

  map.addLayer({
    id: 'highlight-route-glow',
    type: 'line',
    source: sourceId,
    filter: ['==', ['get', 'code'], routeCode],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], type === 'troncal' ? DEFAULT_TRONCAL_COLOR : DEFAULT_ZONAL_COLOR],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 20, 17, 30],
      'line-opacity': 0.26,
      'line-blur': 6,
    },
  });

  map.addLayer({
    id: 'highlight-route',
    type: 'line',
    source: sourceId,
    filter: ['==', ['get', 'code'], routeCode],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], type === 'troncal' ? DEFAULT_TRONCAL_COLOR : DEFAULT_ZONAL_COLOR],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7, 17, 10],
      'line-opacity': 1,
    },
  });
}

export function clearHighlight(map: maplibregl.Map): void {
  if (map.getLayer('highlight-route')) map.removeLayer('highlight-route');
  if (map.getLayer('highlight-route-glow')) map.removeLayer('highlight-route-glow');
}
