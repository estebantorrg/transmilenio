import { test, expect } from '@playwright/test';

/**
 * The route panel's share button (`shareRoute`, client/src/ui/sidebar.ts) copies
 * the route's own page, `/ruta/<código>/`, which the server previews with that
 * route's card. A `#/r/<código>` link reached the server as `/` and every chat
 * previewed it as the home page.
 */

test.describe.configure({ timeout: 240_000 });

test('sharing a route copies its page, not a hash deep link', async ({ page }) => {
  // The share button copies on a desktop pointer; keep what it copied.
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void (window as unknown as { __copied: string[] }).__copied.push(text) },
    });
  });
  await page.goto('/#/r/B16');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  await page.locator('#route-detail-share').click({ timeout: 60_000 });

  const copied = () => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '');
  await expect.poll(copied).toBe(`${new URL(page.url()).origin}/ruta/b16/`);
});
