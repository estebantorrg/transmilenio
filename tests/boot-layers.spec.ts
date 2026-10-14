import { test, expect } from '@playwright/test';

/**
 * Boot does not wait on an optional map layer (spec §4.2).
 *
 * The five ArcGIS layers each have a catalog substitute or a recovery pass, but
 * boot gave every one of them its whole 60 s request timeout and a retry before
 * opening — so a single upstream query that never answered kept a visitor on
 * the loading screen for two minutes, after which the app opened without that
 * layer anyway. They may now hold it for ten seconds past the catalog.
 */
test('a map layer that never answers does not hold the loading screen', async ({ page }) => {
  test.setTimeout(90_000);
  // Never fulfilled: the request hangs, the way a stalled ArcGIS query does.
  await page.route('**/api/cable/trazado', () => {});

  await page.goto('/');
  // Well under the 122 s the old wait took, with room for a slow map style.
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 60_000 });
  await expect(page.locator('#map')).toBeVisible();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
