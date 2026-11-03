/**
 * What the arrivals board says once its routes have been asked (spec §5.8).
 *
 * Its own module, free of `import.meta` and of the catalog, so the Playwright
 * runner can load it (`tests/arrivals-board.spec.ts`) — `stop_arrivals.ts`
 * reaches `tm_api.ts`, which it cannot.
 */

import type { Ocupacion } from '../../../shared/ocupacion.js';

export interface StopArrival {
  codigo: string;
  destino: string;
  color: string;
  type: 'troncal' | 'zonal';
  etaMinutes: number;
  distanceMeters: number;
  /** Buses of this route currently approaching the stop (before it, on-route). */
  busCount: number;
  /** How full the nearest of them is; absent when it sent no reading (`shared/ocupacion.js`). */
  ocupacion?: Ocupacion;
}

export interface StopArrivalsResult {
  arrivals: StopArrival[];
  /** Routes that report a stop here (by code), whether or not a bus is inbound. */
  routesServing: number;
}

/**
 * One route's answer. `answered` says whether its null arrival is a fact ("no
 * bus on its way") or a gap ("could not ask"): the board may only say the first
 * when at least one route answered (`isTrustedLiveAnswer`).
 */
export interface RouteEta {
  arrival: StopArrival | null;
  answered: boolean;
}
export const NOT_ANSWERED: RouteEta = { arrival: null, answered: false };

/**
 * The board from the asked routes' answers, nearest first. With no route
 * answered it throws instead: an empty board would assert "no buses" about buses
 * nobody could see — the free proxies are down far more often than every route
 * at a stop is empty — so the endpoint answers 503 and the board "no disponible".
 */
export function boardFrom(code: string, out: RouteEta[], routesServing: number): StopArrivalsResult {
  if (!out.some((eta) => eta.answered)) {
    throw new Error(`${code}: none of ${out.length} serving routes answered`);
  }
  const arrivals = out
    .map((eta) => eta.arrival)
    .filter((a): a is StopArrival => a !== null)
    .sort((a, b) => a.etaMinutes - b.etaMinutes || a.distanceMeters - b.distanceMeters);
  return { arrivals, routesServing };
}
