/**
 * The Salidas relay (`scripts/salidas-relay/worker`, spec §5.8): a Cloudflare
 * Worker the station-demand workflow downloads through, because TRANSMILENIO's
 * open-data host refuses GitHub's runners. It relays one file shape and nothing
 * else, so it can never be pointed at another URL. Upstream is faked.
 */

import { test, expect } from '@playwright/test';
import relay from '../scripts/salidas-relay/worker/src/index.mjs';

const asked: string[] = [];
const realFetch = globalThis.fetch;

test.beforeEach(() => {
  asked.length = 0;
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return new Response('PK\u0003\u0004', { status: 200, headers: { 'content-type': 'application/zip' } });
  }) as typeof fetch;
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (path: string, method = 'GET') => relay.fetch(new Request(`https://relay.example${path}`, { method }));

test('a day file is fetched from the open-data host and passed through', async () => {
  const res = await call('/Salidas/salidas20261016.zip');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/zip');
  expect(asked).toEqual(['https://validaciones.datosabiertos.transmilenio.gov.co/Salidas/salidas20261016.zip']);
});

test('anything else is refused without asking upstream', async () => {
  for (const [path, method] of [
    ['/Salidas/salidas20261016.zip', 'POST'],
    ['/Salidas/../index.html', 'GET'],
    ['/Salidas/salidas2026101.zip', 'GET'],
    ['/Salidas/salidas20261016.zip.exe', 'GET'],
    ['/https://example.com/x.zip', 'GET'],
    ['/', 'GET'],
  ]) {
    expect((await call(path, method)).status, `${method} ${path}`).toBe(404);
  }
  expect(asked).toEqual([]);
});
