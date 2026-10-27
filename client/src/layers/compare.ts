import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

/**
 * Routes kept on the map beside the selected one — "Comparar" in the route
 * panel (spec §5.4.2b). The selected route keeps its own highlight; each compared
 * route stays drawn underneath it until removed, so two routes to the same
 * place can be read side by side.
 *
 * Website only: the live buses stay on the selected route, so comparing never
 * multiplies calls to the live host.
 */
export interface ComparedRoute {
  id: string;
  code: string;
  color: string;
  paths: number[][][];
}

export const COMPARE_MAX = 3;

// Colours no troncal uses: B11 and B16 are both Autonorte green, and two
// greens side by side compare nothing.
export const COMPARE_PALETTE = ['#F97316', '#A855F7', '#06B6D4'];

const SOURCE = 'compare-routes';
const LAYERS = ['compare-routes-casing', 'compare-routes-line'];

let compared: ComparedRoute[] = [];

export function comparedRoutes(): readonly ComparedRoute[] {
  return compared;
}

export function isCompared(id: string): boolean {
  return compared.some((route) => route.id === id);
}

/**
 * The list after toggling `route`: removed if present, else added in the first
 * free colour — unless the list is full or the route has no drawn trace yet.
 */
export function toggledCompared(
  list: readonly ComparedRoute[],
  route: { id: string; code: string; geometry?: { paths: number[][][] } }
): ComparedRoute[] {
  if (list.some((r) => r.id === route.id)) return list.filter((r) => r.id !== route.id);
  const paths = route.geometry?.paths;
  if (!paths?.length || list.length >= COMPARE_MAX) return [...list];
  const color = COMPARE_PALETTE.find((c) => !list.some((r) => r.color === c)) ?? COMPARE_PALETTE[0];
  return [...list, { id: route.id, code: route.code, color, paths }];
}

export function toggleCompared(map: MapLibreMap, route: { id: string; code: string; geometry?: { paths: number[][][] } }): void {
  compared = toggledCompared(compared, route);
  render(map);
}

export function removeCompared(map: MapLibreMap, id: string): void {
  compared = compared.filter((route) => route.id !== id);
  render(map);
}

function render(map: MapLibreMap): void {
  const data: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: compared.map((route) => ({
      type: 'Feature',
      properties: { code: route.code, color: route.color },
      geometry: { type: 'MultiLineString', coordinates: route.paths },
    })),
  };
  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(SOURCE, { type: 'geojson', data });
  // Under the selected route's highlight, which is the one being read now.
  const beforeId = ['highlight-route-casing', 'stations-circle'].find((id) => map.getLayer(id));
  map.addLayer({
    id: LAYERS[0],
    type: 'line',
    source: SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#000000',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7, 17, 10] as any,
      'line-opacity': 0.8,
    },
  }, beforeId);
  map.addLayer({
    id: LAYERS[1],
    type: 'line',
    source: SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'] as any,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4, 17, 6] as any,
    },
  }, beforeId);
}
