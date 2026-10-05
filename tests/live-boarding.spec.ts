/**
 * The live wait at a trip's first boarding (spec §5.6.6).
 *
 * Pure logic — no page, no network. Two halves: the calculation that turns a
 * route's live positions into "this is the bus you board" (`liveWait.ts`), and
 * the pass that puts that wait into the itineraries in place of the one the
 * search assumed, and re-ranks them (`applyLiveBoarding`, `router.ts`).
 *
 * The thresholds asserted here were measured, not chosen: two recorded runs
 * replayed through this code (`scratch/live-spike/replay.mts`).
 */

import { expect, test } from '@playwright/test';
import {
  approachingEtas,
  busesOfVariant,
  catchMargin,
  chooseBoarding,
  fixAgeMinutes,
  readLiveBuses,
  type LiveBusFix,
} from '../client/src/services/liveWait';
import { buildTraceIndex, projectOntoTrace } from '../client/src/services/trace';
import { describeLiveBoarding, watchLiveBoarding } from '../client/src/services/liveBoarding';
import {
  applyLiveBoarding,
  findRoutes,
  getDistance,
  initRouter,
  liveBoardingTargets,
  setPlannerCalibration,
  type JourneyPlan,
} from '../client/src/services/router';
import type { RouteListItem } from '../client/src/types/transmilenio';
import type { PlanTime } from '../client/src/services/schedule';

// Friday 2026-07-24, 12:00:00 in Bogotá (UTC−5).
const NOW = Date.UTC(2026, 6, 24, 17, 0, 0);
const FRIDAY_NOON: PlanTime = { year: 2026, month: 7, day: 24, minute: 12 * 60 };

test.describe('reading the feed', () => {
  test('a fix is as old as its Bogotá timestamp says', () => {
    expect(fixAgeMinutes('11:59:15 AM', NOW)).toBeCloseTo(0.75, 5);
    expect(fixAgeMinutes('12:00:00 PM', NOW)).toBe(0);
    // A few seconds into the future is clock skew, not a different day.
    expect(fixAgeMinutes('12:00:20 PM', NOW)).toBe(0);
    expect(fixAgeMinutes('12:05:00 PM', NOW)).toBeNull();
    expect(fixAgeMinutes('', NOW)).toBeNull();
    expect(fixAgeMinutes('hace un rato', NOW)).toBeNull();
    // Just after midnight, a fix from just before it.
    const justAfterMidnight = Date.UTC(2026, 6, 25, 5, 0, 30); // 00:00:30 Bogotá
    expect(fixAgeMinutes('11:59:45 PM', justAfterMidnight)).toBeCloseTo(0.75, 5);
  });

  test('a bus that stopped reporting is not a position', () => {
    const buses = readLiveBuses(
      [
        { latitude: 4.6, longitude: -74.1, lasttime: '11:59:30 AM', destino_limpio: 'Portal Américas' },
        { latitude: 4.61, longitude: -74.1, lasttime: '11:40:00 AM', destino_limpio: 'Portal Américas' }, // 20 min old
        { latitude: 'x', longitude: -74.1 },
        { lat: 4.62, lng: -74.1 }, // no timestamp: kept, age unknown
      ],
      NOW
    );
    expect(buses.map((b) => [b.lat, b.ageMin, b.destino])).toEqual([
      [4.6, 0.5, 'portal americas'],
      [4.62, null, ''],
    ]);
  });

  test('only the buses of the direction being boarded count', () => {
    const bus = (destino: string): LiveBusFix => ({ lng: -74.1, lat: 4.6, destino, ageMin: 0 });
    const both = [bus('gaviotas'), bus('metrovivienda'), bus('gaviotas')];
    // A zonal code is both directions; the feed names each bus's, as the variant is named.
    expect(busesOfVariant(both, ['Metrovivienda'])).toHaveLength(1);
    expect(busesOfVariant(both, ['Br. Otro', 'GAVIOTAS'])).toHaveLength(2);
    // Named two ways and neither is ours: not something to guess between.
    expect(busesOfVariant(both, ['Portal Tunal'])).toEqual([]);
    // One direction only, under a name we do not hold: a troncal lookup is made
    // by destination, so the answer is already this direction.
    expect(busesOfVariant([bus('portal sur'), bus('portal sur')], ['Portal Sur - JFK'])).toHaveLength(2);
    // The feed names nothing: nothing to filter on.
    expect(busesOfVariant([bus(''), bus('')], ['Portal Tunal'])).toHaveLength(2);
  });
});

