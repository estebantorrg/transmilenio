/**
 * One live request, asked one way (spec §5.2.4, §5.2.2a).
 *
 * The tier cascade and the standalone relay each carried their own copy of the
 * candidate race, and neither could be tested: the main copy lived in a module
 * the runner cannot load. These pin what both now share
 * (`server/src/services/live_request.ts`):
 *
 *   1. the race — first NON-EMPTY answer wins, an empty one needs every
 *      candidate to have answered, and "nobody answered" is its own outcome
 *   2. only names the catalog files a route under are asked upstream
 *   3. the relay forwards four paths, each with its own verb, and nothing else
 */

import { expect, test } from '@playwright/test';
import {
  buildLiveNameCandidates,
  isForwardAllowed,
  isTrustedLiveAnswer,
  keepKnownLiveNames,
  raceLiveCandidates,
  variantLiveNames,
} from '../server/src/services/live_request';

const later = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const BUS = { latitude: 4.6, longitude: -74.08 };

test.describe('the candidate race', () => {
  test('the first non-empty answer wins, and the stragglers are cancelled', async () => {
    const aborted: string[] = [];
    const hits: string[] = [];
    const answer = await raceLiveCandidates(
      ['slow', 'empty', 'match'],
      (name, signal) => new Promise<any[]>((resolve) => {
        // `empty` answers first and proves nothing; `slow` would answer too late.
        const delay = name === 'match' ? 15 : name === 'empty' ? 1 : 2_000;
        const timer = setTimeout(() => resolve(name === 'empty' ? [] : [BUS]), delay);
        signal.addEventListener('abort', () => { aborted.push(name); clearTimeout(timer); });
      }),
      { onHit: (name) => hits.push(name) }
    );
    expect(answer).toEqual([BUS]);
    expect(hits).toEqual(['match']);
    expect(aborted).toContain('slow');
  });

  test('an empty answer stands only once every candidate has answered', async () => {
    const order: string[] = [];
    const answer = await raceLiveCandidates(['a', 'b'], async (name) => {
      await later(name === 'a' ? 1 : 20, null);
      order.push(name);
      return [];
    });
    expect(answer).toEqual([]);
    expect(order).toEqual(['a', 'b']); // it waited for the slow one
  });

  test('one answer among failures is still an answer', async () => {
    const failed: string[] = [];
    const answer = await raceLiveCandidates(
      ['dead', 'empty'],
      async (name) => {
        if (name === 'dead') throw new Error('reset');
        return [];
      },
      { onError: (name, error) => failed.push(`${name}: ${error.message}`) }
    );
    expect(answer).toEqual([]);
    expect(failed).toEqual(['dead: reset']);
  });

  test('nobody answering is null, never an empty list', async () => {
    // An empty list is "no buses right now" — a claim only an answer can make.
    const failed: string[] = [];
    const answer = await raceLiveCandidates(
      ['a', 'b'],
      async () => { throw new Error('timeout'); },
      { onError: (name) => failed.push(name) }
    );
    expect(answer).toBeNull();
    expect(failed.sort()).toEqual(['a', 'b']);
    expect(await raceLiveCandidates([], async () => [BUS])).toBeNull();
  });

  test('a caller that gives up cancels every candidate', async () => {
    const parent = new AbortController();
    let aborted = 0;
    const pending = raceLiveCandidates(['a', 'b'], (_name, signal) => new Promise<any[]>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); });
    }), { signal: parent.signal });
    parent.abort();
    expect(await pending).toBeNull();
    expect(aborted).toBe(2);
  });
});

