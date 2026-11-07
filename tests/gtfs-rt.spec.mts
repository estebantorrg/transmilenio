/**
 * The GTFS-Realtime tier (spec §5.2.8): the feed is decoded by hand, GTFS route
 * names are split into códigos, and each bus gets its código and direction from
 * the stop it last reached.
 */

import { expect, test } from '@playwright/test';
import {
  codigosOf,
  decodePositions,
  officialBusesFor,
  wallClock,
  type FeedVehicle,
  type RtIndex,
} from '../server/src/services/gtfs_rt.ts';

// ─── A minimal protobuf writer, for feeds built in the test ───

const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  return [...out, n];
};
const key = (field: number, wire: number) => varint(field * 8 + wire);
const msg = (field: number, body: number[]) => [...key(field, 2), ...varint(body.length), ...body];
const str = (field: number, s: string) => msg(field, [...Buffer.from(s, 'utf8')]);
const int = (field: number, n: number) => [...key(field, 0), ...varint(n)];
const float = (field: number, x: number) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(x);
  return [...key(field, 5), ...b];
};
const double = (field: number, x: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(x);
  return [...key(field, 1), ...b];
};

function vehicleEntity(v: { route: string; stop: string; lat: number; lon: number; id: string; label: string; ts: number }) {
  return msg(2, [
    ...str(1, `e-${v.id}`),
    ...msg(4, [
      ...msg(1, [...str(1, `trip-${v.id}`), ...str(5, v.route)]),
      ...msg(2, [...float(1, v.lat), ...float(2, v.lon), ...double(4, 1234.5)]),
      ...int(3, 15),
      ...int(5, v.ts),
      ...str(7, v.stop),
      ...msg(8, [...str(1, v.id), ...str(2, v.label), ...str(3, 'TGW242')]),
    ]),
  ]);
}

const TS = 1793923891; // 2026-11-05 19:11:31 Bogotá, the moment the feed froze

test.describe('decodePositions', () => {
  test('reads route, last stop, place, id, label and time, skipping what it does not read', () => {
    const feed = Buffer.from([
      ...msg(1, [...str(1, '2.0'), ...int(2, 0), ...int(3, 1793592164)]),
      ...vehicleEntity({ route: '12558', stop: '61773', lat: 4.5708, lon: -74.1398, id: '7001', label: 'E0001', ts: TS }),
      ...vehicleEntity({ route: '10004', stop: '49841', lat: 4.5, lon: -74.1, id: '934002', label: 'Z93-4002', ts: TS }),
    ]);
    const [a, b] = decodePositions(feed);
    expect(a).toMatchObject({ routeId: '12558', stopId: '61773', id: '7001', label: 'E0001', timestamp: TS });
    expect(a.lat).toBeCloseTo(4.5708, 4);
    expect(a.lon).toBeCloseTo(-74.1398, 4);
    expect(b).toMatchObject({ routeId: '10004', label: 'Z93-4002' });
  });

  test('drops a vehicle with no fix', () => {
    const feed = Buffer.from(vehicleEntity({ route: '1', stop: '1', lat: 0, lon: 0, id: 'x', label: 'x', ts: TS }));
    expect(decodePositions(feed)).toEqual([]);
  });

  test('a truncated feed throws instead of reading past its end', () => {
    const feed = Buffer.from(vehicleEntity({ route: '12558', stop: '61773', lat: 4.5, lon: -74.1, id: '1', label: 'E1', ts: TS }));
    expect(() => decodePositions(feed.subarray(0, feed.length - 5))).toThrow();
  });
});

test.describe('codigosOf', () => {
  test('a merged round trip stands for both códigos', () => {
    expect(codigosOf('CA153', '3')).toEqual(['CA153', 'C153', 'A153']);
    expect(codigosOf('M86-K86', '6')).toEqual(['M86-K86', 'M86', 'K86']);
    expect(codigosOf('HH710', '3')).toEqual(['HH710', 'H710', 'H710']);
  });

  test('a feeder código with a dash is one código', () => {
    expect(codigosOf('8-1', '2')).toEqual(['8-1']);
  });

  test('a troncal short name is taken as written', () => {
    expect(codigosOf('MC84', '1')).toEqual(['MC84']);
  });
});

test('wallClock writes Bogotá time the way the live host does', () => {
  expect(wallClock(TS)).toBe('07:11:31 PM');
  expect(wallClock(Date.UTC(2026, 10, 6, 5, 3, 9) / 1000)).toBe('12:03:09 AM');
});

// ─── Resolution ───────────────────────────────────────────

const stop = (codigo: string, lat: number, lng: number) => ({ nombre: codigo, codigo, coordenada: `${lat},${lng}`, posicion: 0 });
const variant = (codigo: string, nombre: string, tipoServicio: string, stops: ReturnType<typeof stop>[] = []) => ({
  id: `${codigo}-${nombre}`,
  codigo,
  nombre,
  color: '#000',
  sistema: tipoServicio === 'TRONCAL' ? 'TransMilenio' : 'TransMiZonal',
  tipoServicio,
  stops,
});

const INDEX: RtIndex = {
  routes: {
    t1: ['H13', 'P. TUNAL', '1'],
    t2: ['H13', 'Portal Norte', '1'],
    z1: ['CA153', 'A153 Centro || C153 Suba La Gaitana', '3'],
    z2: ['C25', 'Unicentro || Engativá', '3'],
    t3: ['C25', 'Portal Suba', '1'],
  },
  stops: { s1: '100A01', s2: '200A01', s3: '300A01', s9: '999A99', p1: 'K001' },
};

const bus = (routeId: string, stopId: string, id: string): FeedVehicle => ({
  routeId, stopId, id, label: id, lat: 4.6, lon: -74.1, timestamp: TS,
});

