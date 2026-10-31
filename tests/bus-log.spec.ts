/**
 * The bus log (spec §5.2.7): one row per móvil per route per interval, and a
 * batch D1 refuses is kept for the next flush rather than lost.
 */

import { expect, test } from '@playwright/test';
import {
  flushSightings,
  logSightings,
  MAX_REPORTED_BUSES,
  pickReportedBuses,
  pickSightings as pickFrom,
  SIGHTING_INTERVAL_MS,
} from '../server/src/services/bus_log';
import { SIGHTING_REPORT_MS, sightingReport } from '../client/src/services/sightingReport';

const pickSightings = (ruta: string, buses: any[], now: number, seen: Map<string, number>) =>
  pickFrom(ruta, buses, now, seen, 'server');

const NOW = Date.UTC(2026, 9, 30, 12);
const U1535 = {
  id: 'U1535',
  label: 'U1535',
  latitude: 4.65,
  longitude: -74.06,
  ruta_extraida: '1',
  destino_limpio: 'Universidades',
  lasttime: '07:00:00 AM',
  posicion: 1339,
};

test.describe('pickSightings', () => {
  test('keeps the móvil, route, place and both times', () => {
    expect(pickSightings('1', [U1535], NOW, new Map())).toEqual([{
      movil: 'U1535',
      ruta: '1',
      destino: 'Universidades',
      lat: 4.65,
      lng: -74.06,
      posicion: 1339,
      lasttime: '07:00:00 AM',
      seen_at: '2026-10-30T12:00:00.000Z',
      origen: 'server',
    }]);
  });

  test('the same bus on the same route waits out the interval', () => {
    const seen = new Map<string, number>();
    expect(pickSightings('1', [U1535], NOW, seen)).toHaveLength(1);
    expect(pickSightings('1', [U1535], NOW + 15_000, seen)).toHaveLength(0);
    expect(pickSightings('1', [U1535], NOW + SIGHTING_INTERVAL_MS, seen)).toHaveLength(1);
  });

  test('the same bus on another route is a new sighting', () => {
    const seen = new Map<string, number>();
    pickSightings('1', [U1535], NOW, seen);
    expect(pickSightings('B72', [{ ...U1535, ruta_extraida: 'B72' }], NOW + 1000, seen)).toHaveLength(1);
  });

  test('a bus with no móvil or no fix is not a sighting, and junk does not throw', () => {
    const buses = [{ ...U1535, label: '', id: '' }, { ...U1535, latitude: 0, longitude: 0 }, null, 'x'];
    expect(pickSightings('1', buses, NOW, new Map())).toEqual([]);
  });

  test('falls back to the requested route when the feed names none', () => {
    const [row] = pickSightings('1', [{ ...U1535, ruta_extraida: undefined }], NOW, new Map());
    expect(row.ruta).toBe('1');
  });
});

test.describe('pickReportedBuses: a public endpoint', () => {
  test('keeps a real bus, under the route the endpoint checked', () => {
    const [bus] = pickReportedBuses('1', [{ ...U1535, ruta_extraida: 'FORGED' }]);
    expect(bus.label).toBe('U1535');
    expect(bus.ruta_extraida).toBe('1');
  });

  test('drops what cannot be a bus here', () => {
    expect(pickReportedBuses('1', [
      { ...U1535, label: '<script>' },
      { ...U1535, label: undefined },
      { ...U1535, latitude: 40.7, longitude: -74.0 },
      { ...U1535, latitude: 0, longitude: 0 },
      null,
      'x',
    ])).toEqual([]);
  });

  test('a body that is not a list is nothing, and a long one is cut', () => {
    expect(pickReportedBuses('1', 'nope')).toEqual([]);
    expect(pickReportedBuses('1', undefined)).toEqual([]);
    expect(pickReportedBuses('1', Array(MAX_REPORTED_BUSES + 5).fill(U1535))).toHaveLength(MAX_REPORTED_BUSES);
  });
});

test.describe('sightingReport: what the app sends', () => {
  test('sends only the fields the log keeps', () => {
    const body = JSON.parse(sightingReport('1', [{ ...U1535, angulo: 90, uuid: 'x' }], NOW, new Map())!);
    expect(body).toEqual({
      ruta: '1',
      buses: [{
        label: 'U1535',
        latitude: 4.65,
        longitude: -74.06,
        destino_limpio: 'Universidades',
        posicion: 1339,
        lasttime: '07:00:00 AM',
      }],
    });
  });

  test('reports a route once per interval, and a report the server can read', () => {
    const last = new Map<string, number>();
    const body = sightingReport('1', [U1535], NOW, last);
    expect(pickReportedBuses('1', JSON.parse(body!).buses)).toHaveLength(1);
    expect(sightingReport('1', [U1535], NOW + 15_000, last)).toBeNull();
    expect(sightingReport('B72', [U1535], NOW + 15_000, last)).not.toBeNull();
    expect(sightingReport('1', [U1535], NOW + SIGHTING_REPORT_MS, last)).not.toBeNull();
  });

  test('an empty or junk answer sends nothing and does not use up the interval', () => {
    const last = new Map<string, number>();
    expect(sightingReport('1', [], NOW, last)).toBeNull();
    expect(sightingReport('1', [null, 'x'], NOW, last)).toBeNull();
    expect(sightingReport('1', [U1535], NOW, last)).not.toBeNull();
  });
});

test.describe('flushSightings', () => {
  const realFetch = globalThis.fetch;
  let bodies: { sql: string; params: string[] }[] = [];
  let answer: () => Response;

  test.beforeEach(() => {
    bodies = [];
    answer = () => new Response(JSON.stringify({ success: true }));
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return answer();
    }) as typeof fetch;
    process.env.BUS_LOG_D1_URL = 'https://d1.test/query';
    process.env.BUS_LOG_D1_TOKEN = 'token';
  });

  test.afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BUS_LOG_D1_URL;
    delete process.env.BUS_LOG_D1_TOKEN;
  });

  const inserted = () => bodies.filter((b) => b.sql.startsWith('INSERT')).flatMap((b) => JSON.parse(b.params[0]));

  test('logs nothing when it is not configured', async () => {
    delete process.env.BUS_LOG_D1_URL;
    logSightings('1', [{ ...U1535, label: 'OFF1' }], 'server');
    process.env.BUS_LOG_D1_URL = 'https://d1.test/query';
    await flushSightings();
    expect(bodies).toEqual([]);
  });

  test('sends what is queued, and a refused batch again on the next flush', async () => {
    logSightings('1', [{ ...U1535, label: 'K1615' }], 'client');
    answer = () => new Response(JSON.stringify({ success: false }), { status: 500 });
    await flushSightings();
    expect(inserted()).toEqual([]);

    bodies = [];
    answer = () => new Response(JSON.stringify({ success: true }));
    await flushSightings();
    expect(inserted().map((row) => [row.movil, row.origen])).toEqual([['K1615', 'client']]);

    bodies = [];
    await flushSightings();
    expect(bodies).toEqual([]);
  });
});
