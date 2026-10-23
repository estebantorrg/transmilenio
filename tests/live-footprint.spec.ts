/**
 * The cuts to upstream request volume (spec §5.2.3, §5.2.5). Measured on
 * 2026-09-21: the live host refreshes a route's positions about every 47 s, a
 * troncal poll was firing up to 12 name candidates, each of those raced 5
 * proxies, and the pool re-probed its whole candidate list every 10 minutes
 * whether or not it needed proxies — far more load than the riders using it.
 *
 *   1. the name that matched is remembered, so poll 2 asks once, not 12 times
 *   2. a proxy that has been answering gets the request alone, no wave
 *   3. verification stops at target, and a re-scrape only runs when the pool
 *      is short, someone is using it and the live host is open — the 90-second
 *      top-up that ignored the last two is gone (2026-10-13)
 *
 * A fourth idea — gating verification on the proxy's exit country from
 * Cloudflare's trace endpoint — was measured, found to discard the only
 * proxies that worked, and reverted; see `MAX_TEST_CANDIDATES`.
 */

import { expect, test } from '@playwright/test';
import {
  canRefreshPool,
  isProvenProxy,
  POOL_IDLE_MS,
  PROVEN_PROXY_MAX_AGE_MS,
  REFRESH_COOLDOWN_MS,
  shouldRefreshPool,
} from '../server/src/services/proxy_health';
import { forgetLiveName, recallLiveName, rememberLiveName } from '../shared/live_name_memo.js';
import { raceProxies, type ProxyPool } from '../server/src/services/proxy_race';
import { ProxyManager } from '../server/src/services/proxy_manager';

const MINUTE = 60_000;

test.describe('pool re-scrape (cut 3)', () => {
  // Bogotá is UTC−5, so a Bogotá clock time is that many hours later in UTC.
  const bogota = (hour: number, minute = 0) => Date.UTC(2026, 9, 13, hour + 5, minute);
  const noon = bogota(12);

  test('only runs when the pool is short of target', () => {
    // The unconditional 10-minute tick re-probed a healthy pool — one
    // live-host request per candidate — for nothing.
    expect(shouldRefreshPool(0, 12, noon, noon)).toBe(true);
    expect(shouldRefreshPool(11, 12, noon, noon)).toBe(true);
    expect(shouldRefreshPool(12, 12, noon, noon)).toBe(false);
    expect(shouldRefreshPool(30, 12, noon, noon)).toBe(false);
  });

  test('and only while someone is being served from it', () => {
    // A free pool usually sits BELOW target, so "short" alone kept a pass in
    // flight around the clock on an instance nobody was tracking a bus from.
    expect(shouldRefreshPool(4, 12, noon - POOL_IDLE_MS + MINUTE, noon)).toBe(true);
    expect(shouldRefreshPool(4, 12, noon - POOL_IDLE_MS, noon)).toBe(false);
    expect(shouldRefreshPool(0, 12, 0, noon)).toBe(false); // never asked for a proxy
  });

  test('a pass never starts while the live host is shut', () => {
    // 23:00–05:00 it answers 400 to everyone: no proxy can pass, so a pass can
    // only spend its 500 requests.
    expect(canRefreshPool(0, noon)).toBe(true);
    expect(canRefreshPool(0, bogota(5))).toBe(true);
    expect(canRefreshPool(0, bogota(22, 59))).toBe(true);
    expect(canRefreshPool(0, bogota(4, 59))).toBe(false);
    expect(canRefreshPool(0, bogota(23))).toBe(false);
    expect(canRefreshPool(0, bogota(2))).toBe(false);
  });

  test('nor right behind the one that just ended', () => {
    // With the pool empty every live request asks for a pass.
    expect(canRefreshPool(noon - REFRESH_COOLDOWN_MS + 1, noon)).toBe(false);
    expect(canRefreshPool(noon - REFRESH_COOLDOWN_MS, noon)).toBe(true);
  });
});

test.describe('proven proxy (cut 2)', () => {
  const now = Date.now();

  test('a recent, mostly-successful proxy may carry a lone request', () => {
    expect(isProvenProxy({ success: 3, failure: 0, lastOkAt: now - MINUTE }, now)).toBe(true);
    expect(isProvenProxy({ success: 8, failure: 2, lastOkAt: now - MINUTE }, now)).toBe(true);
  });

  test('stale, unproven or failing proxies fall back to the wave', () => {
    expect(isProvenProxy({ success: 5, failure: 0, lastOkAt: now - PROVEN_PROXY_MAX_AGE_MS - 1 }, now)).toBe(false);
    expect(isProvenProxy({ success: 0, failure: 0, lastOkAt: now }, now)).toBe(false);
    expect(isProvenProxy({ success: 1, failure: 4, lastOkAt: now - MINUTE }, now)).toBe(false);
  });
});

