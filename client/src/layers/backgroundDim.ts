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