test.describe('minutes until a bus reaches the stop', () => {
  // A straight 4 km trace along one meridian: along-track metres are distances.
  const at = (m: number): [number, number] => [-74.1, 4.6 + m / 111_320];
  const stops = [0, 1000, 2000, 3000, 4000].map((m, i) => ({ nombre: `S${i}`, codigo: `S${i}`, coordinate: at(m) }));
  const trace = buildTraceIndex(stops, [[at(0), at(4000)]])!;
  const project = (p: [number, number]) => projectOntoTrace(trace, p);
  const fix = (m: number, ageMin: number | null = 0, off = 0): LiveBusFix => ({ lng: at(m)[0] + off, lat: at(m)[1], destino: '', ageMin });

  test('a point is measured on the same ruler as the stops', () => {
    expect(trace.stopAlong[2]).toBeCloseTo(2000, -1);
    const hit = project(at(1500))!;
    expect(hit.along).toBeCloseTo(1500, -1);
    expect(hit.error).toBeLessThan(1);
  });

  test('remaining metres over the speed, less the age of the position', () => {
    const etas = approachingEtas({ buses: [fix(1200, 0.5)], project, stopAlong: trace.stopAlong[2], speedMpm: 400 });
    // 800 m at 400 m/min is 2 min; the fix is 30 s old, so 1.5 from now.
    expect(etas).toHaveLength(1);
    expect(etas[0]).toBeCloseTo(1.5, 1);
  });

  test('an unknown age is taken as the measured median, and never goes negative', () => {
    const [unknown] = approachingEtas({ buses: [fix(1200, null)], project, stopAlong: trace.stopAlong[2], speedMpm: 400 });
    expect(unknown).toBeCloseTo(1.25, 1);
    const [atTheStop] = approachingEtas({ buses: [fix(1950, 2)], project, stopAlong: trace.stopAlong[2], speedMpm: 400 });
    expect(atTheStop).toBe(0);
  });

  test('a bus past the stop, off the route or out of range is not approaching', () => {
    const etas = approachingEtas({
      buses: [
        fix(2100), // 100 m past it
        fix(1990), // 10 m short: GPS jitter, still here
        fix(1000, 0, 0.003), // ~330 m off the trace
        fix(0), // 2 km out: 5 min
      ],
      project,
      stopAlong: trace.stopAlong[2],
      speedMpm: 400,
    });
    expect(etas.map((e) => Math.round(e * 10) / 10)).toEqual([0, 5]);
    // 15 km at 400 m/min is 37 min: says nothing useful about the wait.
    expect(approachingEtas({ buses: [fix(0)], project, stopAlong: 15_000, speedMpm: 400 })).toEqual([]);
  });
});

