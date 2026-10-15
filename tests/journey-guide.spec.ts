/**
 * In-journey guidance (spec §5.10): what the app says, and when, as the rider
 * moves along a plan. Pure logic — fixes are synthetic positions walked along a
 * straight street, 1 m of latitude at a time.
 */

import { expect, test } from '@playwright/test';
import { advanceGuide, initialGuideState, prepareGuide, type GuideStep } from '../client/src/services/journeyGuide';

const at = (metres: number): [number, number] => [-74.07, 4.6 + metres / 111320];
const point = (name: string, metres: number) => ({ name, code: name, coord: at(metres) });

const ride = (to: number, via: Array<[string, number]>): GuideStep => ({
  type: 'ride',
  routeCode: 'C17',
  routeType: 'zonal',
  from: point('A', 0),
  to: point('C', to),
  via: via.map(([name, metres]) => point(name, metres)),
  path: [at(0), at(to)],
  time: 6,
  distance: to,
});

const walkTo = (from: number, to: number): GuideStep => ({
  type: 'walk',
  from: point('C', from),
  to: point('Destino', to),
  via: [],
  path: [at(from), at(to)],
  time: 3,
  distance: to - from,
});

/** Every cue the rider hears riding `steps` from 0 to `end`, every 10 m. */
function ridden(steps: GuideStep[], end: number): Array<{ at: number; kind: string; written: string }> {
  const prepared = prepareGuide({ steps });
  let state = initialGuideState();
  const cues: Array<{ at: number; kind: string; written: string }> = [];
  for (let m = 0; m <= end; m += 10) {
    const update = advanceGuide(prepared, { coord: at(m), accuracy: 10, at: m }, state);
    state = update.state;
    if (update.progress.cue) cues.push({ at: m, kind: update.progress.cue.kind, written: update.progress.cue.written });
  }
  return cues;
}

test('"get off here" waits until the stop before it is behind', () => {
  // B and C are 120 m apart — 7% of SITP stop pairs are under 150 m. The cue
  // used to fire 150 m out, before B, and riders got off at B.
  const cues = ridden([ride(1120, [['B', 1000]]), walkTo(1120, 1300)], 1300);
  const alight = cues.find((cue) => cue.kind === 'alight')!;
  expect(alight.written).toBe('Bájate aquí, en C.');
  expect(alight.at).toBeGreaterThanOrEqual(1000);
  expect(cues.filter((cue) => cue.kind === 'alight')).toHaveLength(1);
});

test('a ride is announced in order: board, next stop, get off, arrived', () => {
  const cues = ridden([ride(2000, [['B', 1000], ['B2', 1500]]), walkTo(2000, 2200)], 2200);
  expect(cues.map((cue) => cue.kind)).toEqual(['board', 'prepare', 'alight', 'walk', 'arrived']);
  // "Próxima: C" only once B2 — the last stop before C — has gone by.
  expect(cues.find((cue) => cue.kind === 'prepare')!.at).toBeGreaterThanOrEqual(1500);
});
