import type maplibregl from 'maplibre-gl';

/**
 * Fading the rest of the network behind one subject — a selected route, a planned
 * journey — and putting it back.
 *
 * The "back" values used to be copies of each layer's style, written out again in
 * every place that faded it, so a style change came undone the next time a
 * highlight cleared. Now each layer's own value is read before its first fade and
 * that is what comes back.
 */
export type Fade = [layerId: string, property: string, value: number];

/** The network behind a selected route or the compared ones (`routes.ts`, `compare.ts`). */
export const NETWORK_FADES: Fade[] = [
  ['troncal-corridors-line', 'line-opacity', 0.1],
  ['troncal-corridors-casing', 'line-opacity', 0.05],
  ['troncal-corridors-labels', 'text-opacity', 0.1],
  ['zonal-routes-line', 'line-opacity', 0.02],
  ['zonal-routes-casing', 'line-opacity', 0.01],
  ['zonal-routes-glow', 'line-opacity', 0],
  ['stations-circle', 'icon-opacity', 0.25],
  ['stations-labels', 'text-opacity', 0.2],
  ['stops-circle', 'icon-opacity', 0.25],
  ['stops-labels', 'text-opacity', 0.2],
  ['cable-traces-line', 'line-opacity', 0.1],
  ['cable-stations-circle', 'icon-opacity', 0.25],
  ['cable-stations-labels', 'text-opacity', 0.2],
];

/** `layer|property` → the value it had before anything faded it. */
const saved = new Map<string, unknown>();

export function fadeBackground(map: maplibregl.Map, fades: Fade[]): void {
  for (const [layer, property, value] of fades) {
    if (!map.getLayer(layer)) continue;
    const key = `${layer}|${property}`;
    if (!saved.has(key)) saved.set(key, map.getPaintProperty(layer, property));
    map.setPaintProperty(layer, property, value);
  }
}

export function restoreBackground(map: maplibregl.Map): void {
  for (const [key, value] of saved) {
    const [layer, property] = key.split('|');
    if (map.getLayer(layer)) map.setPaintProperty(layer, property, value);
  }
  saved.clear();
}