test.describe('which bus the rider boards', () => {
  test('the margin protects the walk, and grows with how far out the bus is', () => {
    expect(catchMargin(0, 1)).toBe(0.5); // at the stop: only "arriving now" is withheld
    expect(catchMargin(1, 2)).toBe(1);
    expect(catchMargin(4, 4)).toBe(2);
    // A bus eight minutes out is known to ±3: two minutes is not enough.
    expect(catchMargin(4, 8)).toBeCloseTo(3.2, 5);
  });

  test('a bus the rider reaches with margin to spare is a boarding to count on', () => {
    expect(chooseBoarding([5], 2)).toEqual({ status: 'catch', etaMin: 5, waitMin: 3, firm: true, approx: false });
  });

  test('a bus inside the margin is still boarded, and said to be tight', () => {
    // Four minutes from the stop, bus in five: replayed, a rider made 73–94 %
    // of these. It used to be "no alcanzas".
    expect(chooseBoarding([5], 4)).toEqual({ status: 'catch', etaMin: 5, waitMin: 1, firm: false, approx: false });
    // At the stop already: a bus arriving this instant is boarded, not promised.
    expect(chooseBoarding([0.2], 0)).toMatchObject({ status: 'catch', firm: false, waitMin: 0.2 });
    expect(chooseBoarding([0.6], 0)).toMatchObject({ status: 'catch', firm: true });
  });

  test('a bus predicted before the rider is there is named, and the next one boarded', () => {
    expect(chooseBoarding([3, 5, 9], 4)).toEqual({
      status: 'next',
      etaMin: 5,
      missedEtaMin: 3,
      waitMin: 1,
      firm: false,
      approx: false,
    });
    expect(chooseBoarding([1, 9], 4)).toMatchObject({ status: 'next', etaMin: 9, missedEtaMin: 1, firm: true });
  });

  test('only buses that go first gives no wait to charge', () => {
    expect(chooseBoarding([1, 3], 4)).toEqual({ status: 'missed', missedEtaMin: 1, waitMin: null, firm: false, approx: true });
  });

  test('past ten minutes a bus is a guide, not a promise', () => {
    const far = chooseBoarding([14], 2);
    expect(far.status).toBe('catch');
    expect(far.approx).toBe(true);
    // …so a rider six minutes from the stop is never PROMISED one: it would
    // have to be ten minutes out for the margin to cover it.
    expect(chooseBoarding([9.5], 6)).toMatchObject({ status: 'catch', firm: false, approx: false });
    expect(chooseBoarding([10.5], 6).approx).toBe(true);
  });

  test('nothing in sight is not a reading', () => {
    expect(chooseBoarding([], 3)).toEqual({ status: 'none', waitMin: null, firm: false, approx: false });
  });
});

