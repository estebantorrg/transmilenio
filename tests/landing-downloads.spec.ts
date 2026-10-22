import { test, expect } from '@playwright/test';

/**
 * What a visitor landing on a page from a search result downloads (spec §5.5.4).
 * The zonal paraderos feed only the map behind the page, so they wait until the
 * reader leaves it; the ArcGIS troncal routes layer is not fetched at all, its
 * one remaining use — the route's length — now measured along the catalog trace.
 */

test.describe.configure({ timeout: 240_000 });

test('a route page loads no zonal paraderos until the reader leaves it', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (req) => asked.push(new URL(req.url()).pathname));

  await page.goto('/ruta/g47/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  const routePage = page.locator('#route-page');
  await expect(routePage.locator('.route-plate')).toHaveText('G47');

  const longitud = routePage.locator('.page-fact', { hasText: 'Longitud' }).locator('.page-fact-value');
  await expect(longitud).toHaveText(/^\d+\.\d km$/);

  expect(asked).not.toContain('/api/troncal/routes');
  expect(asked).not.toContain('/api/zonal/stops');

  const zonalStops = page.waitForRequest((req) => new URL(req.url()).pathname === '/api/zonal/stops');
  await routePage.locator('.page-back').click();
  await zonalStops;
  await expect(routePage).toHaveCount(0);
});
