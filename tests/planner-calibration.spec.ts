/**
 * Calibrated zonal speeds and boarding waits (spec §5.6.5).
 *
 * Pure logic — no page, no network. These assert the two things the calibration
 * is allowed to change: what a zonal ride costs (the stretch's own measured
 * speed, scaled by the hour and day type of the trip) and what boarding costs
 * (half the route's scheduled headway). Everything else — and the whole model
 * when no calibration is loaded — must stay exactly as it was.
 */

import { expect, test } from '@playwright/test';
import { findRoutes, getDistance, initRouter, setPlannerCalibration } from '../client/src/services/router';
import type { PlannerCalibrationData } from '../shared/calibration.js';
import type { RouteListItem } from '../client/src/types/transmilenio';
import type { PlanTime } from '../client/src/services/schedule';

const STOPS = ['A', 'B', 'C', 'D'];
const coordOf = (i: number): [number, number] => [-74.1, 4.6 + i * 0.01];

const line = (id: string): RouteListItem => ({
  id,
  code: id.toUpperCase(),
  name: id,
  origin: 'A',
  destination: 'D',
  type: 'zonal',
  stops: STOPS.map((nombre, i) => ({ nombre, codigo: nombre, coordinate: coordOf(i), kind: 'stop' as const })),
});

/** Metres the graph charges for A→D: three straight legs, no trace to measure. */
const RIDE_METRES = [0, 1, 2].reduce((sum, i) => sum + getDistance(coordOf(i), coordOf(i + 1)), 0);
const LEGS = 3;
/** What the constants charge, unchanged: 333 m/min plus 0.35 min dwell per leg. */
const CONSTANT_MINUTES = RIDE_METRES / 333 + 0.35 * LEGS;

const flat = (value: number) => Array.from({ length: 24 }, () => value);
const speedsFor = (kmh: number) => ({ A: { B: kmh }, B: { C: kmh }, C: { D: kmh } });

const calibration = (opts: {
  pairs?: Record<string, Record<string, number>>;
  factorH?: number[];
  factorF?: number[];
  headways?: Record<string, Record<string, number[]>>;
}): PlannerCalibrationData => ({
  version: 1,
  speeds: {
    factor: { H: opts.factorH ?? flat(1), S: flat(1), F: opts.factorF ?? flat(1) },
    pairs: opts.pairs ?? {},
  },
  headways: opts.headways ?? {},
});

// 2026-07-24 is a Friday, 2026-07-26 a Sunday, 2026-07-20 a Monday festivo.
const FRIDAY: PlanTime = { year: 2026, month: 7, day: 24, minute: 12 * 60 };
const SUNDAY: PlanTime = { year: 2026, month: 7, day: 26, minute: 12 * 60 };
const FESTIVO: PlanTime = { year: 2026, month: 7, day: 20, minute: 12 * 60 };

const search = {
  origin: [-74.1, 4.6] as [number, number],
  destination: [-74.1, 4.63] as [number, number],
  mode: 'mix' as const,
  minWalk: false,
  sortBy: 'time' as const,
};

/** The one ride of the only itinerary: its time, and the wait inside it. */
function ride(departAt: PlanTime = FRIDAY, mode: 'mix' | 'zonal' = 'mix') {
  const [plan] = findRoutes({ ...search, mode, departAt });
  const step = plan.steps.find((s) => s.type === 'ride')!;
  const wait = (step.boardMinute ?? 0) - (step.startMinute ?? 0);
  return { step, wait, minutes: step.time - wait, plan };
}

test.beforeEach(() => {
  setPlannerCalibration(null);
  initRouter([line('day')]);
});

test.afterEach(() => {
  // Module state outlives a test: leave the router as the other specs expect it.
  setPlannerCalibration(null);
});