test.describe('remembered destination name (cut 1)', () => {
  // One memo (`shared/live_name_memo.js`) for the server cascade, which keys it
  // `<type>:<código>`, and the app's native lookup, which keys it by código.
  test('the matching name comes back, and only until it goes stale', () => {
    forgetLiveName('troncal:H15');
    expect(recallLiveName('troncal:H15')).toBeNull();

    rememberLiveName('troncal:H15', 'Portal Tunal');
    expect(recallLiveName('troncal:h15')).toEqual({ name: 'Portal Tunal', fresh: true });
    // Stale keeps the name but stops trusting an empty answer from it, which is
    // what sends the next poll back through the full candidate set.
    expect(recallLiveName('troncal:H15', Date.now() + 11 * MINUTE)).toEqual({ name: 'Portal Tunal', fresh: false });

    forgetLiveName('troncal:H15');
    expect(recallLiveName('troncal:H15')).toBeNull();
  });

  test('troncal and zonal are separate, and an empty name is ignored', () => {
    rememberLiveName('troncal:A', 'Name A');
    rememberLiveName('zonal:A', 'Name Z');
    expect(recallLiveName('troncal:A')?.name).toBe('Name A');
    expect(recallLiveName('zonal:A')?.name).toBe('Name Z');

    rememberLiveName('troncal:A', '');
    expect(recallLiveName('troncal:A')?.name).toBe('Name A');
    forgetLiveName('troncal:A');
    forgetLiveName('zonal:A');
  });

  test('the memo is bounded — a TTL alone never frees an unread entry', () => {
    // 400 is the cap; the oldest insert must be the one that goes.
    rememberLiveName('troncal:FIRST', 'oldest');
    for (let i = 0; i < 400; i++) rememberLiveName(`troncal:FILL${i}`, `name${i}`);
    expect(recallLiveName('troncal:FIRST')).toBeNull();
    expect(recallLiveName('troncal:FILL399')?.name).toBe('name399');
    for (let i = 0; i < 400; i++) forgetLiveName(`troncal:FILL${i}`);
  });

  test('the app keys it by the código alone', () => {
    forgetLiveName('B12');
    rememberLiveName('b12', 'Portal Norte');
    expect(recallLiveName('B12')).toEqual({ name: 'Portal Norte', fresh: true });
    expect(recallLiveName('troncal:B12')).toBeNull();
    forgetLiveName('B12');
  });
});

test.describe('one request through the pool (cut 2, every caller)', () => {
  // Live buses, arrivals, the card read and the tullave sync share this race
  // (`proxy_race.ts`); each used to carry its own, and only one of the four
  // tried the proven proxy alone or went past a first dead wave.
  const proxy = (n: number) => ({ ip: `190.0.0.${n}`, port: 8080 });
  const pool = (proven: number | null, ranked: number[]) => {
    const log = { ok: [] as string[], failed: [] as string[] };
    const fake: ProxyPool = {
      waitForReady: async () => ranked.length,
      getProvenProxy: () => (proven === null ? null : proxy(proven)),
      getProxies: (n, exclude) =>
        ranked.map(proxy).filter((p) => !exclude?.has(`${p.ip}:${p.port}`)).slice(0, n),
      reportSuccess: (ip) => { log.ok.push(ip); },
      reportFailure: (ip) => { log.failed.push(ip); },
    };
    return { fake, log };
  };

  test('a proxy that has been answering carries the request alone', async () => {
    const { fake, log } = pool(3, [1, 2, 3, 4, 5, 6]);
    const asked: string[] = [];
    const answer = await raceProxies(fake, async (p) => { asked.push(p.ip); return 'buses'; }, 'test');
    expect(answer).toBe('buses');
    expect(asked).toEqual(['190.0.0.3']);
    expect(log.ok).toEqual(['190.0.0.3']);
  });

  test('when it fails, the next wave races the ones not tried yet', async () => {
    const { fake, log } = pool(3, [1, 2, 3, 4, 5, 6]);
    const asked: string[] = [];
    const answer = await raceProxies(fake, async (p) => {
      asked.push(p.ip);
      if (p.ip !== '190.0.0.5') throw new Error('reset');
      return 'buses';
    }, 'test');
    expect(answer).toBe('buses');
    // Alone first, then the five best of the rest — never the same proxy twice.
    expect(asked).toEqual(['190.0.0.3', '190.0.0.1', '190.0.0.2', '190.0.0.4', '190.0.0.5', '190.0.0.6']);
    expect(log.ok).toEqual(['190.0.0.5']);
    expect(log.failed).toContain('190.0.0.3');
  });

  test('a dead pool stops after its waves and says so', async () => {
    const { fake } = pool(null, Array.from({ length: 40 }, (_, i) => i + 1));
    let attempts = 0;
    await expect(
      raceProxies(fake, async () => { attempts++; throw new Error('timeout'); }, 'test')
    ).rejects.toThrow('All CO proxies failed across 15 tried');
    expect(attempts).toBe(15); // three waves of five, bounded

    const empty = pool(null, []);
    await expect(raceProxies(empty.fake, async () => 'x', 'test')).rejects.toThrow('No Colombian proxy available');
  });
});

test.describe('a request on a cold pool', () => {
  // Every restart starts the pool empty. Waiting for the whole verification
  // pass — over a minute — held each request to the 18 s cap, past the live,
  // card and arrivals budgets and the browser's 15 s, with proxies verified in
  // the first seconds of it. The pass is stubbed: nothing here leaves the box.
  const stub = ProxyManager as unknown as { refresh: () => Promise<void> };

  test('goes as soon as the first proxy verifies, not when the pass ends', async () => {
    try {
      let endPass = () => {};
      stub.refresh = () => new Promise<void>((resolve) => { endPass = resolve; });
      setTimeout(() => ProxyManager.reportSuccess('190.0.0.9', 8080, 900), 300);
      const started = Date.now();
      expect(await ProxyManager.waitForReady(5_000)).toBe(1);
      expect(Date.now() - started).toBeLessThan(2_000);
      endPass();

      // A pass that ends empty answers then, not at the cap.
      for (let i = 0; i < 5; i++) ProxyManager.reportFailure('190.0.0.9', 8080); // evicted
      stub.refresh = async () => {};
      const emptyAt = Date.now();
      expect(await ProxyManager.waitForReady(5_000)).toBe(0);
      expect(Date.now() - emptyAt).toBeLessThan(1_000);
    } finally {
      delete (stub as { refresh?: unknown }).refresh; // the class's own again
    }
  });
});
