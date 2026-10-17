/**
 * Stop aliases (`stopAliases` in `recorrido_corrections.json`): a stop upstream
 * files under a made-up code that is really a station. Since 2026-10-15 B72's
 * recorrido opens at "Portal Usme T3A" instead of TM0118, which made a stand-in
 * station and took B72 off Portal Usme. These read the real file's entry, so
 * deleting it (once upstream fixes the code) means deleting these too.
 */

import { test, expect } from '@playwright/test';
import { applyStopAliases, correctRecorrido } from '../server/src/services/recorrido_corrections.ts';

test('an aliased stop is filed under its station, and keeps its own vagón and place', () => {
  const stops = correctRecorrido('B72', [
    { codigo: 'Portal Usme T3A', vagon: 'T3A', coordenada: '4.53172,-74.11936' },
    { codigo: 'TM0115', vagon: '' },
  ]);
  expect(stops).toEqual([
    { codigo: 'TM0118', vagon: 'T3A', coordenada: '4.53172,-74.11936' },
    { codigo: 'TM0115', vagon: '' },
  ]);
});

test('a catalog on disk folds the stand-in station into the real one', () => {
  const catalog: any = {
    stations: {
      TM0118: { wagons: { T3: [{ id: '9', codigo: 'H72' }] } },
      'Portal Usme T3A': { wagons: { T3A: [{ id: '338', codigo: 'B72' }] } },
    },
    routes: { B72: [{ stops: [{ codigo: 'Portal Usme T3A' }, { codigo: 'TM0115' }] }] },
  };
  expect(applyStopAliases(catalog)).toBe(2); // one stop re-coded, one mapping moved
  expect(Object.keys(catalog.stations)).toEqual(['TM0118']);
  expect(catalog.stations.TM0118.wagons).toEqual({
    T3: [{ id: '9', codigo: 'H72' }],
    T3A: [{ id: '338', codigo: 'B72' }],
  });
  expect(catalog.routes.B72[0].stops.map((s: any) => s.codigo)).toEqual(['TM0118', 'TM0115']);
  // Twice is once: nothing left to fold.
  expect(applyStopAliases(catalog)).toBe(0);
});
