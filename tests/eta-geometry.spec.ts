/**
 * The trace geometry under both live ETAs (`shared/eta_geometry.js`): the
 * server's arrivals board and the app's voice answer. It was two hand copies
 * and the server's had no test; these pin the projection itself, and that
 * neither side grows its own copy again.
 */

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { projectOntoPaths, traceToPaths } from '../shared/eta_geometry.js';

const M_PER_DEG_LAT = (Math.PI / 180) * 6_371_000;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((4.6 * Math.PI) / 180);

test('a point beside a straight trace projects onto its foot', () => {
  const paths = traceToPaths([[-74.1, 4.6], [-74.08, 4.6]]);
  const proj = projectOntoPaths(paths, -74.09, 4.6 + 100 / M_PER_DEG_LAT)!;
  expect(Math.abs(proj.perp - 100)).toBeLessThan(1);
  expect(Math.abs(proj.along - 0.01 * M_PER_DEG_LNG)).toBeLessThan(1);
});

test('the gap between the paths of a MultiLineString is not distance travelled', () => {
  const paths = traceToPaths([
    [[-74.1, 4.6], [-74.09, 4.6]],
    [[-74.08, 4.6], [-74.07, 4.6]],
  ]);
  const proj = projectOntoPaths(paths, -74.075, 4.6)!;
  expect(proj.perp).toBeLessThan(1);
  // 0.010° of the first path + 0.005° of the second; the 0.010° gap is left out.
  expect(Math.abs(proj.along - 0.015 * M_PER_DEG_LNG)).toBeLessThan(1);
});

test('a trace that is not a line has no paths, and no paths no projection', () => {
  expect(traceToPaths(undefined)).toEqual([]);
  expect(traceToPaths([['x', 'y']])).toEqual([]);
  expect(traceToPaths([[[-74.1, 4.6]]])).toEqual([]); // a one-point path is dropped
  expect(projectOntoPaths([], -74.09, 4.6)).toBeNull();
});

test('the board and the voice ETA read the one copy', () => {
  for (const file of ['server/src/services/stop_arrivals.ts', 'client/src/services/routeEta.ts']) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    expect(source, file).toContain("from '../../../shared/eta_geometry.js'");
    expect(source, file).not.toContain('function projectOntoPaths');
    expect(source, file).not.toContain('ON_ROUTE_MAX_PERP_M =');
  }
});

test('the board and the app voice index read the one zonal rule', () => {
  // Zonal or troncal picks the cruising speed of both ETAs. Each file carried
  // its own copy of `isZonalService` with a comment saying they must agree.
  for (const file of ['server/src/services/stop_arrivals.ts', 'server/src/bundle_mobile_data.ts']) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    expect(source, file).toContain("import { isZonalService } from './");
    expect(source, file).not.toContain("includes('ALIMENTADOR')");
  }
});
