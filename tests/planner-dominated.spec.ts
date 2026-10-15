/**
 * Alternatives the planner must not offer (spec §5.6.2): a plan another plan
 * beats on transfers, time and walking alike. The search keeps arrivals within
 * a slack of the best one, and without this the slack came back as nonsense —
 * the same bus one stop further with a walk back, or a bus boarded 245 m away to
 * ride back past the origin when the destination is a 3-minute walk. Pure logic,
 * on a hand-made line of real Teusaquillo paraderos.
 */

import { expect, test } from '@playwright/test';
import { findRoutes, initRouter, type JourneyPlan } from '../client/src/services/router';
import type { RouteListItem } from '../client/src/types/transmilenio';

type Stop = NonNullable<RouteListItem['stops']>[number];

const paradero = (codigo: string, lng: number, lat: number): Stop => ({ nombre: codigo, codigo, coordinate: [lng, lat], kind: 'stop' });

const zonal = (code: string, ...stops: Stop[]): RouteListItem => ({
  id: code.toLowerCase(),
  code,
  name: code,
  origin: stops[0].nombre,
  destination: stops[stops.length - 1].nombre,
  type: 'zonal',
  stops,
});

const TEUSAQUILLO = paradero('347B00', -74.0720794, 4.6237535);
const MAGDALENA = paradero('147B00', -74.0726255, 4.6266578);
const ALCALDIA = paradero('351B00', -74.0726406, 4.6289373);
const NORTE = paradero('900X00', -74.0727, 4.6335);

const plan = (origin: [number, number], destination: [number, number]): JourneyPlan[] =>
  findRoutes({
    origin,
    destination,
    mode: 'mix',
    minWalk: false,
    sortBy: 'transfers',
    departAt: { year: 2026, month: 9, day: 14, minute: 20 * 60 },
  });

const rides = (p: JourneyPlan): string[] => p.steps.filter((s) => s.type === 'ride').map((s) => `${s.routeCode} ${s.fromCode}>${s.toCode}`);

test('a bus slower and longer on foot than walking the whole way is not offered', () => {
  initRouter([zonal('621', TEUSAQUILLO, MAGDALENA, ALCALDIA, NORTE)]);
  // Beside Alcaldía; the destination is ~140 m away across the block.
  const plans = plan([-74.072866, 4.628596], [-74.071614, 4.628771]);
  expect(plans.map(rides)).toEqual([[]]);
});

test('a plan never ends walking to a stop only to walk on to the destination', () => {
  // Twelve paraderos crowd the destination, so the 621's last stop (650 m out)
  // is not one of its candidates; the cluster's far end is a 440 m transfer walk
  // from it. That used to end the plan "walk to that paradero, then walk on".
  const m = (metres: number): number => 4.6 + metres / 111320;
  const cluster = Array.from({ length: 12 }, (_, i) => paradero(`C${i}`, -74.07, m(100 + i * 10)));
  initRouter([
    zonal('621', paradero('ORI', -74.07, m(-3000)), paradero('ALT', -74.07, m(650))),
    zonal('Z1', ...cluster),
  ]);
  const plans = plan([-74.07, m(-3000)], [-74.07, m(0)]);
  expect(plans.length).toBeGreaterThan(0);
  for (const p of plans) {
    const walkAfterWalk = p.steps.some((s, i) => i > 0 && s.type === 'walk' && p.steps[i - 1].type === 'walk');
    expect(walkAfterWalk).toBe(false);
  }
  expect(plans[0].steps.map((s) => s.toCode)).toEqual(['ALT', 'END']);
});

test('a route whose own stop is a short walk away is used, however many stops are nearer', () => {
  // Twelve paraderos within 210 m; the 621 stops 420 m from the destination.
  // As the thirteenth-nearest stop it could not be left there at all.
  const m = (metres: number): number => 4.6 + metres / 111320;
  const cluster = Array.from({ length: 12 }, (_, i) => paradero(`C${i}`, -74.07, m(-100 - i * 10)));
  initRouter([
    zonal('621', paradero('ORI', -74.07, m(3000)), paradero('NEAR', -74.07, m(420)), paradero('FAR', -74.07, m(-1100))),
    zonal('Z1', ...cluster),
  ]);
  const [best] = plan([-74.07, m(3000)], [-74.07, m(0)]);
  expect(best.steps.map((s) => s.toCode)).toEqual(['NEAR', 'END']);
});

test('no plan rides one stop past the destination to walk back', () => {
  initRouter([zonal('621', TEUSAQUILLO, MAGDALENA, ALCALDIA, NORTE)]);
  // From beside Teusaquillo to a door beside Alcaldía: NORTE is one stop on and
  // still within reach on foot, so it was offered as the second plan.
  const plans = plan([-74.0718, 4.6236], [-74.0724, 4.6291]);
  expect(plans.length).toBeGreaterThan(0);
  for (const p of plans) expect(p.steps.some((s) => s.toCode === '900X00')).toBe(false);
});
