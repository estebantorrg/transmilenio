/**
 * Route and trunk polyline layers.
 */

import maplibregl from 'maplibre-gl';
import type { TroncalCorridorFeature, TroncalRouteFeature, ZonalRouteFeature } from '../types/transmilenio';

export const TRONCAL_COLORS: Record<string, string> = {
  A: '#20419A',
  B: '#7AC143',
  C: '#FDBB30',
  D: '#7A68AE',
  E: '#AB650D',
  F: '#E31B23',
  G: '#00A4E4',
  H: '#F6891F',
  J: '#DD9BA5',
  K: '#CFAB7A',
  L: '#00AAA6',
  M: '#A21984',
};

const ZONAL_TYPE_COLORS: Record<number, string> = {
  2: '#C8102E',
  3: '#00618E',
  4: '#5EB130',
  5: '#F59E0B',
  6: '#7C3AED',
  7: '#64748B',
};

const DEFAULT_TRONCAL_COLOR = '#C60C30';
const DEFAULT_ZONAL_COLOR = '#00618E';
const PRIORITY_LAYERS = ['stations-hitbox', 'stations-circle', 'stops-hitbox', 'stops-circle', 'wagons-fill'];

export function markClickHandled(e: maplibregl.MapMouseEvent): void {
  e.preventDefault();
}

export function getTroncalLetter(value: string | null | undefined): string | null {
  const match = value?.trim().match(/[A-HJ-M]/i);
  return match ? match[0].toUpperCase() : null;
}

export function getTroncalColor(value: string | null | undefined): string {
  const letter = getTroncalLetter(value);
  return letter ? TRONCAL_COLORS[letter] ?? DEFAULT_TRONCAL_COLOR : DEFAULT_TRONCAL_COLOR;
}

export function getZonalRouteColor(routeType?: number): string {
  return routeType ? ZONAL_TYPE_COLORS[routeType] ?? DEFAULT_ZONAL_COLOR : DEFAULT_ZONAL_COLOR;
}

export function getRouteColor(code: string, type: 'troncal' | 'zonal', zonalRouteType?: number): string {
  return type === 'troncal' ? getTroncalColor(code) : getZonalRouteColor(zonalRouteType);
}

function hasHigherPriorityFeature(map: maplibregl.Map, e: maplibregl.MapMouseEvent): boolean {
  const existing = PRIORITY_LAYERS.filter((id) => map.getLayer(id));
  if (existing.length === 0) return false;
  return map.queryRenderedFeatures(e.point, { layers: existing }).length > 0;
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
      const color = isTroncal ? getTroncalColor(code) : getZonalRouteColor(attrs.tipo_ruta_zonal);

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
    layout: { 'line-cap': 'round', 'line-join': 'round' },
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
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3, 17, 5],
      'line-opacity': 0.82,
    },
  });

  map.on('click', 'troncal-routes-line', (e) => {
    if (e.defaultPrevented || hasHigherPriorityFeature(map, e)) return;
    const feature = e.features?.[0];
    if (!feature?.properties) return;
    showRoutePopup(map, feature, e.lngLat);
  });

  map.on('mouseenter', 'troncal-routes-line', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'troncal-routes-line', () => {
    map.getCanvas().style.cursor = '';
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
      'line-opacity': 0.55,
    },
  });

  map.on('click', 'zonal-routes-line', (e) => {
    if (e.defaultPrevented || hasHigherPriorityFeature(map, e)) return;
    const feature = e.features?.[0];
    if (!feature?.properties) return;
    showRoutePopup(map, feature, e.lngLat);
  });

  map.on('mouseenter', 'zonal-routes-line', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'zonal-routes-line', () => {
    map.getCanvas().style.cursor = '';
  });
}

function showRoutePopup(
  map: maplibregl.Map,
  feature: maplibregl.MapGeoJSONFeature,
  lngLat: maplibregl.LngLat
): void {
  const p = feature.properties!;
  const color = p.color || (p.type === 'troncal' ? DEFAULT_TRONCAL_COLOR : DEFAULT_ZONAL_COLOR);

  const html = `
    <div class="popup-route">
      <div class="popup-route-code" style="color: ${color}">${p.code}</div>
      <div class="popup-route-name">${p.name}</div>
      <div class="popup-route-endpoints">
        <span class="dot" style="background: #34D399"></span>
        ${p.origin}
        <span style="color: #4B5563">-></span>
        <span class="dot" style="background: #E3342F"></span>
        ${p.destination}
      </div>
      ${p.busType ? `<div style="margin-top:8px;font-size:11px;color:#9CA3AF">${p.busType}</div>` : ''}
      ${p.schedule ? `<div style="font-size:11px;color:#9CA3AF">${p.schedule}</div>` : ''}
      ${p.operator ? `<div style="font-size:11px;color:#9CA3AF">${p.operator}</div>` : ''}
      ${p.length ? `<div style="font-size:11px;color:#9CA3AF">${Number(p.length).toFixed(1)} km</div>` : ''}
    </div>
  `;

  new maplibregl.Popup({ offset: 8, maxWidth: '300px' })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
}

export function toggleTroncalRoutes(map: maplibregl.Map, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  [
    'troncal-corridors-casing',
    'troncal-corridors-line',
    'troncal-corridors-labels',
    'troncal-routes-glow',
    'troncal-routes-line',
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