test.describe('officialBusesFor', () => {
  const A153 = variant('A153', 'Centro', 'URBANO', [stop('100A01', 4.70, -74.05), stop('101A01', 4.69, -74.05)]);
  const C153 = variant('C153', 'Suba La Gaitana', 'URBANO', [stop('200A01', 4.60, -74.10), stop('201A01', 4.60, -74.09)]);

  test('a troncal request gets its own direction, named as the catalog names it', () => {
    const variants = [variant('H13', 'P. TUNAL', 'TRONCAL'), variant('H13', 'Portal Norte', 'TRONCAL')];
    const byRoute = new Map([['t1', [bus('t1', 'p1', 'E1')]], ['t2', [bus('t2', 'p1', 'E2')]]]);
    const buses = officialBusesFor(byRoute, INDEX, 'H13', 'troncal', ['P. TUNAL'], variants);
    expect(buses).toEqual([{
      id: 'E1', label: 'E1', latitude: 4.6, longitude: -74.1, lasttime: '07:11:31 PM',
      ruta_extraida: 'H13', destino_limpio: 'P. TUNAL',
    }]);
  });

  test('a troncal request with no name gets both directions', () => {
    const variants = [variant('H13', 'P. TUNAL', 'TRONCAL'), variant('H13', 'Portal Norte', 'TRONCAL')];
    const byRoute = new Map([['t1', [bus('t1', 'p1', 'E1')]], ['t2', [bus('t2', 'p1', 'E2')]]]);
    expect(officialBusesFor(byRoute, INDEX, 'H13', 'troncal', [], variants).map((b) => b.destino_limpio)).toEqual(['P. TUNAL', 'Portal Norte']);
  });

  test('a merged round trip hands each código only the buses on its half, pointed along their leg', () => {
    const byRoute = new Map([['z1', [bus('z1', 's1', 'Z1'), bus('z1', 's2', 'Z2'), bus('z1', 's9', 'Z3')]]]);
    const a = officialBusesFor(byRoute, INDEX, 'A153', 'zonal', [], [A153]);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: 'Z1', ruta_extraida: 'A153', destino_limpio: 'Centro', angulo: 180 });
    const c = officialBusesFor(byRoute, INDEX, 'C153', 'zonal', [], [C153]);
    expect(c.map((b) => [b.id, b.destino_limpio, b.angulo])).toEqual([['Z2', 'Suba La Gaitana', 90]]);
  });

  test('a zonal answer carries every direction, whatever name was asked', () => {
    const variants = [
      variant('C25', 'Unicentro', 'URBANO', [stop('100A01', 4.70, -74.05), stop('101A01', 4.71, -74.05)]),
      variant('C25', 'Engativá', 'URBANO', [stop('200A01', 4.60, -74.10), stop('201A01', 4.59, -74.10)]),
    ];
    const byRoute = new Map([['z2', [bus('z2', 's1', 'U'), bus('z2', 's2', 'E'), bus('z2', 's9', 'X')]]]);
    const buses = officialBusesFor(byRoute, INDEX, 'C25', 'zonal', ['Engativá'], variants);
    // The bus at a stop of neither direction is still the route's: shown, with no direction claimed.
    expect(buses.map((b) => [b.id, b.destino_limpio ?? null, b.angulo ?? null])).toEqual([
      ['U', 'Unicentro', 0],
      ['E', 'Engativá', 180],
      ['X', null, null],
    ]);
  });

  test('the Ciclovía twin of a direction is the same direction', () => {
    const stops = [stop('100A01', 4.70, -74.05), stop('101A01', 4.70, -74.04)];
    const variants = [variant('C25', 'Unicentro Ciclovía', 'URBANO', stops), variant('C25', 'Unicentro', 'URBANO', stops)];
    const byRoute = new Map([['z2', [bus('z2', 's1', 'U')]]]);
    expect(officialBusesFor(byRoute, INDEX, 'C25', 'zonal', [], variants)[0].destino_limpio).toBe('Unicentro');
  });

  test('a stop both directions serve places nothing', () => {
    const shared = stop('100A01', 4.70, -74.05);
    const variants = [
      variant('C25', 'Unicentro', 'URBANO', [shared, stop('101A01', 4.71, -74.05)]),
      variant('C25', 'Engativá', 'URBANO', [stop('201A01', 4.69, -74.05), shared]),
    ];
    const byRoute = new Map([['z2', [bus('z2', 's1', 'U')]]]);
    const [only] = officialBusesFor(byRoute, INDEX, 'C25', 'zonal', [], variants);
    expect(only.destino_limpio).toBeUndefined();
    expect(only.angulo).toBeUndefined();
  });

  test('the other network under the same código is not this route', () => {
    // C25 is a zonal route and a troncal one; each rider gets their own network's buses.
    const variants = [
      variant('C25', 'Unicentro', 'URBANO', [stop('100A01', 4.7, -74.05)]),
      variant('C25', 'Portal Suba', 'TRONCAL'),
    ];
    const byRoute = new Map([['z2', [bus('z2', 's1', 'U')]], ['t3', [bus('t3', 'p1', 'T')]]]);
    expect(officialBusesFor(byRoute, INDEX, 'C25', 'zonal', [], variants).map((b) => b.id)).toEqual(['U']);
    expect(officialBusesFor(byRoute, INDEX, 'C25', 'troncal', [], variants).map((b) => [b.id, b.destino_limpio])).toEqual([['T', 'Portal Suba']]);
    expect(officialBusesFor(byRoute, INDEX, 'C25', 'troncal', [], variants.slice(0, 1))).toEqual([]);
  });
});
