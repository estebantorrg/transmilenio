/**
 * The three cuts to upstream request volume (spec §5.2.3, §5.2.5). Measured on
 * 2026-09-21: the live host refreshes a route's positions about every 47 s, a
 * troncal poll was firing up to 12 name candidates, each of those raced 5
 * proxies, and pool verification spent up to 500 live-host requests every 10
 * minutes — far more load than the riders using it.
 *
 *   1. verification asks a neutral endpoint for the exit country first, and
 *      only a Colombian exit earns one live-host request
 *   2. the name that matched is remembered, so poll 2 asks once, not 12 times
 *   3. a proxy that has been answering gets the request alone, no wave
 */

import { expect, test } from '@playwright/test';
import { isProvenProxy, parseTraceCountry, PROVEN_PROXY_MAX_AGE_MS } from '../server/src/services/proxy_health';
import { forgetLiveName, recallLiveName, rememberLiveName } from '../server/src/services/live_name_memo';
import * as clientMemo from '../client/src/services/liveNameMemo';

const MINUTE = 60_000;

test.describe('exit-country probe (cut 1)', () => {
  test('reads loc out of a trace body, whatever the line endings', () => {
    expect(parseTraceCountry('fl=1\r\nip=181.2.3.4\r\nloc=CO\r\ncolo=BOG\r\n')).toBe('CO');
    expect(parseTraceCountry('loc=co')).toBe('CO');
    expect(parseTraceCountry('ip=1.2.3.4\nloc=US\n')).toBe('US');
  });

  test('a body with no country is null, never a guess', () => {
    // A middlebox can answer with anything; "no answer" must not read as CO.
    expect(parseTraceCountry('ip=1.2.3.4\nwarp=off\n')).toBeNull();
    expect(parseTraceCountry('<html>Access denied</html>')).toBeNull();
    expect(parseTraceCountry('loc=COLOMBIA')).toBeNull();
    expect(parseTraceCountry('xloc=CO')).toBeNull();
    expect(parseTraceCountry('')).toBeNull();
    expect(parseTraceCountry(undefined as unknown as string)).toBeNull();
  });
});

test.describe('proven proxy (cut 3)', () => {
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

test.describe('remembered destination name (cut 2)', () => {
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
