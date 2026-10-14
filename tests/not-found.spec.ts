import { test, expect } from '@playwright/test';

/**
 * The page for an address this site does not have (spec §5.5.8,
 * `client/src/ui/notFoundPage.ts`). A made-up `#/r/<código>` used to open the
 * map as if the link had worked; a fragment never reaches the server, so the
 * page drawn here is the only 404 that link can get.
 */

// A route's existence is only known once the catalog and the route list are in.
test.describe.configure({ timeout: 180_000 });
const BOOT_TIMEOUT_MS = 90_000;

test('a made-up route link says so, and leaves for a clean address', async ({ page }) => {
  await page.goto('/#/r/1-1000000');

  const notFound = page.locator('#not-found-page');
  await expect(notFound).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(notFound).toContainText('No encontramos la ruta 1-1000000');

  await notFound.getByRole('button', { name: 'Ir al mapa' }).click();
  await expect(notFound).toHaveCount(0);
  expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe('/');
});

test('an address of no known shape is a 404 before the map has loaded', async ({ page }) => {
  await page.goto('/cualquier/cosa');
  await expect(page.locator('#not-found-page')).toContainText('No encontramos esa página', { timeout: 30_000 });
});

test('a real route link opens the route, not the 404', async ({ page }) => {
  await page.goto('/#/r/G47');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator('#route-detail')).toBeVisible();
  await expect(page.locator('#not-found-page')).toHaveCount(0);
});
