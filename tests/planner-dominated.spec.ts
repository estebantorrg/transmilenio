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

test('no plan rides one stop past the destination to walk back', () => {
  initRouter([zonal('621', TEUSAQUILLO, MAGDALENA, ALCALDIA, NORTE)]);
  // From beside Teusaquillo to a door beside Alcaldía: NORTE is one stop on and
  // still within reach on foot, so it was offered as the second plan.
  const plans = plan([-74.0718, 4.6236], [-74.0724, 4.6291]);
  expect(plans.length).toBeGreaterThan(0);
  for (const p of plans) expect(p.steps.some((s) => s.toCode === '900X00')).toBe(false);
});
