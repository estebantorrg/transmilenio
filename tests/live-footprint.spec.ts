/**
 * The cuts to upstream request volume (spec §5.2.3, §5.2.5). Measured on
 * 2026-09-21: the live host refreshes a route's positions about every 47 s, a
 * troncal poll was firing up to 12 name candidates, each of those raced 5
 * proxies, and the pool re-probed its whole candidate list every 10 minutes
 * whether or not it needed proxies — far more load than the riders using it.
 *
 *   1. the name that matched is remembered, so poll 2 asks once, not 12 times
 *   2. a proxy that has been answering gets the request alone, no wave
 *   3. verification stops at target, and the scheduled re-scrape only runs
 *      when the pool is actually short
 *
 * A fourth idea — gating verification on the proxy's exit country from
 * Cloudflare's trace endpoint — was measured, found to discard the only
 * proxies that worked, and reverted; see `MAX_TEST_CANDIDATES`.
 */

import { expect, test } from '@playwright/test';
import { isProvenProxy, PROVEN_PROXY_MAX_AGE_MS, shouldRefreshPool } from '../server/src/services/proxy_health';
import { forgetLiveName, recallLiveName, rememberLiveName } from '../server/src/services/live_name_memo';
import * as clientMemo from '../client/src/services/liveNameMemo';

const MINUTE = 60_000;

test.describe('pool re-scrape (cut 3)', () => {
  test('only runs when the pool is short of target', () => {
    // The unconditional 10-minute tick re-probed a healthy pool — one
    // live-host request per candidate — for nothing.
    expect(shouldRefreshPool(0, 12)).toBe(true);
    expect(shouldRefreshPool(11, 12)).toBe(true);
    expect(shouldRefreshPool(12, 12)).toBe(false);
    expect(shouldRefreshPool(30, 12)).toBe(false);
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
  test('server: the matching name comes back, and only until it goes stale', () => {
    forgetLiveName('troncal', 'H15');
    expect(recallLiveName('troncal', 'H15')).toBeNull();

    rememberLiveName('troncal', 'H15', 'Portal Tunal');
    expect(recallLiveName('troncal', 'h15')).toEqual({ name: 'Portal Tunal', fresh: true });
    // Stale keeps the name but stops trusting an empty answer from it, which is
    // what sends the next poll back through the full candidate set.
    expect(recallLiveName('troncal', 'H15', Date.now() + 11 * MINUTE)).toEqual({ name: 'Portal Tunal', fresh: false });

    forgetLiveName('troncal', 'H15');
    expect(recallLiveName('troncal', 'H15')).toBeNull();
  });

  test('server: troncal and zonal are separate, and an empty name is ignored', () => {
    rememberLiveName('troncal', 'A', 'Name A');
    rememberLiveName('zonal', 'A', 'Name Z');
    expect(recallLiveName('troncal', 'A')?.name).toBe('Name A');
    expect(recallLiveName('zonal', 'A')?.name).toBe('Name Z');

    rememberLiveName('troncal', 'A', '');
    expect(recallLiveName('troncal', 'A')?.name).toBe('Name A');
    forgetLiveName('troncal', 'A');
    forgetLiveName('zonal', 'A');
  });

  test('server: the memo is bounded — a TTL alone never frees an unread entry', () => {
    // 400 is the cap; the oldest insert must be the one that goes.
    rememberLiveName('troncal', 'FIRST', 'oldest');
    for (let i = 0; i < 400; i++) rememberLiveName('troncal', `FILL${i}`, `name${i}`);
    expect(recallLiveName('troncal', 'FIRST')).toBeNull();
    expect(recallLiveName('troncal', 'FILL399')?.name).toBe('name399');
    for (let i = 0; i < 400; i++) forgetLiveName('troncal', `FILL${i}`);
  });

  test('client: the app-side memo behaves the same', () => {
    clientMemo.forgetLiveName('B12');
    expect(clientMemo.recallLiveName('B12')).toBeNull();

    clientMemo.rememberLiveName('b12', 'Portal Norte');
    expect(clientMemo.recallLiveName('B12')).toEqual({ name: 'Portal Norte', fresh: true });
    expect(clientMemo.recallLiveName('B12', Date.now() + 11 * MINUTE)?.fresh).toBe(false);

    clientMemo.forgetLiveName('B12');
    expect(clientMemo.recallLiveName('B12')).toBeNull();
  });
});