test.describe('the names a route is asked under', () => {
  const variants = [
    { nombre: 'Portal Eldorado - Universidades', stops: [{ nombre: 'Portal Eldorado' }, { nombre: 'Universidades' }] },
    { nombre: 'Universidades - Portal Eldorado', destination: 'Portal  Eldorado', origin: 'Universidades' },
  ];

  test('a variant offers its destination first', () => {
    expect(variantLiveNames(variants[0])).toEqual(['Portal Eldorado - Universidades', 'Universidades', 'Portal Eldorado']);
    expect(variantLiveNames({ destination: 'B', nombre: 'A - B', origin: 'A' })).toEqual(['B', 'A - B', 'A']);
    expect(variantLiveNames({})).toEqual([]);
  });

  test('a hyphenated name is tried as each half, last half first, then whole', () => {
    expect(buildLiveNameCandidates('Portal Norte - Portal Tunal')).toEqual([
      'Portal Tunal', 'Portal Norte', 'Portal Norte - Portal Tunal',
    ]);
    // The caller's candidates go ahead of the name, without repeats.
    expect(buildLiveNameCandidates('Portal Tunal', ['portal tunal', 'Calle 72'])).toEqual(['portal tunal', 'Calle 72']);
    // Never empty: a request with no name still asks, with an empty one.
    expect(buildLiveNameCandidates('', [])).toEqual(['']);
    expect(buildLiveNameCandidates('x', Array.from({ length: 40 }, (_, i) => `n${i}`))).toHaveLength(12);
  });

  test('only names the catalog files the route under go upstream', () => {
    // A valid route with made-up names used to be twelve upstream requests a
    // call, each under a share key nobody else would ever hit.
    const sent = ['Universidades', 'portal eldorado', 'x9f3-random', 'Universidades - Portal Eldorado', 'Portal Suba'];
    expect(keepKnownLiveNames(sent, variants)).toEqual([
      'Universidades', 'portal eldorado', 'Universidades - Portal Eldorado',
    ]);
    // Nothing known is nothing kept — the request then asks with no name.
    expect(keepKnownLiveNames(['made up', 'also made up'], variants)).toEqual([]);
    expect(keepKnownLiveNames(['Universidades'], [])).toEqual([]);
  });
});

test.describe('the relay forwarder', () => {
  test('forwards the three live-host paths, each with its own verb', () => {
    expect(isForwardAllowed('/lectura_tarjeta', 'POST')).toBe(true);
    expect(isForwardAllowed('/puntos_recarga', 'GET')).toBe(true);
    expect(isForwardAllowed('/puntos_personalizacion', 'GET')).toBe(true);
    // The arrivals board went with `/api/arrivals`, which nothing called: the app
    // asks the live host for it from the phone (`officialApi.getArrivals`).
    expect(isForwardAllowed('/paradero/buses', 'POST')).toBe(false);
  });

  test('and nothing else: it is a forwarder, not an open proxy', () => {
    expect(isForwardAllowed('/puntos_recarga', 'POST')).toBe(false);
    expect(isForwardAllowed('/lectura_tarjeta', 'GET')).toBe(false);
    // Exact paths — a prefix match would authorize everything under one.
    expect(isForwardAllowed('/lectura_tarjeta/../admin', 'POST')).toBe(false);
    expect(isForwardAllowed('/lectura_tarjeta?x=1', 'POST')).toBe(false);
    expect(isForwardAllowed('/buses', 'POST')).toBe(false);
    expect(isForwardAllowed('https://example.com/lectura_tarjeta', 'POST')).toBe(false);
    // `constructor` is a property of every object, and it is not a path.
    expect(isForwardAllowed('constructor', 'POST')).toBe(false);
    expect(isForwardAllowed(undefined, 'POST')).toBe(false);
    expect(isForwardAllowed({ toString: () => '/lectura_tarjeta' }, 'POST')).toBe(false);
  });
});

test.describe('what an answer is worth', () => {
  // `/api/buses` (no-buses vs unverified) and the arrivals board (an empty
  // board vs "no disponible") both read this. The board used to read nothing:
  // every failure was an empty list, and every board in the city said "sin
  // buses" whenever the free proxies were down.
  test('buses are a fact from any transport', () => {
    expect(isTrustedLiveAnswer({ buses: [BUS], source: 'public-co-proxy' })).toBe(true);
  });

  test('an empty list is a fact only from a Colombian egress', () => {
    expect(isTrustedLiveAnswer({ buses: [], source: 'direct' })).toBe(true);
    expect(isTrustedLiveAnswer({ buses: [], source: 'co-relay' })).toBe(true);
    expect(isTrustedLiveAnswer({ buses: [], source: 'public-co-proxy' })).toBe(false);
  });
});