test.describe('the itineraries, with the live wait in them', () => {
  // Two troncal lines over the same five stations, 1 km apart; the rider starts
  // at S2 and rides to S4. `fast` is the better plan on paper.
  const at = (m: number): [number, number] => [-74.1, 4.6 + m / 111_320];
  const line = (id: string, nombre: string): RouteListItem => ({
    id,
    code: id.toUpperCase(),
    name: nombre,
    catalogNombre: nombre,
    origin: 'S0',
    destination: nombre,
    type: 'troncal',
    geometry: { paths: [[at(0), at(4000)]] },
    stops: [0, 1000, 2000, 3000, 4000].map((m, i) => ({ nombre: `S${i}`, codigo: `S${i}`, coordinate: at(m), kind: 'station' as const })),
  });
  const search = {
    origin: at(2000),
    destination: at(4000),
    mode: 'mix' as const,
    minWalk: false,
    sortBy: 'time' as const,
    departAt: FRIDAY_NOON,
  };
  const bus = (m: number, destino: string, lasttime = '12:00:00 PM') => ({
    latitude: at(m)[1],
    longitude: at(m)[0],
    lasttime,
    destino_limpio: destino,
  });
  const rideOf = (plan: JourneyPlan) => plan.steps.find((s) => s.type === 'ride')!;
  const pool = (): JourneyPlan[] => {
    const out: { candidates?: JourneyPlan[] } = {};
    findRoutes(search, out);
    return out.candidates!;
  };

  test.beforeEach(() => {
    setPlannerCalibration(null);
    initRouter([line('a1', 'Portal Uno'), line('b2', 'Portal Dos')]);
  });

  test('one lookup per route direction boarded first', () => {
    const targets = liveBoardingTargets(pool());
    expect(targets.map((t) => [t.routeCode, t.routeType, t.nombre]).sort()).toEqual([
      ['A1', 'troncal', 'Portal Uno'],
      ['B2', 'troncal', 'Portal Dos'],
    ]);
  });

  test('the wait that was assumed is replaced by the one that is real', () => {
    const plans = pool();
    // The direct ride on each line (the pool also holds plans that change buses).
    const a1 = plans.find((p) => rideOf(p).routeId === 'a1' && p.transfers === 0)!;
    const b2 = plans.find((p) => rideOf(p).routeId === 'b2' && p.transfers === 0)!;
    const before = { a1: a1.totalTime, b2: b2.totalTime };
    const assumed = rideOf(a1).assumedWait!;
    expect(assumed).toBe(3); // troncal, no headway on file

    // A1's bus is 2 km back: 5 min. B2's is 400 m back: 1 min.
    const shown = applyLiveBoarding(
      plans,
      new Map([
        ['a1', [bus(0, 'Portal Uno')]],
        ['b2', [bus(1600, 'Portal Dos')]],
      ]),
      { nowMs: NOW, sortBy: 'time', departAt: FRIDAY_NOON }
    );

    expect(rideOf(a1).live).toMatchObject({ status: 'catch', approx: false });
    expect(rideOf(a1).live!.etaMin).toBeCloseTo(5, 0);
    expect(rideOf(b2).live).toMatchObject({ status: 'catch' });
    expect(rideOf(b2).live!.etaMin).toBeCloseTo(1, 0);
    // The wait is what is left of the bus's minutes once the rider is at the
    // stop, and the totals moved by the difference from the assumption (they
    // are whole minutes, so to within one).
    for (const [plan, was] of [[a1, before.a1], [b2, before.b2]] as const) {
      const ride = rideOf(plan);
      const ready = plan.steps.slice(0, plan.steps.indexOf(ride)).reduce((sum, st) => sum + st.time, 0);
      expect(ride.boardWait!).toBeCloseTo(Math.max(0, ride.live!.etaMin! - ready), 5);
      expect(Math.abs(plan.totalTime - was - (ride.boardWait! - assumed))).toBeLessThan(1.01);
    }
    expect(a1.totalTime).toBeGreaterThan(before.a1);
    expect(b2.totalTime).toBeLessThan(before.b2);
    // …and the bus that is nearly here is now the first plan.
    expect(rideOf(shown[0]).routeId).toBe('b2');
    // The clock on the card follows the live wait, not the assumption.
    expect(rideOf(b2).boardMinute! - rideOf(b2).startMinute!).toBeCloseTo(rideOf(b2).boardWait!, 5);
  });

  test('a bus going the other way on the same street is not coming', () => {
    const plans = pool();
    applyLiveBoarding(plans, new Map([['a1', [bus(1600, 'Portal Uno'), bus(1900, 'Otro Portal')]]]), { nowMs: NOW, departAt: FRIDAY_NOON });
    const a1 = plans.find((p) => rideOf(p).routeId === 'a1')!;
    expect(rideOf(a1).live!.etaMin).toBeCloseTo(1, 0); // the 400 m one, not the 100 m one
  });

  test('no reading leaves the plan as the search made it', () => {
    const plans = pool();
    const before = plans.map((p) => [rideOf(p).routeId, p.totalTime, rideOf(p).time]);
    // Missing, failed (null), and "nothing in sight" are all not a reading.
    applyLiveBoarding(plans, new Map<string, unknown[] | null>([['a1', null], ['b2', []]]), { nowMs: NOW, sortBy: 'time', departAt: FRIDAY_NOON });
    expect(plans.map((p) => [rideOf(p).routeId, p.totalTime, rideOf(p).time])).toEqual(before);
    for (const p of plans) expect(rideOf(p).live).toBeUndefined();
  });

  test('a bus that goes before the rider is there costs a whole headway', () => {
    // Starting ~300 m east of S2: a few minutes' walk to the platform.
    const out: { candidates?: JourneyPlan[] } = {};
    findRoutes({ ...search, origin: [at(2000)[0] + 0.0027, at(2000)[1]] }, out);
    const plans = out.candidates!;
    const a1 = plans.find((p) => rideOf(p).routeId === 'a1' && p.transfers === 0)!;
    const ready = a1.steps.slice(0, a1.steps.indexOf(rideOf(a1))).reduce((sum, st) => sum + st.time, 0);
    expect(ready).toBeGreaterThan(2);
    const assumed = rideOf(a1).assumedWait!;
    const rideOnly = rideOf(a1).time - assumed;
    // 400 m from the stop: there in a minute, well before the rider.
    applyLiveBoarding(plans, new Map([['a1', [bus(1600, 'Portal Uno')]]]), { nowMs: NOW, departAt: FRIDAY_NOON });
    expect(rideOf(a1).live).toMatchObject({ status: 'missed', waitMin: null });
    expect(rideOf(a1).time).toBeCloseTo(rideOnly + assumed * 2, 5);
  });

  test('a bus pulling in as the rider stands at the stop is boarded with no wait', () => {
    const plans = pool();
    const a1 = plans.find((p) => rideOf(p).routeId === 'a1' && p.transfers === 0)!;
    const rideOnly = rideOf(a1).time - rideOf(a1).assumedWait!;
    // 100 m from the stop, 15 s ago: it is at the platform now.
    applyLiveBoarding(plans, new Map([['a1', [bus(1900, 'Portal Uno', '11:59:45 AM')]]]), { nowMs: NOW, departAt: FRIDAY_NOON });
    expect(rideOf(a1).live).toMatchObject({ status: 'catch', firm: false });
    expect(rideOf(a1).time).toBeCloseTo(rideOnly, 5);
  });

  test('each refresh starts from the assumption, and a lost reading restores it', () => {
    const plans = pool();
    const a1 = plans.find((p) => rideOf(p).routeId === 'a1')!;
    const original = rideOf(a1).time;
    const total = a1.totalTime;
    applyLiveBoarding(plans, new Map([['a1', [bus(0, 'Portal Uno')]]]), { nowMs: NOW, departAt: FRIDAY_NOON });
    const withFive = rideOf(a1).time;
    expect(withFive).toBeGreaterThan(original);
    // The bus has moved 800 m closer: 3 min now, not 5 + 3.
    applyLiveBoarding(plans, new Map([['a1', [bus(800, 'Portal Uno')]]]), { nowMs: NOW, departAt: FRIDAY_NOON });
    expect(rideOf(a1).time).toBeCloseTo(withFive - 2, 1);
    applyLiveBoarding(plans, new Map(), { nowMs: NOW, departAt: FRIDAY_NOON });
    expect(rideOf(a1).time).toBeCloseTo(original, 5);
    expect(a1.totalTime).toBe(total);
    expect(rideOf(a1).live).toBeUndefined();
  });

  test('the ride itself is never re-timed, only the wait before it', () => {
    const plans = pool();
    const a1 = plans.find((p) => rideOf(p).routeId === 'a1')!;
    const ride = rideOf(a1);
    const rideOnly = ride.time - ride.assumedWait!;
    expect(rideOnly).toBeGreaterThan(getDistance(at(2000), at(4000)) / 600); // sanity: it is a real ride
    applyLiveBoarding(plans, new Map([['a1', [bus(0, 'Portal Uno')]]]), { nowMs: NOW, departAt: FRIDAY_NOON });
    expect(ride.time - ride.boardWait!).toBeCloseTo(rideOnly, 5);
  });
});

