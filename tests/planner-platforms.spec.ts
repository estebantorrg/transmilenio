/**
 * The planner at the stations that are two on the ground (spec §5.6.3).
 *
 * The catalog files Av. Jiménez and Ricaurte as one stop each. Planned as one
 * node, a rider changed from C15 to J23 "at Avenida Jiménez" — two platforms
 * whose tunnel is closed — and crossed Ricaurte's tunnel in no time. Pure logic:
 * the graph is built from a handful of hand-made lines, stamped the way
 * `routeCatalog.platformNodes` stamps the real ones.
 */

import { expect, test } from '@playwright/test';
import { findRoutes, initRouter, type JourneyPlan } from '../client/src/services/router';
import type { RouteListItem } from '../client/src/types/transmilenio';

type Stop = NonNullable<RouteListItem['stops']>[number];

const station = (codigo: string, lng: number, lat: number): Stop => ({
  nombre: codigo,
  codigo,
  coordinate: [lng, lat],
  kind: 'station',
});

/** A merged catalog stop: the stop itself, plus the half(s) this route calls at. */
const merged = (parent: string, ...halves: Stop[]): Stop => ({
  ...halves[0],
  codigo: parent,
  platforms: halves.map((half) => ({ ...half, sourceCode: parent, kind: 'station' as const })),
});

const line = (code: string, ...stops: Stop[]): RouteListItem => ({
  id: code.toLowerCase(),
  code,
  name: code,
  origin: stops[0].nombre,
  destination: stops[stops.length - 1].nombre,
  type: 'troncal',
  stops,
});

const NARINO = station('TM0106', -74.093845, 4.586394);
const JIMENEZ_CARACAS = station('TM0013CAR', -74.08042807, 4.60287397);
const JIMENEZ_CL13 = station('TM0013C13', -74.07910861, 4.60304793);
const RICAURTE_NQS = station('TM0069NQS', -74.09386888, 4.6116862);
const RICAURTE_CL13 = station('TM0069C13', -74.09048002, 4.61301485);
const AGUAS = station('TM0121', -74.0684003997693, 4.602459798238067);
const UNIVERSIDADES = station('TM0122', -74.0671115606689, 4.6048826151965505);
const SABANA = station('TM0071', -74.0838, 4.605);
const CAD = station('TM0067', -74.083, 4.63);

const trip = (from: Stop, to: Stop): JourneyPlan[] =>
  findRoutes({
    origin: from.coordinate,
    destination: to.coordinate,
    originStopCode: from.codigo,
    destStopCode: to.codigo,
    mode: 'troncal',
    minWalk: false,
    sortBy: 'time',
    departAt: { year: 2026, month: 7, day: 24, minute: 12 * 60 },
  });

const legs = (plan: JourneyPlan): string[] =>
  plan.steps.map((step) => (step.type === 'ride' ? String(step.routeCode) : step.isTunnel ? 'túnel' : 'a pie'));

test.describe('stations the catalog merges', () => {
  test('Av. Jiménez: no change between halves that share no service', () => {
    initRouter([
      line('C15', NARINO, merged('TM0013', JIMENEZ_CARACAS)),
      line('J23', merged('TM0013', JIMENEZ_CL13), AGUAS),
    ]);
    expect(trip(NARINO, AGUAS)).toEqual([]);
  });

  test('Av. Jiménez: route 5 is the way from the Caracas half to Calle 13', () => {
    initRouter([
      line('C15', NARINO, merged('TM0013', JIMENEZ_CARACAS)),
      line('5', merged('TM0013', JIMENEZ_CARACAS, JIMENEZ_CL13), SABANA),
      line('J23', merged('TM0013', JIMENEZ_CL13), AGUAS),
    ]);
    expect(legs(trip(NARINO, AGUAS)[0])).toEqual(['C15', '5', 'J23']);
  });

  test('Ricaurte: the halves are joined by the tunnel, and crossing it is walked', () => {
    initRouter([
      line('E48', CAD, merged('TM0069', RICAURTE_NQS)),
      line('F19', merged('TM0069', RICAURTE_CL13), SABANA),
    ]);
    const [plan] = trip(CAD, SABANA);
    expect(legs(plan)).toEqual(['E48', 'túnel', 'F19']);
    expect(plan.walkDistance).toBeGreaterThan(400);
  });

  test('a trip ending at Las Aguas arrives through the tunnel from Universidades', () => {
    initRouter([line('1', CAD, UNIVERSIDADES), line('J23', SABANA, AGUAS)]);
    const [plan] = trip(CAD, AGUAS);
    expect(legs(plan)).toEqual(['1', 'túnel']);
    expect(plan.steps[plan.steps.length - 1].toCode).toBe('TM0121');
  });
});
