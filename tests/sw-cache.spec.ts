/**
 * What the service worker keeps (`client/public/sw.js`): build assets and pages
 * each have a ceiling, so a rider who opens the site daily does not keep every
 * bundle, route page and shared `/viaje?…` link they ever loaded. Run under node
 * with stand-ins for the Cache API, not in a browser.
 */

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ORIGIN = 'https://mitrasto.app';

function loadWorker() {
  const entries = new Map<string, { req: any; res: any }>();
  const cache = {
    match: async (req: any) => entries.get(req.url)?.res,
    put: async (req: any, res: any) => {
      entries.delete(req.url); // a re-put goes to the end, as in the Cache API
      entries.set(req.url, { req, res });
    },
    keys: async () => [...entries.values()].map((entry) => entry.req),
    delete: async (req: any) => entries.delete(req.url),
  };
  const handlers: Record<string, (event: any) => void> = {};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', 'client/public/sw.js'), 'utf8'), {
    self: { location: { origin: ORIGIN }, addEventListener: (type: string, fn: any) => { handlers[type] = fn; } },
    caches: { open: async () => cache },
    fetch: async () => ({ ok: true, clone() { return this; } }),
    URL,
  });

  const get = async (url: string, mode = 'no-cors') => {
    let answered: Promise<unknown> = Promise.resolve();
    handlers.fetch({ request: { url, method: 'GET', mode }, respondWith: (p: Promise<unknown>) => { answered = p; } });
    await answered;
    await new Promise((resolve) => setTimeout(resolve, 0)); // the trim after the put
  };
  return { entries, open: (page: string) => get(ORIGIN + page, 'navigate'), get };
}

test('pages: the 30 most recent stay, the older ones go', async () => {
  const sw = loadWorker();
  for (let i = 0; i < 35; i++) await sw.open(`/ruta/r${i}/`);
  const pages = [...sw.entries.keys()];
  expect(pages).toHaveLength(30);
  expect(pages[0]).toBe(`${ORIGIN}/ruta/r5/`);
  expect(pages[29]).toBe(`${ORIGIN}/ruta/r34/`);
});

test('a page opened again counts as recent', async () => {
  const sw = loadWorker();
  for (let i = 0; i < 30; i++) await sw.open(`/viaje?o=${i}`);
  await sw.open('/viaje?o=0');
  await sw.open('/novedades');
  expect(sw.entries.has(`${ORIGIN}/viaje?o=0`)).toBe(true);
  expect(sw.entries.has(`${ORIGIN}/viaje?o=1`)).toBe(false);
});

test('the page ceiling leaves assets, models and the catalog alone', async () => {
  const sw = loadWorker();
  await sw.get(`${ORIGIN}/assets/index-abc.js`);
  await sw.get(`${ORIGIN}/models/bus.glb`);
  await sw.get(`${ORIGIN}/api/troncal/master-catalog`);
  for (let i = 0; i < 35; i++) await sw.open(`/estacion/e${i}/`);
  for (const kept of ['/assets/index-abc.js', '/models/bus.glb', '/api/troncal/master-catalog']) {
    expect(sw.entries.has(ORIGIN + kept), kept).toBe(true);
  }
});
