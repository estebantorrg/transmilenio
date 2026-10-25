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

test('an estación never ships its own name as its address', async ({ request }) => {
  // Upstream files the newest estaciones that way (Laureles, Islandia, Danubio,
  // Calle 53 – UMB), and every surface printed it as an address: "X queda en X".
  const res = await request.get('/api/troncal/master-catalog', { timeout: 90_000 });
  const { data } = await res.json();
  const echoes = Object.values<any>(data.stations).filter((s) => s.estacion && s.direccion === s.nombre);
  expect(echoes.map((s) => s.codigo)).toEqual([]);
});

test('master-catalog names its own content, in the body and in the ETag', async ({ request }) => {
  // The app has no ETag to read — it ships this body in the APK — so the hash
  // travels in the body too, and is how it tells a new catalog from its cached
  // one (`catalogSignature`). Counts could not: moving K43 off CAD changes none.
  const res = await request.get('/api/troncal/master-catalog', { timeout: 90_000 });
  expect(res.ok()).toBe(true);
  const { version } = await res.json();
  expect(version).toMatch(/^[0-9a-f]{16}$/);
  expect(res.headers()['etag']).toBe(`W/"catalog-${version}"`);
});

test('a client that refuses gzip gets the same bodies, inflated', async ({ request }) => {
  // Every precomputed body (`sendGzipJson`): it is inflated as a stream now,
  // where `gunzipSync` held the whole catalog per request on a 512 MB box.
  for (const url of ['/api/troncal/master-catalog', '/api/planner-calibration']) {
    const res = await request.get(url, { headers: { 'Accept-Encoding': 'identity' }, timeout: 90_000 });
    expect(res.ok(), url).toBe(true);
    expect(res.headers()['content-encoding'], url).toBeUndefined();
    expect((await res.json()).success, url).toBe(true);
  }
});
