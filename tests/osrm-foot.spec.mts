/**
 * The walking router's answer and its pace (`shared/osrm_foot.js`, spec §5.6.4):
 * one reader for the server and the app, and FOSSGIS's one request a second.
 */

import { expect, test } from '@playwright/test';
import { createPacer, readFootRoute } from '../shared/osrm_foot.js';

const answer = (overrides: Record<string, unknown> = {}) => ({
  code: 'Ok',
  routes: [{ distance: 200, geometry: { coordinates: [[-74.07, 4.6], [-74.07, 4.601]] } }],
  waypoints: [{ distance: 12 }, { distance: 30 }],
  ...overrides,
});

test('the walked distance includes both snap legs', () => {
  expect(readFootRoute(answer())).toEqual({ coordinates: [[-74.07, 4.6], [-74.07, 4.601]], distance: 242 });
  expect(readFootRoute(answer({ waypoints: [] }))!.distance).toBe(200);
});

test('an answer with no usable route reads as none', () => {
  expect(readFootRoute(answer({ code: 'NoRoute' }))).toBeNull();
  expect(readFootRoute(answer({ routes: [{ distance: 200, geometry: { coordinates: [[-74.07, 4.6]] } }] }))).toBeNull();
  expect(readFootRoute(answer({ routes: [{ distance: 200, geometry: { coordinates: [[-74.07, 'x'], [-74.07, 4.6]] } }] }))).toBeNull();
  expect(readFootRoute(null)).toBeNull();
});

test('calls are spaced a second apart, and one that would wait too long is refused', () => {
  const pace = createPacer(1000, 2500);
  expect([pace(0), pace(0), pace(0), pace(0)]).toEqual([0, 1000, 2000, null]);
  expect(pace(10_000)).toBe(0);
});
