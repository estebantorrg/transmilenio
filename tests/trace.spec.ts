/**
 * Route traces (`client/src/services/trace.ts`, spec §5.6.3): every ride leg is
 * measured along the route's own `trazado`. The shapes that make this hard are
 * the common ones in the SITP — a loop whose stop list starts mid-way round, a
 * route that calls at one stop twice, a trace shipped in pieces. Each failure
 * mode is silent (the leg falls back to a straight line, or charges kilometres),
 * so they are pinned here.
 */

import { expect, test } from '@playwright/test';
import { buildTraceIndex, traceDistanceBetween } from '../client/src/services/trace';

const M_PER_DEG = 111320;
/** A point `east`/`north` metres from a fixed origin (cos(4.6°) ≈ 0.9968). */
const at = (east: number, north: number): [number, number] => [-74.07 + east / (M_PER_DEG * 0.99678), 4.6 + north / M_PER_DEG];
const stop = (east: number, north: number) => ({ coordinate: at(east, north) });

// A 1 km square ring, one vertex per 100 m, closed — starting at its NE corner,
// i.e. halfway round from where the route boards (the west side).
function squareRing(): number[][] {
  const corners: Array<[number, number]> = [[1000, 1000], [1000, 0], [0, 0], [0, 1000], [1000, 1000]];
  const ring: number[][] = [];
  for (let c = 0; c < corners.length - 1; c++) {
    const [x0, y0] = corners[c];
    const [x1, y1] = corners[c + 1];
    for (let k = 0; k < 10; k++) ring.push(at(x0 + ((x1 - x0) * k) / 10, y0 + ((y1 - y0) * k) / 10));
  }
  ring.push(ring[0]);
  return ring;
}

test('a loop whose stop list starts halfway round is ridden from its first stop', () => {
  // The ring starts at its NE corner; the route boards on the west side and goes
  // N → E → S. Read from vertex zero, every stop past the NE corner looked like
  // a backtrack (route 97's first stop sits 26 km into its own 45 km trace).
  const stops = [stop(0, 50), stop(0, 1000), stop(1000, 1000), stop(1000, 0), stop(500, 0)];
  const index = buildTraceIndex(stops, [squareRing()])!;
  expect(index).not.toBeNull();
  expect(index.unmatched).toBe(0);
  expect(traceDistanceBetween(index, 0, 1)!).toBeCloseTo(950, -1);
  expect(traceDistanceBetween(index, 1, 2)!).toBeCloseTo(1000, -1);
  expect(traceDistanceBetween(index, 2, 3)!).toBeCloseTo(1000, -1);
  expect(traceDistanceBetween(index, 3, 4)!).toBeCloseTo(500, -1);
});

test('a trace in two pieces with a branch far away keeps the piece the stops ride', () => {
  const main = [at(0, 0), at(0, 500), at(0, 1000), at(0, 1500)];
  const branch = [at(5000, 0), at(5000, 800)]; // 5 km off: not a joint, a branch
  const stops = [stop(0, 0), stop(0, 750), stop(0, 1500)];
  const index = buildTraceIndex(stops, [main, branch])!;
  expect(index).not.toBeNull();
  expect(traceDistanceBetween(index, 0, 1)!).toBeCloseTo(750, -1);
  expect(traceDistanceBetween(index, 1, 2)!).toBeCloseTo(750, -1);
});

test('a trace drawn backwards is ridden forwards', () => {
  const backwards = [at(0, 1500), at(0, 1000), at(0, 500), at(0, 0)];
  const stops = [stop(0, 0), stop(0, 500), stop(0, 1000), stop(0, 1500)];
  const index = buildTraceIndex(stops, [backwards])!;
  expect(index).not.toBeNull();
  expect(traceDistanceBetween(index, 0, 3)!).toBeCloseTo(1500, -1);
});
