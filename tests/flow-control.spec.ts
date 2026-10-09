/**
 * Server-side flow control (spec §3.4).
 *
 * Every endpoint that forwards a request to someone else's host used to do it
 * once per request, for anyone, without limit — and the live host has already
 * blocklisted an install id over volume (spec §5.2.3). These pin the two bounds:
 * riders asking the same question share one answer, and one client has a budget.
 * The last block pins the surface itself: the routes that were open to anyone
 * stay gone, and every forwarding route keeps its budget.
 */

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { clientKey, createRateLimiter, createSharedWindow } from '../server/src/services/flow_control';

const ROUTES = fs.readFileSync(path.resolve(__dirname, '..', 'server/src/routes/api.ts'), 'utf8');

test.describe('shared result window', () => {
  test('callers that ask while it runs, or just after, get the one answer', async () => {
    let clock = 1_000;
    let runs = 0;
    const share = createSharedWindow<number>(10_000, 10);
    let release!: (value: number) => void;
    const run = () => {
      runs++;
      return new Promise<number>((resolve) => { release = resolve; });
    };

    const first = share('h15', run, () => clock);
    // A cascade can outlast the window; a caller arriving meanwhile still joins it.
    clock += 14_000;
    const joined = share('h15', run, () => clock);
    release(7);
    expect(await first).toBe(7);
    expect(await joined).toBe(7);
    expect(runs).toBe(1);

    clock += 9_999;
    expect(await share('h15', run, () => clock)).toBe(7);
    expect(runs).toBe(1);

    // Past the window the next caller asks again.
    clock += 1;
    void share('h15', run, () => clock);
    expect(runs).toBe(2);
  });

  test('another key is another question', async () => {
    const share = createSharedWindow<string>(10_000, 10);
    expect(await share('troncal|h15|portal tunal', async () => 'a')).toBe('a');
    expect(await share('troncal|h15|portal norte', async () => 'b')).toBe('b');
  });

  test('a failure is not kept: the next caller tries again', async () => {
    const share = createSharedWindow<string>(10_000, 10);
    await expect(share('k', async () => { throw new Error('upstream down'); })).rejects.toThrow('upstream down');
    expect(await share('k', async () => 'ok')).toBe('ok');
  });

  test('it is bounded — a TTL alone never frees an unread entry', async () => {
    let runs = 0;
    const share = createSharedWindow<number>(60_000, 3);
    const run = async () => ++runs;
    await share('first', run);
    for (const key of ['a', 'b', 'c']) await share(key, run);
    expect(runs).toBe(4);
    await share('c', run); // still held
    expect(runs).toBe(4);
    await share('first', run); // evicted as the oldest, so it runs again
    expect(runs).toBe(5);
  });
});

test.describe('who a request counts against', () => {
  test('an IPv4 address is one client, mapped or not', () => {
    expect(clientKey('181.52.10.7')).toBe('181.52.10.7');
    expect(clientKey('::ffff:181.52.10.7')).toBe('181.52.10.7');
  });

  test('an IPv6 client is its /64, however the address is written', () => {
    // One subscriber can take a new address from its /64 on every request.
    expect(clientKey('2800:484:ab12:cd34:1:2:3:4')).toBe('2800:484:ab12:cd34');
    expect(clientKey('2800:484:AB12:CD34::9')).toBe('2800:484:ab12:cd34');
    expect(clientKey('2800:484::1')).toBe('2800:484:0:0');
    expect(clientKey('2800:484::1')).toBe(clientKey('2800:484::ffff:1'));
    expect(clientKey('2800:484:1::1')).not.toBe(clientKey('2800:484:2::1'));
  });
});

test.describe('per-client budget', () => {
  test('a client gets its budget each window, and no more', () => {
    const limiter = createRateLimiter(60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(limiter.allow('card|1.1.1.1', 3, t0 + i)).toBe(true);
    expect(limiter.allow('card|1.1.1.1', 3, t0 + 10)).toBe(false);
    expect(limiter.retryAfterSeconds(t0 + 15_000)).toBe(45);

    // Another client, and another endpoint for the same client, are untouched.
    expect(limiter.allow('card|2.2.2.2', 3, t0 + 10)).toBe(true);
    expect(limiter.allow('buses|1.1.1.1', 3, t0 + 10)).toBe(true);

    // The window turns: the budget is whole again and the table starts over.
    expect(limiter.allow('card|1.1.1.1', 3, t0 + 60_000)).toBe(true);
    expect(limiter.size()).toBe(1);
  });

  test('the table is bounded, and a key that does not fit is refused', () => {
    const limiter = createRateLimiter(60_000, 2);
    expect(limiter.allow('a', 5, 1)).toBe(true);
    expect(limiter.allow('b', 5, 1)).toBe(true);
    expect(limiter.allow('c', 5, 1)).toBe(false);
    expect(limiter.allow('a', 5, 1)).toBe(true); // already counted, still served
    expect(limiter.size()).toBe(2);
  });
});

test.describe('the API surface', () => {
  test('nothing a stranger can call starts a sync or a diagnostic live fetch', () => {
    // A catalog sync peaks near 700 MB on a 512 MB instance (spec §5.1.3); it is
    // run offline with `npm run sync`, never over HTTP.
    expect(ROUTES).not.toContain('/troncal/sync');
    expect(ROUTES).not.toContain('syncMasterCatalog');
    expect(ROUTES).not.toContain('/debug-buses');
  });

  test('every route that forwards to another host has a budget', () => {
    const forwarding: Array<[string, string]> = [
      ["post('/buses'", 'buses'],
      ["post('/arrivals'", 'arrivals'],
      ["post('/stop-arrivals'", 'stop-arrivals'],
      ["post('/card/read'", 'card'],
      ["get('/geocode'", 'geocode'],
      ["get('/walking-route'", 'walking-route'],
    ];
    for (const [route, budget] of forwarding) {
      expect(ROUTES, route).toContain(`router.${route}, rateLimit('${budget}'),`);
    }
  });
});
