import { test, expect } from '@playwright/test';
import { corridorGapFeatures } from '../client/src/layers/routes.ts';

/**
 * The Troncales layer patches a trunk ArcGIS has not surveyed yet from the
 * traces of the routes that ride it (`corridorGapFeatures`, spec §4.2) — the
 * Bosa–Tibanica stretch, drawn in Z. It must patch ONLY that: a surveyed
 * corridor drawn with sparse vertices is still surveyed between them.
 *
 * Indexed by vertex alone it was not, and the Caracas between Calle 49 and
 * Calle 51 — a straight run ArcGIS draws with vertices hundreds of metres apart
 * — counted as unsurveyed: its temporary stations became "new trunk" stations,
 * Z61 rides past them, and the map drew a Z strip in red over the Caracas blue.
 */

// A straight north–south corridor 2.2 km long with no vertex in between.
const caracas = {
  attributes: { objectid: 1, letra_trazado_troncal: 'A', troncal: 'Caracas' },
  geometry: { paths: [[[-74.067, 4.63], [-74.067, 4.65]]] },
} as any;
const estacion = (lng: number, lat: number) => ({ attributes: { longitud_estacion: lng, latitud_estacion: lat } }) as any;
// A route riding that corridor, its trace sampled every ~110 m.
const ride = (code: string, from: number, to: number, lng = -74.067) => {
  const pts: number[][] = [];
  for (let lat = from; lat <= to + 1e-9; lat += 0.001) pts.push([lng, +lat.toFixed(4)]);
  return { code, type: 'troncal', geometry: { paths: [pts] } } as any;
};

test.describe('the trunk corridors the map patches in', () => {
  test('a surveyed straight is surveyed between its vertices', () => {
    // A station halfway down the straight, a kilometre from either vertex, and
    // a Z route riding past it: nothing here is a new trunk.
    const patch = corridorGapFeatures([ride('Z61', 4.63, 4.65)], [caracas], [estacion(-74.067, 4.64)]);
    expect(patch.features.map((f) => f.attributes.letra_trazado_troncal)).toEqual([]);
  });

  test('a trunk past the end of the survey is still patched, in its own letter', () => {
    // The same route running on south for 1.5 km past the corridor's end to a
    // station no survey reaches: that stretch is the new trunk.
    const patch = corridorGapFeatures(
      [ride('Z61', 4.615, 4.65), ride('A60', 4.63, 4.65)],
      [caracas],
      [estacion(-74.067, 4.64), estacion(-74.067, 4.616)]
    );
    expect(patch.features.map((f) => f.attributes.letra_trazado_troncal)).toEqual(['Z']);
    const lats = patch.features[0].geometry.paths.flat().map((p: number[]) => p[1]);
    // It reaches the new station and stops at the survey, not along it.
    expect(Math.min(...lats)).toBeLessThan(4.617);
    expect(Math.max(...lats)).toBeLessThan(4.632);
  });
});
