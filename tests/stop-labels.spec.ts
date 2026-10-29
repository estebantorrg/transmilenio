import { test, expect } from '@playwright/test';
import { LABEL_MERGE_METERS, mergeStopLabels } from '../client/src/layers/stopLabels';

/**
 * A planned trip's labels on the map (`client/src/layers/stopLabels.ts`, drawn
 * by `journeyLayer.ts`): two ends of a transfer at one spot printed on top of
 * each other ("TrSubirarG112", reported on Reddit 29 Oct 2026). Labels that
 * would collide become one stacked label; every marker stays.
 */

type F = Parameters<typeof mergeStopLabels>[0][number];
const stop = (kind: string, label: string, lng: number, lat: number): F => ({
  type: 'Feature',
  properties: { kind, label, color: '#fff' },
  geometry: { type: 'Point', coordinates: [lng, lat] },
});
// ~0.0001° of latitude ≈ 11 m.
const near = (m: number) => (m / 11) * 0.0001;

test.describe('trip map labels', () => {
  test('two labels at one spot become one label in two lines, both markers kept', () => {
    const out = mergeStopLabels([stop('transfer', 'Bajar de B16', -74.06, 4.66), stop('board', 'Subir a G12', -74.06, 4.66 + near(30))]);
    expect(out.map((f) => f.properties.label)).toEqual(['Bajar de B16\nSubir a G12', '']);
    expect(out).toHaveLength(2);
  });

  test('labels far enough apart are left alone', () => {
    const out = mergeStopLabels([stop('board', 'Subir a B16', -74.06, 4.66), stop('alight', 'Bajar de B16', -74.06, 4.66 + near(LABEL_MERGE_METERS + 50))]);
    expect(out.map((f) => f.properties.label)).toEqual(['Subir a B16', 'Bajar de B16']);
  });

  test('the same text is not repeated, and the input is not changed', () => {
    const input = [stop('transfer', 'Transferir a G12', -74.06, 4.66), stop('board', 'Transferir a G12', -74.06, 4.66)];
    expect(mergeStopLabels(input).map((f) => f.properties.label)).toEqual(['Transferir a G12', '']);
    expect(input[1].properties.label).toBe('Transferir a G12');
  });

  test('three close labels stack on the first', () => {
    const out = mergeStopLabels([
      stop('start', 'Origen', -74.0463, 4.7546),
      stop('board', 'Subir a H75', -74.0463, 4.7546 + near(100)),
      stop('end', 'Destino', -74.2048, 4.6296),
    ]);
    expect(out.map((f) => f.properties.label)).toEqual(['Origen\nSubir a H75', '', 'Destino']);
  });
});
