import { test, expect, type Page } from '@playwright/test';

/**
 * The walking pass (spec §5.6.4, `fetchWalkingPath` / `resolveWalkingLegs` in
 * `client/src/services/router.ts`): every walk leg is routed for real, cached by
 * the unordered pair of its ends (a walk is the same walk both ways), and kept
 * across visits — where what is read back is checked before it is trusted.
 *
 * `/api/walking-route` is answered here with a fixed 321 m route, so the card
 * shows exactly what the pass did with it.
 */

test.describe.configure({ timeout: 180_000 });
const BOOT_TIMEOUT_MS = 90_000;

// A 140 m trip in Teusaquillo: walking is the only plan worth showing.
const A: [number, number] = [-74.072866, 4.628596];
const B: [number, number] = [-74.071614, 4.628771];
const ROUTED_M = 321;

const link = (from: [number, number], to: [number, number], [ol, dl] = ['A', 'B']): string =>
  `/#/plan?o=${from[1]},${from[0]}&ol=${ol}&d=${to[1]},${to[0]}&dl=${dl}`;
const pairKey = (from: [number, number], to: [number, number]): string =>
  [from, to].map(([lng, lat]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).sort().join('|');

/** Answers every walking lookup with a 321 m route, and counts the ones for A↔B. */
async function routeWalks(page: Page): Promise<{ count: () => number }> {
  let count = 0;
  await page.route('**/api/walking-route?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const from = (params.get('from') ?? '').split(',').map(Number) as [number, number];
    const to = (params.get('to') ?? '').split(',').map(Number) as [number, number];
    if (pairKey(from, to) === pairKey(A, B)) count++;
    const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 + 0.0005];
    await route.fulfill({ json: { success: true, data: { coordinates: [from, mid, to], distance: ROUTED_M } } });
  });
  return { count: () => count };
}

const walkOnCard = (page: Page) => page.locator('#planner-results .journey-option-card').first().locator('.journey-meta-item').first();

test('the card carries the routed walk, and the trip back reuses it', async ({ page }) => {
  const walks = await routeWalks(page);
  await page.goto(link(A, B));
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await expect(walkOnCard(page)).toContainText(`${ROUTED_M} m`, { timeout: 30_000 });

  // The same walk the other way round: answered from the cache, not asked again.
  await page.evaluate((hash) => { location.hash = hash; }, link(B, A, ['B', 'A']).slice(1));
  await expect(page.locator('#plan-origin-input')).toHaveValue('B');
  await expect(walkOnCard(page)).toContainText(`${ROUTED_M} m`, { timeout: 30_000 });
  expect(walks.count()).toBe(1);
});

test('a saved walk that does not add up is asked for again, not shown', async ({ page }) => {
  const walks = await routeWalks(page);
  // A half-written store: the distance is missing. Read back as a number it was NaN m.
  await page.addInitScript((key) => {
    localStorage.setItem('tm.walkroutes.v2', JSON.stringify({ [key]: [null, 2, [[-74.07, 4.6], [-74.06, 4.6]]] }));
  }, pairKey(A, B));
  await page.goto(link(A, B));
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await expect(walkOnCard(page)).toContainText(`${ROUTED_M} m`, { timeout: 30_000 });
  expect(walks.count()).toBe(1);
});
