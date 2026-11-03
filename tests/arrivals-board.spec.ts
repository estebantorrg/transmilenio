/**
 * The arrivals board's verdict (spec §5.8): "Sin buses en aproximación" only
 * when a route actually answered, "no disponible" (a throw, the endpoint's 503)
 * when none could be asked, and the nearest bus first.
 */

import { expect, test } from '@playwright/test';
import { boardFrom, NOT_ANSWERED, type StopArrival } from '../server/src/services/arrivals_board';

const arrival = (codigo: string, etaMinutes: number, distanceMeters: number): StopArrival => ({
  codigo,
  destino: 'Portal Sur',
  color: '#E2001A',
  type: 'troncal',
  etaMinutes,
  distanceMeters,
  busCount: 1,
});

test('no route answered: it throws, never an empty board', () => {
  expect(() => boardFrom('TM0001', [NOT_ANSWERED, NOT_ANSWERED], 2)).toThrow('none of 2 serving routes answered');
});

test('one route answered with no bus on its way: an empty board, which is a fact', () => {
  expect(boardFrom('TM0001', [NOT_ANSWERED, { arrival: null, answered: true }], 2)).toEqual({ arrivals: [], routesServing: 2 });
});

test('nearest first, a tie going to the shorter distance', () => {
  const board = boardFrom('TM0001', [
    { arrival: arrival('G47', 6, 2400), answered: true },
    NOT_ANSWERED,
    { arrival: arrival('B23', 3, 900), answered: true },
    { arrival: arrival('F23', 3, 700), answered: true },
  ], 46);
  expect(board.arrivals.map((a) => a.codigo)).toEqual(['F23', 'B23', 'G47']);
  expect(board.routesServing).toBe(46);
});
