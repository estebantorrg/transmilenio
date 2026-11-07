/**
 * Troncal speeds from the published schedule (spec §5.6.5): stretches between
 * consecutive served stops, a weekday base, an hourly profile per day type, and
 * GTFS stops filed under the catalog's own códigos.
 */
import { expect, test } from '@playwright/test';
import {
  createTroncalSpeedBuilder,
  dayTypesOf,
  stopCodeResolver,
  type ScheduledCall,
} from '../server/src/services/troncal_speeds.ts';

const call = (seq: number, code: string, hhmm: string, dist: number): ScheduledCall => {
  const [h, m] = hhmm.split(':').map(Number);
  return { seq, code, seconds: h * 3600 + m * 60, dist, lat: NaN, lon: NaN };
};

test.describe('createTroncalSpeedBuilder', () => {
  test('a stretch runs at its scheduled speed, departure to departure', () => {
    const b = createTroncalSpeedBuilder();
    // 3 km in 10 min = 18 km/h; 2 km in 4 min = 30 km/h. Given out of order on purpose.
    b.addTrip([call(2, 'TB', '10:10', 3000), call(1, 'TA', '10:00', 0), call(3, 'TC', '10:14', 5000)], ['H']);
    expect(b.build().pairs).toEqual({ TA: { TB: 18 }, TB: { TC: 30 } });
  });

  test('the base is the weekday median; other hours and days become the profile', () => {
    const b = createTroncalSpeedBuilder();
    for (const hhmm of ['08:00', '09:00', '10:00']) {
      const [h] = hhmm.split(':');
      b.addTrip([call(1, 'TA', hhmm, 0), call(2, 'TB', `${h}:10`, 3000)], ['H']); // 18 km/h
    }
    b.addTrip([call(1, 'TA', '17:00', 0), call(2, 'TB', '17:15', 3000)], ['H']); // 12 km/h at 17 h
    b.addTrip([call(1, 'TA', '23:00', 0), call(2, 'TB', '23:06', 3000)], ['S', 'F']); // 30 km/h
    const { pairs, factor } = b.build();
    expect(pairs.TA.TB).toBe(18);
    expect(factor.H[9]).toBe(1);
    expect(factor.H[17]).toBeCloseTo(12 / 18, 3);
    expect(factor.S[23]).toBeCloseTo(30 / 18, 3);
    expect(factor.F[23]).toBeCloseTo(30 / 18, 3);
    expect(factor.H[3]).toBe(0); // no troncal at 3 am: neutral once prepared
  });

  test('feed glitches are not stretches', () => {
    const b = createTroncalSpeedBuilder();
    b.addTrip([call(1, 'TA', '10:00', 0), call(2, 'TB', '10:00', 3000)], ['H']); // no time
    b.addTrip([call(1, 'TC', '10:00', 0), call(2, 'TD', '10:01', 9000)], ['H']); // 540 km/h
    b.addTrip([call(1, 'TE', '10:00', 0), call(2, 'TE', '10:05', 500)], ['H']); // same station twice
    b.addTrip([call(1, 'TF', '10:00', 0), call(2, '', '10:05', 2000)], ['H']); // stop with no código
    expect(b.build().pairs).toEqual({});
  });

  test('without shape distances it measures the straight line between the stops', () => {
    const b = createTroncalSpeedBuilder();
    b.addTrip([
      { seq: 1, code: 'TA', seconds: 36000, dist: NaN, lat: 4.60, lon: -74.1 },
      { seq: 2, code: 'TB', seconds: 36600, dist: NaN, lat: 4.63, lon: -74.1 }, // ~3.34 km in 10 min
    ], ['H']);
    expect(b.build().pairs.TA.TB).toBeCloseTo(20, 0);
  });
});

test('dayTypesOf reads calendar.txt', () => {
  const row = (days: string) => Object.fromEntries(
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d, i) => [d, days[i]])
  );
  expect(dayTypesOf(row('1111100'))).toEqual(['H']);
  expect(dayTypesOf(row('1111111'))).toEqual(['H', 'S', 'F']);
  expect(dayTypesOf(row('0000011'))).toEqual(['S', 'F']);
});

test.describe('stopCodeResolver', () => {
  const registry = {
    TM0001: { nodo: '09123', lat: 4.66303, lon: -74.06126 },
    TM0087: { nodo: '5000', lat: 4.629569, lon: -74.173221 },
  };
  const stop = (stop_id: string, extra: Record<string, string>) => ({
    stop_id, location_type: '0', parent_station: '', stop_code: '', stop_lat: '', stop_lon: '', ...extra,
  });

  test('a platform is its station, by node or else by the nearest register station', () => {
    const codes = stopCodeResolver([
      stop('9123', { location_type: '1', stop_lat: '4.66303', stop_lon: '-74.06126' }),
      stop('61001', { parent_station: '9123', stop_code: 'B001' }),
      // The feed's node for Portal Américas is not the register's: matched by place.
      stop('10500', { location_type: '1', stop_lat: '4.62960', stop_lon: '-74.17330' }),
      stop('61002', { parent_station: '10500', stop_code: 'F009' }),
      // A station nowhere near the register stays unfiled.
      stop('77777', { location_type: '1', stop_lat: '4.70000', stop_lon: '-74.00000' }),
      stop('61003', { parent_station: '77777', stop_code: 'X001' }),
    ], registry);
    expect(codes.get('61001')).toBe('TM0001');
    expect(codes.get('61002')).toBe('TM0087');
    expect(codes.has('61003')).toBe(false);
  });

  test('a station neither the node nor the distance places is its TM código, when the catalog has it', () => {
    const stops = [
      // Danubio: 360 m from its register point, past the 250 m reach.
      stop('90008', { location_type: '1', stop_lat: '4.546884', stop_lon: '-74.121011' }),
      stop('61010', { parent_station: '90008', stop_code: 'D010' }),
      // A new node the catalog has no TM código for stays unfiled.
      stop('90099', { location_type: '1', stop_lat: '4.80000', stop_lon: '-74.00000' }),
      stop('61011', { parent_station: '90099', stop_code: 'D011' }),
    ];
    const codes = stopCodeResolver(stops, { ...registry, TM90008: { nodo: '9005', lat: 4.543651, lon: -74.120897 } }, new Set(['TM90008']));
    expect(codes.get('61010')).toBe('TM90008');
    expect(codes.has('61011')).toBe(false);
  });

  test('a street stop is its cenefa, without the feed suffix', () => {
    const codes = stopCodeResolver([stop('49841', { stop_code: '080A01_TM' }), stop('49842', { stop_code: 'BD-039A' })], registry);
    expect(codes.get('49841')).toBe('080A01');
    expect(codes.get('49842')).toBe('BD-039A');
  });
});
