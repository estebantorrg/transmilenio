import { test, expect } from '@playwright/test';
import { cadaPorPeriodo, createGtfsZonalBuilder, destinoDe, type CatalogVariant, type GtfsTrip } from '../server/src/services/gtfs_zonal.ts';
import { gateProblems } from '../server/src/sync_gtfs.ts';

/**
 * The zonal schedules built from TRANSMILENIO's GTFS (`server/src/services/gtfs_zonal.ts`,
 * spec §5.5.10). The feed and the catalog cut the network differently — a GTFS
 * trip is a whole round trip, a código can hold both directions — and every
 * case below is one of those cuts, on a feed small enough to read.
 */

// A1 runs a→e and C1 e→a: one GTFS route, CA1, whose trips go out and back.
// Z9 is one código with both directions under it, like 731.
const variants: CatalogVariant[] = [
  { codigo: 'A1', nombre: 'Norte', stops: ['a', 'b', 'c', 'd', 'e'] },
  { codigo: 'A1', nombre: 'Norte Ciclovía', stops: ['a', 'b', 'x', 'd', 'e'] },
  { codigo: 'C1', nombre: 'Sur', stops: ['e', 'd', 'c', 'b', 'a'] },
  { codigo: 'Z9', nombre: 'Ida', stops: ['p', 'q', 'r', 's', 't'] },
  { codigo: 'Z9', nombre: 'Vuelta', stops: ['t', 's', 'r', 'q', 'p'] },
  // Shares C1's street, a→e; must not take CA1's trips.
  { codigo: 'K5', nombre: 'Otro', stops: ['a', 'b', 'c', 'd', 'e', 'f'] },
];
const routes = [
  { route_id: 'r1', route_short_name: 'CA1', route_long_name: 'A1 Norte || C1 Sur' },
  { route_id: 'r2', route_short_name: 'Z9', route_long_name: 'Ida || Vuelta' },
];

/** A trip's stops at a minute each, from `start`. */
function trip(id: string, route: string, service: string, start: number, stops: string[]) {
  return { trip: { trip_id: id, route_id: route, service_id: service } as GtfsTrip, start, stops };
}
const fixtures = [
  // Weekdays: out and back, every 10 minutes from 05:00, the last one at 05:30.
  ...[0, 10, 20, 30].map((m, i) => trip(`w${i}`, 'r1', '1', 300 + m, ['a', 'b', 'c', 'd', 'e', 'd', 'c', 'b', 'a'])),
  // A stop the catalog does not list (`zz`) is passed over, not a break.
  trip('w4', 'r1', '1', 400, ['a', 'b', 'zz', 'c', 'd', 'e']),
  // A bus entering service from the depot at 23:50, mid-route.
  trip('w5', 'r1', '1', 1430, ['b', 'c', 'd', 'e']),
  // Sunday and festivos are service 4; Saturday is 2.
  trip('d0', 'r1', '4', 360, ['a', 'b', 'c', 'd', 'e']),
  trip('s0', 'r1', '2', 330, ['a', 'b', 'c', 'd', 'e']),
  // Z9: one round trip, both directions under one código.
  trip('z0', 'r2', '1', 600, ['p', 'q', 'r', 's', 't', 's', 'r', 'q', 'p']),
];

function build() {
  const builder = createGtfsZonalBuilder(fixtures.map((f) => f.trip), (id) => id);
  // Rows in no order, as the feed has them.
  const rows = fixtures.flatMap((f) => f.stops.map((stop, i) => [f.trip.trip_id, stop, i + 1, f.start + i] as const));
  for (const row of rows.reverse()) builder.add(...row);
  return builder.build(routes, variants).rutas;
}

test.describe('zonal schedules from the GTFS', () => {
  test('a round trip is cut into its two directions, each a código', () => {
    const rutas = build();
    expect(rutas.A1.map((s) => s.destino)).toEqual(['Norte']);
    expect(rutas.C1.map((s) => s.destino)).toEqual(['Sur']);
    // Out leg leaves at the trip's start; the way back leaves from the turnaround, 4 minutes on.
    expect(rutas.A1[0].dias.LV).toMatchObject({ salidas: 5, primera: 300, ultima: 400 });
    expect(rutas.C1[0].dias.LV).toMatchObject({ salidas: 4, primera: 304, ultima: 334 });
  });

  test('one código can hold both directions, kept apart by destination', () => {
    const z9 = build().Z9;
    expect(z9.map((s) => s.destino).sort()).toEqual(['Ida', 'Vuelta']);
    expect(z9.find((s) => s.destino === 'Vuelta')!.dias.LV).toMatchObject({ salidas: 1, primera: 604 });
  });

  test('a código sharing the street does not take the trips', () => {
    expect(build().K5).toBeUndefined();
  });

  test('each paradero gets its first and last pass, in the catalog order', () => {
    const norte = build().A1[0];
    expect(norte.paradas).toEqual(['a', 'b', 'c', 'd', 'e']);
    // c is 2 minutes in on the 05:00 bus; the depot bus is its last, at 23:51.
    expect(norte.dias.LV!.pasos[2]).toEqual([302, 1431]);
  });

  test('a bus entering mid-route is a pass, not a departure', () => {
    // Departures are counted at `a`, which most buses start from: the 23:50
    // depot bus never passes it, so the last departure is still 06:40.
    expect(build().A1[0].dias.LV).toMatchObject({ desde: 0, salidas: 5, ultima: 400 });
  });

  test('Sunday-and-festivo and Saturday are their own day types', () => {
    const norte = build().A1[0];
    expect(norte.dias.DF).toMatchObject({ salidas: 1, primera: 360 });
    expect(norte.dias.S).toMatchObject({ salidas: 1, primera: 330 });
  });

  test('how often: the departures in each period and the middle of their gaps', () => {
    const cada = cadaPorPeriodo([300, 310, 320, 330, 400, 1000]);
    // Before 06:00, four departures 10 minutes apart; the first has no gap of its own.
    expect(cada[0]).toEqual([4, 10, 10]);
    // 06:40 belongs to 6–9, with the 70-minute gap that ends there.
    expect(cada[1]).toEqual([1, 70, 70]);
    expect(cada[2]).toBeNull();
    // A lone departure has no gap to tell.
    expect(cadaPorPeriodo([700])[2]).toEqual([1, null, null]);
  });

  test('the Ciclovía detour is the same direction', () => {
    expect(destinoDe('Norte Ciclovía')).toBe('Norte');
    expect(destinoDe('Centro Ciclovia')).toBe('Centro');
  });

  test('a bad harvest is refused, not written', () => {
    const rutas = build();
    expect(gateProblems(rutas, ['A1', 'C1', 'Z9'])).toEqual([]);
    // Too few of the catalog's códigos.
    expect(gateProblems(rutas, ['A1', 'C1', 'Z9', 'Q1', 'Q2', 'Q3'])[0]).toMatch(/only 3 of 6/);
    // A time no bus keeps.
    const broken = structuredClone(rutas);
    broken.A1[0].dias.LV!.primera = 30;
    expect(gateProblems(broken, ['A1', 'C1', 'Z9'])).toEqual(['A1 LV: a time outside 02:00–27:59']);
  });
});
