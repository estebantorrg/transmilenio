/**
 * The shared reading of TRANSMILENIO's measured speeds (spec §5.6.5).
 *
 * `shared/calibration.js` is the one module the planner graph, the live/voice
 * ETA and the server's arrivals board all read, so that a plan, a spoken answer
 * and a board can never disagree about how fast the same bus is. These cover the
 * reading itself; `planner-calibration.spec.ts` covers what the planner does
 * with it, and the ETA case is at the bottom.
 */

import { expect, test } from '@playwright/test';
import {
  clampSpeedMpm,
  dayTypeFor,
  hourFactor,
  medianPairSpeedMpm,
  pairSpeedMpm,
  prepareCalibration,
  rideSpeedMpm,
  SPEED_CAP_M_PER_MIN,
  SPEED_FLOOR_M_PER_MIN,
} from '../shared/calibration.js';
import { isFestivo } from '../shared/festivos.js';
import { computeRouteEta } from '../client/src/services/routeEta';
import { setPlannerCalibration } from '../client/src/services/calibrationStore';
import type { VoiceIndexRoute, VoiceRouteGeo, VoiceStop } from '../client/src/types/voice';
import type { PlanTime } from '../client/src/services/schedule';

const flat = (value: number) => Array.from({ length: 24 }, () => value);
const mpm = (kmh: number) => (kmh * 1000) / 60;

const DATA = {
  version: 1,
  speeds: {
    factor: { H: flat(1).map((_, h) => (h === 17 ? 0.5 : 1)), S: flat(1), F: flat(1) },
    pairs: { A: { B: 12 }, B: { C: 24 }, C: { D: 18 } },
  },
  headways: { F19: { H: flat(10), S: flat(0), F: flat(0) } },
};

test.describe('reading the calibration', () => {
  test('prepares speeds in m/min, headways per day type, and survives a broken field', () => {
    const prepared = prepareCalibration(DATA)!;
    expect(prepared.pairSpeed.get('A>B')).toBeCloseTo(mpm(12), 6);
    expect(prepared.headways.get('F19')!.H[8]).toBe(10);
    // A missing multiplier is neutral, never a division by zero.
    const sparse = prepareCalibration({ speeds: { factor: { H: [0, -1] } } })!;
    expect(hourFactor(sparse, 'H', 0)).toBe(1);
    expect(hourFactor(sparse, 'H', 1)).toBe(1);
    expect(prepareCalibration(null)).toBeNull();
    // No calibration at all still answers, with the neutral factor.
    expect(hourFactor(null, 'H', 12)).toBe(1);
  });

  test('Sunday and festivos are one day type, Saturday its own', () => {
    expect(dayTypeFor(0, false)).toBe('F');
    expect(dayTypeFor(1, true)).toBe('F');
    expect(dayTypeFor(6, false)).toBe('S');
    expect(dayTypeFor(3, false)).toBe('H');
    // The calendar the day type is asked for is the legal one, computed not tabulated.
    expect(isFestivo(2026, 8, 7)).toBe(true); //  Batalla de Boyacá
    expect(isFestivo(2026, 8, 17)).toBe(true); // Asunción, observed Monday
    expect(isFestivo(2026, 8, 18)).toBe(false);
  });

  test('speeds are held to the band', () => {
    expect(clampSpeedMpm(mpm(60))).toBe(SPEED_CAP_M_PER_MIN);
    expect(clampSpeedMpm(mpm(0.4))).toBe(SPEED_FLOOR_M_PER_MIN);
    expect(clampSpeedMpm(mpm(15))).toBeCloseTo(mpm(15), 6);
  });

  test('a ride takes the median of the stretches it rides, not the mean', () => {
    const prepared = prepareCalibration(DATA)!;
    expect(pairSpeedMpm(prepared, 'A', 'B')).toBeCloseTo(mpm(12), 6);
    expect(pairSpeedMpm(prepared, 'B', 'A')).toBeNull(); // direction matters
    // 12, 24, 18 → median 18, while the mean would be 18 too; drop one to tell them apart.
    expect(medianPairSpeedMpm(prepared, ['A', 'B', 'C', 'D'])).toBeCloseTo(mpm(18), 6);
    expect(medianPairSpeedMpm(prepared, ['A', 'B', 'C'])).toBeCloseTo(mpm(18), 6);
    expect(medianPairSpeedMpm(prepared, ['X', 'Y'])).toBeNull();
  });

  test('an unmeasured ride keeps the caller constant, still scaled by the hour', () => {
    const prepared = prepareCalibration(DATA)!;
    const fallback = 233;
    expect(rideSpeedMpm(prepared, ['X', 'Y'], 'H', 12, fallback)).toBeCloseTo(fallback, 6);
    expect(rideSpeedMpm(prepared, ['X', 'Y'], 'H', 17, fallback)).toBeCloseTo(fallback * 0.5, 6);
    // Measured, and the evening peak applies to it just the same.
    expect(rideSpeedMpm(prepared, ['A', 'B'], 'H', 12, fallback)).toBeCloseTo(mpm(12), 6);
    expect(rideSpeedMpm(prepared, ['A', 'B'], 'H', 17, fallback)).toBeCloseTo(mpm(12) * 0.5, 6);
  });
});

// ─── The live/voice ETA reads the same numbers ───────────────────────────────

const LINE: Array<[string, number, string]> = [['A', 4.60, 'Alfa'], ['B', 4.61, 'Bravo'], ['C', 4.62, 'Charlie'], ['D', 4.63, 'Delta']];
const stops: VoiceStop[] = LINE.map(([code, lat, nombre], i) => [code, nombre, -74.1, lat, i]);

const index: VoiceIndexRoute = {
  nombre: 'F19',
  tipo: 'z',
  color: '#f00',
  dirs: { '1': { origin: 'A', destination: 'D', live: [] } },
};

const geo: VoiceRouteGeo = {
  codigo: 'F19',
  dirs: { '1': { stops, trazado: LINE.map(([, lat]) => [-74.1, lat]) } },
};

/** One bus sitting at the first stop, so the ETA spans the whole line. */
const buses = [{ latitude: 4.6, longitude: -74.1 }];
const AT = (hour: number): PlanTime => ({ year: 2026, month: 7, day: 24, minute: hour * 60 });

function etaMinutes(now: PlanTime): number | null {
  const answer = computeRouteEta({ code: 'F19', index, geo, buses, userPos: null, now, stopHint: 'Delta' });
  return answer.directions[0]?.etaMinutes ?? null;
}

test.describe('live ETA', () => {
  test.afterEach(() => setPlannerCalibration(null));

  test('without a calibration it is the old constant, and with one it is the measured speed', () => {
    setPlannerCalibration(null);
    const constant = etaMinutes(AT(12));
    expect(constant).toBeGreaterThan(0);

    // The line rides A→B→C→D: medians of 12, 24, 18 km/h → 18 km/h, faster than
    // the 14 km/h constant, so the same metres take fewer minutes.
    setPlannerCalibration(DATA);
    const measured = etaMinutes(AT(12));
    expect(measured!).toBeLessThan(constant!);
    expect(measured! / constant!).toBeCloseTo(233 / mpm(18), 1);
  });

  test('the evening peak slows the same answer down', () => {
    setPlannerCalibration(DATA);
    expect(etaMinutes(AT(17))!).toBeCloseTo(etaMinutes(AT(12))! * 2, 0);
  });
});
