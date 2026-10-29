import { test, expect } from '@playwright/test';
import { handle, resetMemo } from '../scripts/catalog-cdn/src/index.mjs';

/**
 * The edge cache for the route catalog (`scripts/catalog-cdn`, spec §5.1.4):
 * Render serves the catalog once per version, Cloudflare serves the visits.
 * The bytes pass through untouched as gzip, a new version replaces the old one,
 * and anything that goes wrong answers 503 so the site uses its own API.
 */

const GZ = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
const T0 = Date.UTC(2026, 9, 29, 12, 0);

/** A KV namespace, and an origin that answers with `etag` until told otherwise. */
function world() {
  const kv = new Map<string, unknown>();
  let etag: string | null = 'W/"catalog-a"';
  let down = false;
  const asked: Array<string | null> = [];
  const env = {
    CATALOG: {
      get: async (key: string, type?: string) => {
        const value = kv.get(key);
        if (value === undefined) return null;
        return type === 'stream' ? new Response(value as Uint8Array).body : value;
      },
      put: async (key: string, value: unknown) => {
        kv.set(key, value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : value);
      },
      delete: async (key: string) => void kv.delete(key),
    },
  };
  const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
    const ifNoneMatch = init.headers['If-None-Match'] ?? null;
    asked.push(ifNoneMatch);
    if (down) throw new Error('connection refused');
    if (!etag) return new Response('Not found', { status: 404 });
    if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(GZ, { status: 200, headers: { etag, 'content-type': 'application/gzip' } });
  };
  const get = (now: number, headers: Record<string, string> = {}, path = '/master-catalog') =>
    handle(new Request(`https://cdn.test${path}`, { headers }), env, now, fetchImpl);
  return {
    kv, asked, get,
    newVersion: (next: string) => { etag = next; },
    goDown: () => { down = true; },
    remove: () => { etag = null; },
  };
}

test.beforeEach(() => resetMemo());

test.describe('catalog edge cache', () => {
  test('serves the origin bytes untouched, as gzip JSON anyone may fetch', async () => {
    const w = world();
    const res = await w.get(T0);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('etag')).toBe('W/"catalog-a"');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...GZ]);
  });

  test('asks the origin at most once a minute, and then only whether it changed', async () => {
    const w = world();
    await w.get(T0);
    await w.get(T0 + 30_000);
    expect(w.asked).toEqual([null]);
    await w.get(T0 + 61_000);
    expect(w.asked).toEqual([null, 'W/"catalog-a"']);
  });

  test('a new version replaces the old one, which is deleted', async () => {
    const w = world();
    await w.get(T0);
    w.newVersion('W/"catalog-b"');
    const res = await w.get(T0 + 61_000);
    expect(res.headers.get('etag')).toBe('W/"catalog-b"');
    expect([...w.kv.keys()].sort()).toEqual(['body:W/"catalog-b"', 'etag']);
  });

  test('a browser that already has this version gets a 304', async () => {
    const w = world();
    await w.get(T0);
    const res = await w.get(T0 + 1_000, { 'If-None-Match': 'W/"catalog-a"' });
    expect(res.status).toBe(304);
  });

  test('an unreachable origin keeps the copy already stored', async () => {
    const w = world();
    await w.get(T0);
    w.goDown();
    const res = await w.get(T0 + 61_000);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('W/"catalog-a"');
  });

  test('with nothing stored and no origin, it answers 503 so the site uses its own API', async () => {
    const w = world();
    w.remove();
    expect((await w.get(T0)).status).toBe(503);
  });

  test('only the catalog path, only GET', async () => {
    const w = world();
    expect((await w.get(T0, {}, '/other')).status).toBe(404);
    expect(w.asked).toEqual([]);
  });
});