test.describe('an open plan, kept current', () => {
  const at = (m: number): [number, number] => [-74.1, 4.6 + m / 111_320];
  const line = (id: string, nombre: string): RouteListItem => ({
    id,
    code: id.toUpperCase(),
    name: nombre,
    catalogNombre: nombre,
    origin: 'S0',
    destination: nombre,
    type: 'troncal',
    geometry: { paths: [[at(0), at(4000)]] },
    stops: [0, 1000, 2000, 3000, 4000].map((m, i) => ({ nombre: `S${i}`, codigo: `S${i}`, coordinate: at(m), kind: 'station' as const })),
  });
  const search = { origin: at(2000), destination: at(4000), mode: 'mix' as const, minWalk: false, sortBy: 'time' as const, departAt: FRIDAY_NOON };
  const rideOf = (plan: JourneyPlan) => plan.steps.find((s) => s.type === 'ride')!;
  const pool = (): JourneyPlan[] => {
    const out: { candidates?: JourneyPlan[] } = {};
    findRoutes(search, out);
    return out.candidates!;
  };

  test.beforeEach(() => {
    setPlannerCalibration(null);
    initRouter([line('a1', 'Portal Uno'), line('b2', 'Portal Dos')]);
  });

  test('the clock on the cards is counted from now, not from the search', () => {
    const plans = pool();
    const plan = plans[0];
    const total = plan.totalTime;
    const boarded = rideOf(plan).boardMinute!;
    expect(plan.departMinute).toBe(12 * 60);
    // Seven minutes later, with no reading at all: same trip, later clock.
    applyLiveBoarding(plans, new Map(), { nowMs: NOW + 7 * 60_000, departAt: { ...FRIDAY_NOON, minute: 12 * 60 + 7 } });
    expect(plan.departMinute).toBe(12 * 60 + 7);
    expect(rideOf(plan).boardMinute).toBeCloseTo(boarded + 7, 5);
    expect(plan.totalTime).toBe(total);
  });

  test('a watch asks once per first-boarded route, and shows what answered', async () => {
    const plans = pool();
    const asked: string[] = [];
    const updates: JourneyPlan[][] = [];
    const stop = watchLiveBoarding({
      pool: plans,
      sortBy: 'time',
      isActive: () => true,
      onUpdate: (shown) => updates.push(shown),
      fetchBuses: async (target) => {
        asked.push(target.routeCode);
        // B2 answers with a bus 1.2 km back (3 min, less the age an unstamped fix
        // is taken to have); A1's lookup fails.
        return target.routeId === 'b2' ? [{ latitude: at(800)[1], longitude: at(800)[0], destino_limpio: 'Portal Dos' }] : null;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    expect(asked.sort()).toEqual(['A1', 'B2']);
    expect(updates.length).toBeGreaterThan(0);
    const shown = updates[updates.length - 1];
    expect(rideOf(shown[0]).routeId).toBe('b2');
    expect(rideOf(shown[0]).live).toMatchObject({ status: 'catch', approx: false });
    // The lookup that failed left its plan on the wait it was planned with.
    const a1 = plans.find((p) => rideOf(p).routeId === 'a1')!;
    expect(rideOf(a1).live).toBeUndefined();
    expect(rideOf(a1).boardWait).toBe(rideOf(a1).assumedWait);
  });

  test('a plan nobody is looking at is not followed', async () => {
    let asked = 0;
    const stop = watchLiveBoarding({
      pool: pool(),
      isActive: () => false,
      onUpdate: () => {
        throw new Error('updated a plan that is not on screen');
      },
      fetchBuses: async () => {
        asked++;
        return null;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    expect(asked).toBe(0);
  });
});

test.describe('what the card says', () => {
  const line = (live: Record<string, unknown>) =>
    describeLiveBoarding({ routeCode: 'B11', live: { asOf: 0, waitMin: 0, firm: true, approx: false, ...live } as never });

  test('worded from the rider’s side: whether they make it', () => {
    expect(line({ status: 'catch', etaMin: 3.2 })).toEqual({ text: 'B11 pasa en 3 min · alcanzas', tone: 'catch' });
    expect(line({ status: 'catch', etaMin: 0.6 })).toEqual({ text: 'B11 pasa en 1 min · alcanzas', tone: 'catch' });
    expect(line({ status: 'catch', etaMin: 0.4 })).toEqual({ text: 'B11 pasa en menos de 1 min · alcanzas', tone: 'catch' });
  });

  test('inside the margin it is tight, not lost', () => {
    expect(line({ status: 'catch', etaMin: 5, firm: false })).toEqual({ text: 'B11 pasa en 5 min · vas justo', tone: 'tight' });
  });

  test('a bus that goes first is stated as a prediction, with the one after', () => {
    expect(line({ status: 'next', etaMin: 9, missedEtaMin: 1.4 })).toEqual({
      text: 'B11 pasa en 1 min, antes de que llegues · el siguiente, en 9 min',
      tone: 'missed',
    });
    expect(line({ status: 'next', etaMin: 5, missedEtaMin: 2, firm: false })?.text).toBe(
      'B11 pasa en 2 min, antes de que llegues · el siguiente, en 5 min (justo)'
    );
    expect(line({ status: 'missed', missedEtaMin: 2, waitMin: null, firm: false, approx: true })).toEqual({
      text: 'B11 pasa en 2 min, antes de que llegues',
      tone: 'missed',
    });
    expect(line({ status: 'missed', missedEtaMin: 0.3, waitMin: null })?.text).toBe('B11 está pasando ahora');
  });

  test('a bus too far out to promise is said as a guide', () => {
    expect(line({ status: 'catch', etaMin: 14, approx: true })).toEqual({ text: 'B11 pasa en unos 14 min', tone: 'approx' });
    expect(line({ status: 'next', etaMin: 13, missedEtaMin: 3, approx: true })).toEqual({
      text: 'B11 pasa en 3 min, antes de que llegues · el siguiente, en unos 13 min',
      tone: 'approx',
    });
  });

  test('no reading, no line', () => {
    expect(describeLiveBoarding({ routeCode: 'B11' })).toBeNull();
    expect(line({ status: 'none', waitMin: null })).toBeNull();
  });
});
