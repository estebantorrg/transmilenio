/**
 * Service-schedule unit tests (spec §5.6.2).
 *
 * Pure logic — no page, no network: the parser, the Colombian holiday calendar
 * and the schedule-constrained router are exercised directly. These are the
 * rules that decide whether a route is offered at all, so they are the part of
 * the planner that must never regress silently.
 */

import { expect, test } from '@playwright/test';
import {
  createServiceClock,
  describeServiceSpans,
  festivoName,
  formatClockMinute,
  isFestivo,
  isOpenAt,
  parseServiceSpans,
  serviceIntervals,
  serviceMinutesOnPlanDay,
  serviceStatus,
  type PlanTime,
} from '../client/src/services/schedule';
import { findRoutes, initRouter } from '../client/src/services/router';
import type { RouteListItem } from '../client/src/types/transmilenio';

const spans = (rows: Array<[string, string, string]>) =>
  parseServiceSpans({ data: rows.map(([convencion, hora_inicio, hora_fin]) => ({ convencion, hora_inicio, hora_fin })) })!;

// 2026-07-24 is a Friday; 2026-07-20 (Independencia) is a Monday festivo.
const FRIDAY: PlanTime = { year: 2026, month: 7, day: 24, minute: 12 * 60 };

test.describe('horarios parser', () => {
  test('reads the catalog shapes, including the ones that trip naive parsing', () => {
    const parsed = spans([
      ['L-S', '4:30 AM', '11:00 PM'],
      ['D-F', '04:30 AM', '10:00 PM'], // zero-padded
      ['S', '5:00 AM', '2:00 pm'], //     lowercase meridiem
    ]);
    expect(parsed.map((s) => [s.start, s.end])).toEqual([
      [270, 1380],
      [270, 1320],
      [300, 840],
    ]);
  });

  test('a window closing after midnight spills into the next day', () => {
    // 168 rows in the committed catalog close at "12:20/12:30 AM".
    expect(spans([['L-S', '4:00 AM', '12:30 AM']])[0].end).toBe(1470);
  });

  test('identical rows collapse and unreadable hours yield "unknown"', () => {
    expect(spans([['D-F', '5:00 AM', '9:00 PM'], ['D-F', '5:00 AM', '9:00 PM']])).toHaveLength(1);
    expect(parseServiceSpans({ data: [{ convencion: '??', hora_inicio: 'x', hora_fin: 'y' }] })).toBeUndefined();
    expect(parseServiceSpans(undefined)).toBeUndefined();
  });
});

test.describe('Colombian holiday calendar', () => {
  test('matches the published 2026 festivos exactly', () => {
    const published = [
      [1, 1], [1, 12], [3, 23], [4, 2], [4, 3], [5, 1], [5, 18], [6, 8], [6, 15],
      [6, 29], [7, 20], [8, 7], [8, 17], [10, 12], [11, 2], [11, 16], [12, 8], [12, 25],
    ];
    for (const [month, day] of published) {
      expect(isFestivo(2026, month, day), `${month}-${day}`).toBe(true);
    }

    let count = 0;
    for (let month = 1; month <= 12; month++) {
      for (let day = 1; day <= 31; day++) if (isFestivo(2026, month, day)) count++;
    }
    expect(count).toBe(18);
  });

  test('applies the Emiliani shift and Easter offsets', () => {
    expect(isFestivo(2026, 1, 6)).toBe(false); // Reyes moves to Monday the 12th
    expect(festivoName(2026, 1, 12)).toBe('Día de los Reyes Magos');
    expect(festivoName(2027, 3, 25)).toBe('Jueves Santo'); // Easter 2027 = Mar 28
  });
});

test.describe('service windows', () => {
  const troncal = spans([['L-S', '4:30 AM', '11:00 PM'], ['D-F', '4:30 AM', '10:00 PM']]);

  test('open / closed status carries the next boundary', () => {
    expect(serviceStatus(troncal, FRIDAY).state).toBe('open');
    expect(serviceStatus(troncal, FRIDAY).detail).toContain('11:00 p.m.');

    const dawn = serviceStatus(troncal, { ...FRIDAY, minute: 120 });
    expect(dawn.state).toBe('closed');
    expect(dawn.detail).toContain('4:30 a.m.');
  });

  test('a 00:10 departure still sees the previous day window', () => {
    const late = spans([['L-S', '4:00 AM', '12:30 AM']]);
    const intervals = serviceIntervals(late, createServiceClock({ ...FRIDAY, minute: 10 }));
    expect(isOpenAt(intervals, 10)).toBe(true);
  });

  test('holidays run holiday service, not weekday service', () => {
    const holiday: PlanTime = { year: 2026, month: 7, day: 20, minute: 10 * 60 };
    // A Monday–Friday route does NOT run on a Monday festivo…
    expect(serviceStatus(spans([['L-V', '5:00 AM', '10:00 PM']]), holiday).state).toBe('closed');
    // …while a route that only files a Sunday row falls back to it (§5.6.2).
    expect(serviceStatus(spans([['D', '6:00 AM', '8:00 PM']]), holiday).state).toBe('open');
    expect(serviceStatus(spans([['D-F', '6:00 AM', '8:00 PM']]), holiday).state).toBe('open');
  });

  test('daily coverage counts the whole plan day, including the post-midnight spill', () => {
    const clock = createServiceClock(FRIDAY);
    expect(serviceMinutesOnPlanDay(serviceIntervals(troncal, clock))).toBe(1110); // 4:30–23:00
    // A window closing at 12:30 AM covers 4:00–24:00 today plus 0:00–0:30 from
    // the previous day's run — 1230 min of the plan day, not 1200.
    const late = spans([['L-D', '4:00 AM', '12:30 AM']]);
    expect(serviceMinutesOnPlanDay(serviceIntervals(late, clock))).toBe(1230);
  });

  test('the detail table groups windows by day type', () => {
    expect(describeServiceSpans(troncal)).toEqual([
      { days: 'Lun a sáb', hours: '4:30 a.m. – 11:00 p.m.' },
      { days: 'Dom y festivos', hours: '4:30 a.m. – 10:00 p.m.' },
    ]);
    expect(formatClockMinute(1470)).toBe('12:30 a.m.');
  });
});

