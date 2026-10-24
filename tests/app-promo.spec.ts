import { test, expect, type Page } from '@playwright/test';

/**
 * The Android app offered on the pages search sends readers to
 * (`appPromoHtml`, `client/src/ui/pageShell.ts`): inside the route page's
 * "En vivo" and the estación page's "Próximos a llegar", to Android visitors
 * only, and gone for good once closed.
 */

test.describe.configure({ timeout: 240_000 });
const BOOT_TIMEOUT_MS = 180_000;
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const DOWNLOAD = 'https://github.com/estebantorrg/transmilenio/releases/latest/download/mitrasto.apk';

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

test.describe('on Android', () => {
  test.use({ userAgent: ANDROID_UA, viewport: { width: 390, height: 844 } });

  test('a route page offers the app in its live section, and closing it is for good', async ({ page }) => {
    await open(page, '/ruta/g47/');
    const card = page.locator('#route-page section[aria-labelledby="live-h"] .page-app');
    await expect(card).toBeVisible();
    await expect(card.getByRole('link', { name: 'Descargar para Android' })).toHaveAttribute('href', DOWNLOAD);
    // Play Protect's dialog is named before the rider meets it, with the button to tap.
    await expect(card).toContainText('«Se recomienda analizar la app», toca Analizar app');

    await card.getByRole('button', { name: 'No volver a mostrar' }).click();
    await expect(page.locator('.page-app')).toHaveCount(0);

    await open(page, '/ruta/g47/');
    await expect(page.locator('#route-page .route-plate')).toHaveText('G47');
    await expect(page.locator('.page-app')).toHaveCount(0);
  });

  test('an estación page offers it beside the arrivals', async ({ page }) => {
    await open(page, '/estacion/calle-146-tm0025/');
    await expect(page.locator('#station-page section[aria-labelledby="llegadas-h"] .page-app')).toBeVisible();
  });
});

test('a desktop visitor is not offered an APK', async ({ page }) => {
  await open(page, '/ruta/g47/');
  await expect(page.locator('#route-page .route-plate')).toHaveText('G47');
  await expect(page.locator('.page-app')).toHaveCount(0);
});
