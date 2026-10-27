import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { escapeHTML } from '../utils/html';
import { fadeBackground, NETWORK_FADES, restoreBackground } from './backgroundDim';

/**
 * Routes kept on the map beside the selected one — the compare button on each
 * route row and "Comparar con otra ruta" in the route panel (spec §5.4.2b). The
 * selected route keeps its own highlight; each compared route stays drawn
 * underneath it, labelled with its código, with the network faded behind, and
 * listed in a legend at the map's top right, from which it is taken off again.
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

// Not the routes' own colours — B11 and B16 are both Autonorte green — and not
// near any troncal's either: the 13 of them cover the wheel, and an orange,
// purple and cyan read as H, D and L. Neon magenta, neon lime and white, each
// drawn with a casing no corridor has (white, dark for the white line).
export const COMPARE_PALETTE = ['#FF2BD6', '#A3FF12', '#FFFFFF'];

const SOURCE = 'compare-routes';
const LAYERS = ['compare-routes-casing', 'compare-routes-line', 'compare-routes-label'];

let compared: ComparedRoute[] = [];
let changeListener: (() => void) | null = null;

export function comparedRoutes(): readonly ComparedRoute[] {
  return compared;
}

export function isCompared(id: string): boolean {
  return compared.some((route) => route.id === id);
}

/** Called after every change, wherever it came from — the route panel's button follows the legend's ×. */
export function onComparedChange(listener: () => void): void {
  changeListener = listener;
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
  renderLegend(map);
  const data: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: compared.map((route) => ({
      type: 'Feature',
      properties: { code: route.code, color: route.color, casing: route.color === '#FFFFFF' ? '#050812' : '#FFFFFF' },
      geometry: { type: 'MultiLineString', coordinates: route.paths },
    })),
  };
  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (source) source.setData(data);
  else addLayers(map, data);
  // The same fade a selected route gets: with every corridor in full colour, a
  // compared line is one more coloured line. A selected route's highlight owns it otherwise.
  if (compared.length) fadeBackground(map, NETWORK_FADES);
  else if (!map.getLayer('highlight-route')) restoreBackground(map);
  changeListener?.();
}

/** The key to the lines, on the map itself: the panel that added a route is gone once another is picked. */
function renderLegend(map: MapLibreMap): void {
  let legend = document.getElementById('compare-legend');
  if (!compared.length) {
    legend?.remove();
    return;
  }
  if (!legend) {
    legend = document.createElement('ul');
    legend.id = 'compare-legend';
    legend.className = 'compare-legend';
    legend.setAttribute('aria-label', 'Rutas en comparación');
    legend.addEventListener('click', (event) => {
      const id = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]')?.dataset.id;
      if (!id) return;
      removeCompared(map, id);
      // The pressed × is gone; keep keyboard focus in the legend while it lasts.
      document.querySelector<HTMLButtonElement>('#compare-legend button')?.focus();
    });
    document.body.append(legend);
  }
  legend.innerHTML = compared
    .map((r) => `<li><span class="compare-legend-dot" style="background:${r.color}"></span>${escapeHTML(r.code)}` +
      `<button type="button" data-id="${escapeHTML(r.id)}" aria-label="Quitar ${escapeHTML(r.code)} de la comparación" title="Quitar">×</button></li>`)
    .join('');
}

function addLayers(map: MapLibreMap, data: GeoJSON.FeatureCollection): void {
  map.addSource(SOURCE, { type: 'geojson', data });
  // Under the selected route's highlight, which is the one being read now.
  const beforeId = ['highlight-route-casing', 'stations-circle'].find((id) => map.getLayer(id));
  map.addLayer({
    id: LAYERS[0],
    type: 'line',
    source: SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'casing'] as any,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 14, 9, 17, 12] as any,
      'line-opacity': 0.9,
    },
  }, beforeId);
  map.addLayer({
    id: LAYERS[1],
    type: 'line',
    source: SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'] as any,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 17, 7] as any,
    },
  }, beforeId);
  // Each line names itself, so the map reads without the legend.
  map.addLayer({
    id: LAYERS[2],
    type: 'symbol',
    source: SOURCE,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 280,
      'text-field': ['get', 'code'] as any,
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 16, 14] as any,
      'text-padding': 6,
    },
    // A pill in the line's colour, dark text: a código, not a street name.
    paint: {
      'text-color': '#050812',
      'text-halo-color': ['get', 'color'] as any,
      'text-halo-width': 3,
    },
  });
}