test.describe('schedule-aware routing', () => {
  const line = (id: string, serviceSpans: RouteListItem['serviceSpans']): RouteListItem => ({
    id,
    code: id.toUpperCase(),
    name: id,
    origin: 'A',
    destination: 'D',
    type: 'zonal',
    serviceSpans,
    stops: ['A', 'B', 'C', 'D'].map((nombre, i) => ({
      nombre,
      codigo: nombre,
      coordinate: [-74.1, 4.6 + i * 0.01] as [number, number],
      kind: 'stop' as const,
    })),
  });

  const search = {
    origin: [-74.1, 4.6] as [number, number],
    destination: [-74.1, 4.63] as [number, number],
    mode: 'mix' as const,
    minWalk: false,
    sortBy: 'time' as const,
  };

  test.beforeEach(() => {
    initRouter([line('day', spans([['L-D', '5:00 AM', '11:00 PM']]))]);
  });

  test('plans in service carry clock times and no warnings', () => {
    const [plan] = findRoutes({ ...search, departAt: FRIDAY });
    expect(plan.departMinute).toBe(720);
    expect(plan.arriveMinute).toBeGreaterThan(720);
    expect(plan.outsideService).toBeUndefined();
  });

  test('a short wait for the first bus is charged, not refused', () => {
    const [plan] = findRoutes({ ...search, departAt: { ...FRIDAY, minute: 4 * 60 + 50 } });
    const ride = plan.steps.find((step) => step.type === 'ride')!;
    expect(ride.serviceWait).toBe(10);
    expect(ride.boardMinute).toBeGreaterThanOrEqual(300);
    expect(plan.outsideService).toBeUndefined();
  });

  test('a boarding near closing time is flagged', () => {
    const [plan] = findRoutes({ ...search, departAt: { ...FRIDAY, minute: 22 * 60 + 50 } });
    expect(plan.lastServiceRisk).toBe(true);
  });

  test('when nothing runs, options come back tagged instead of empty', () => {
    const closed = { ...search, departAt: { ...FRIDAY, minute: 120 } };
    for (const params of [closed, { ...closed, enforceSchedules: true }]) {
      // Unfiltered by default; enforced searches fall back to the same tagged
      // options rather than a dead end (§5.6.2).
      const plans = findRoutes(params);
      expect(plans.length).toBeGreaterThan(0);
      expect(plans[0].outsideService).toBe(true);
      expect(plans[0].steps.some((step) => step.outsideService)).toBe(true);
    }
  });

  test('an unknown schedule never hides a route', () => {
    initRouter([line('unknown', undefined)]);
    const plans = findRoutes({ ...search, departAt: { ...FRIDAY, minute: 120 }, enforceSchedules: true });
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0].outsideService).toBeUndefined();
  });

  test('the schedule filter is optional: closed routes are offered unless asked to hide them', () => {
    // Both connect origin → destination; at noon only the day route runs.
    initRouter([
      line('day', spans([['L-D', '5:00 AM', '11:00 PM']])),
      line('night', spans([['L-D', '10:00 PM', '11:30 PM']])),
    ]);

    const codesOf = (params: Parameters<typeof findRoutes>[0]) =>
      findRoutes(params).map((plan) => plan.steps.find((step) => step.type === 'ride')?.routeCode);

    // Default: the closed option still exists, labelled, and ranks behind.
    const open = codesOf({ ...search, departAt: FRIDAY });
    expect(open).toContain('DAY');
    expect(open).toContain('NIGHT');
    const nightPlan = findRoutes({ ...search, departAt: FRIDAY }).find(
      (plan) => plan.steps.some((step) => step.routeCode === 'NIGHT')
    )!;
    expect(nightPlan.outsideService).toBe(true);
    expect(open[0]).toBe('DAY');

    // Enforced: it is gone.
    const strict = new Set(codesOf({ ...search, departAt: FRIDAY, enforceSchedules: true }));
    expect([...strict]).toEqual(['DAY']);
  });

  test('a service that runs all day outranks an equally fast peak-only one', () => {
    initRouter([
      line('allday', spans([['L-D', '4:30 AM', '11:00 PM']])),
      line('peak', spans([['L-D', '11:00 AM', '1:00 PM']])),
    ]);

    const plans = findRoutes({ ...search, departAt: FRIDAY });
    expect(plans.length).toBeGreaterThanOrEqual(2);
    expect(plans[0].steps.find((step) => step.type === 'ride')?.routeCode).toBe('ALLDAY');

    const peak = plans.find((plan) => plan.steps.some((step) => step.routeCode === 'PEAK'))!;
    expect(peak.shortService).toBe(true);
    expect(peak.servicePenalty).toBeGreaterThan(0);
    expect(plans[0].shortService).toBeUndefined();
    expect(plans[0].servicePenalty).toBeUndefined();
    // Both are open right now and take the same time — the preference is a
    // ranking term, never an inflated duration.
    expect(peak.totalTime).toBe(plans[0].totalTime);
  });
});
