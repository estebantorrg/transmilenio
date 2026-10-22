import { test, expect } from '@playwright/test';

/**
 * The browser catalog's coordinates are rounded (`buildCatalogLight`,
 * `server/src/services/tm_api.ts`, spec §5.1.4). Upstream's 13–15 decimal tails
 * were most of the gzipped payload a first-time visitor downloads; this pins the
 * precision that replaced them on what the endpoint actually ships.
 */

test.describe.configure({ timeout: 120_000 });

const decimals = (n: number | string): number => (String(n).split('.')[1] ?? '').length;

test('master-catalog ships 6-decimal points and 5-decimal traces', async ({ request }) => {
  const res = await request.get('/api/troncal/master-catalog', { timeout: 90_000 });
  expect(res.ok()).toBe(true);
  const { data } = await res.json();

  const coordenadas = [
    ...Object.values<any>(data.stations).map((s) => s.coordenada),
    ...Object.values<any[]>(data.routes).flat().flatMap((v) => (v.stops ?? []).map((s: any) => s.coordenada)),
  ].filter((c): c is string => typeof c === 'string');
  expect(coordenadas.length).toBeGreaterThan(1000);
  expect(coordenadas.filter((c) => c.split(',').some((n) => decimals(n.trim()) > 6))).toEqual([]);

  const tracePoints: number[] = Object.values<any[]>(data.routes).flat().flatMap((v) => (v.trazado ?? []).flat(2));
  expect(tracePoints.length).toBeGreaterThan(1000);
  expect(tracePoints.filter((n) => decimals(n) > 5)).toEqual([]);
});
