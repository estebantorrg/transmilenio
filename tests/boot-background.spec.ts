import { test, expect } from '@playwright/test';

/**
 * Opening the site and switching straight to another tab (spec §4.2).
 *
 * A background tab gets no animation frames, so MapLibre cannot draw and boot
 * waits on its `load`. That wait is not a fault: the reader who comes back must
 * find the site opening, not a Reintentar button — which is what the 12 s
 * "slow map" hint used to show, counting time the tab spent hidden — and must
 * not then wait for downloads a hidden tab could have done already.
 *
 * A real background tab cannot be made from a test, so it is played before the
 * page's own scripts run: `visibilityState` says hidden and every frame
 * callback is held, exactly as the browser holds them, until the tab is "shown".
 */

test.describe.configure({ timeout: 240_000 });

test('a site opened in a background tab is downloading, not failing, and opens when shown', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shown: boolean; __held: FrameRequestCallback[] };
    w.__shown = false;
    w.__held = [];
    const realRaf = window.requestAnimationFrame.bind(window);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (w.__shown ? 'visible' : 'hidden') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !w.__shown });
    window.requestAnimationFrame = (cb) => {
      if (w.__shown) return realRaf(cb);
      w.__held.push(cb);
      return w.__held.length;
    };
  });

  // The map's layers are asked for while the map cannot draw.
  const layer = page.waitForRequest((req) => req.url().includes('/api/troncal/stations'), { timeout: 60_000 });
  await page.goto('/');
  await layer;

  // Past the 12 s grace, hidden all along: no failure is announced.
  await page.waitForTimeout(14_000);
  await expect(page.locator('#loading-overlay')).toBeAttached();
  await expect(page.locator('#loading-retry')).toBeHidden();

  // Shown: frames run again, the map draws, the site opens — and the button never came.
  await page.evaluate(() => {
    const w = window as unknown as { __shown: boolean; __held: FrameRequestCallback[] };
    w.__shown = true;
    document.dispatchEvent(new Event('visibilitychange'));
    const held = w.__held.splice(0);
    requestAnimationFrame((t) => held.forEach((cb) => cb(t)));
  });
  await expect(page.locator('#loading-overlay')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#loading-retry')).toBeHidden();
});