test.describe('measured zonal speeds', () => {
  test('no calibration leaves the cost model exactly as it was', () => {
    const { minutes, wait } = ride();
    expect(minutes).toBeCloseTo(CONSTANT_MINUTES, 3);
    expect(wait).toBe(6);
  });

  test('a measured stretch is charged at its own commercial speed', () => {
    setPlannerCalibration(calibration({ pairs: speedsFor(12) }));
    expect(ride().minutes).toBeCloseTo(RIDE_METRES / ((12 * 1000) / 60), 3);
    // …and the slower measurement really is slower than the constants (15.2 km/h).
    expect(ride().minutes).toBeGreaterThan(CONSTANT_MINUTES);
  });

  test('an unmeasured stretch keeps the constants but still follows the hour', () => {
    setPlannerCalibration(calibration({ factorH: flat(1).map((_, h) => (h === 17 ? 0.5 : 1)) }));
    expect(ride({ ...FRIDAY, minute: 12 * 60 }).minutes).toBeCloseTo(CONSTANT_MINUTES, 3);
    expect(ride({ ...FRIDAY, minute: 17 * 60 }).minutes).toBeCloseTo(CONSTANT_MINUTES / 0.5, 3);
  });

  test('the hour of departure scales a measured stretch, and only that hour', () => {
    const factorH = flat(1).map((_, h) => (h === 17 ? 0.8 : 1));
    setPlannerCalibration(calibration({ pairs: speedsFor(20), factorH }));
    const midday = RIDE_METRES / ((20 * 1000) / 60);
    expect(ride({ ...FRIDAY, minute: 12 * 60 }).minutes).toBeCloseTo(midday, 3);
    expect(ride({ ...FRIDAY, minute: 17 * 60 }).minutes).toBeCloseTo(midday / 0.8, 3);
  });

  test('Sundays and festivos read the same, separate profile', () => {
    setPlannerCalibration(calibration({ pairs: speedsFor(20), factorH: flat(1), factorF: flat(1.5) }));
    const weekday = ride(FRIDAY).minutes; // 1.5x keeps the Sunday speed under the 34 km/h cap
    expect(ride(SUNDAY).minutes).toBeCloseTo(weekday / 1.5, 3);
    expect(ride(FESTIVO).minutes).toBeCloseTo(weekday / 1.5, 3);
  });

  test('a stretch faster than the troncal cruise is held to it, and still found in zonal mode', () => {
    // 60 km/h is not a bus in Bogotá; the cap (34 km/h) is what may be charged,
    // and the zonal-mode A* bound has to widen enough to keep the plan.
    setPlannerCalibration(calibration({ pairs: speedsFor(60) }));
    const { minutes, plan } = ride(FRIDAY, 'zonal');
    expect(plan.steps.some((s) => s.type === 'ride')).toBe(true);
    expect(minutes).toBeCloseTo(RIDE_METRES / 570, 3);
  });

  test('clearing the calibration restores the constants', () => {
    setPlannerCalibration(calibration({ pairs: speedsFor(8) }));
    expect(ride().minutes).toBeGreaterThan(CONSTANT_MINUTES);
    setPlannerCalibration(null);
    expect(ride().minutes).toBeCloseTo(CONSTANT_MINUTES, 3);
  });
});

test.describe('boarding waits from the dispatch programme', () => {
  const withHeadways = (hours: Record<number, number>, dayType: 'H' | 'F' = 'H') => {
    const table = flat(0).map((_, h) => hours[h] ?? 0);
    setPlannerCalibration(calibration({
      headways: { DAY: { H: dayType === 'H' ? table : flat(0), S: flat(0), F: dayType === 'F' ? table : flat(0) } },
    }));
  };

  test('half the headway of the departure hour is charged, not a flat 6', () => {
    withHeadways({ 12: 20 });
    const { wait, step } = ride();
    expect(wait).toBe(10);
    // The wait is inside the step the rider reads, exactly as the search charged it.
    expect(step.time).toBeCloseTo(CONSTANT_MINUTES + 10, 3);
  });

  test('a frequent route waits less than the constant', () => {
    withHeadways({ 12: 5 });
    expect(ride().wait).toBe(2.5);
  });

  test('a rare route is capped: past ~30 min riders time their arrival', () => {
    withHeadways({ 12: 60 });
    expect(ride().wait).toBe(15);
  });

  test('an hour with no dispatch borrows the hour the route opens with', () => {
    withHeadways({ 5: 10 });
    expect(ride({ ...FRIDAY, minute: 4 * 60 + 40 }).wait).toBe(5);
  });

  test('a route absent from the programme keeps the per-mode constant', () => {
    withHeadways({ 12: 20 });
    initRouter([line('other')]); // código OTHER has no headways
    expect(ride().wait).toBe(6);
  });

  test('the day type selects the programme', () => {
    withHeadways({ 12: 30 }, 'F');
    expect(ride(FRIDAY).wait).toBe(6);
    expect(ride(SUNDAY).wait).toBe(15);
  });
});
