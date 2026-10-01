/**
 * The two public-proxy switches (`server/src/services/public_proxy_policy.ts`,
 * spec §5.2.5): live tracking and card reads decided separately, with the card
 * switch following the live one when unset. Pure logic: no page, no network.
 */

import { expect, test } from '@playwright/test';
import { anyPublicProxyAllowed, publicProxyAllowed } from '../server/src/services/public_proxy_policy';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

test.describe('public CO proxy switches', () => {
  test('nothing set: no feature uses the proxies', () => {
    expect(publicProxyAllowed('live', env({}))).toBe(false);
    expect(publicProxyAllowed('card', env({}))).toBe(false);
    expect(anyPublicProxyAllowed(env({}))).toBe(false);
  });

  test('only the original switch: both, exactly as before the split', () => {
    const e = env({ TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY: '1' });
    expect(publicProxyAllowed('live', e)).toBe(true);
    expect(publicProxyAllowed('card', e)).toBe(true);
  });

  test('card switch off: live keeps the proxies, card reads do not', () => {
    const e = env({ TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY: '1', TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY_CARD: '0' });
    expect(publicProxyAllowed('live', e)).toBe(true);
    expect(publicProxyAllowed('card', e)).toBe(false);
    expect(anyPublicProxyAllowed(e)).toBe(true);
  });

  test('card switch on alone: the pool still loads, for card reads only', () => {
    const e = env({ TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY_CARD: '1' });
    expect(publicProxyAllowed('live', e)).toBe(false);
    expect(publicProxyAllowed('card', e)).toBe(true);
    expect(anyPublicProxyAllowed(e)).toBe(true);
  });
});
