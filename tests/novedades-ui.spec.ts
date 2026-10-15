import { test, expect, type Page } from '@playwright/test';

/**
 * Novedades on the website (`client/src/ui/novedadesPage.ts`, spec §5.5.9): a
 * banner under the sidebar tabs while the newest #TMAhora post is recent, and
 * the `/novedades/` page with the last day's posts. The API is stubbed, so the
 * test does not depend on what TransMilenio posted today or on X answering.
 */

test.describe.configure({ timeout: 180_000 });
const BOOT_TIMEOUT_MS = 90_000;

const post = (minutesAgo: number, n: number) => ({
  id: `21100000000000000${n}`,
  at: Date.now() - minutesAgo * 60_000,
  text: `⏰ #TMAhora (5:13 p. m.)\n\n⚠️ Manifestación número ${n}\n\n📍 Avenida Circunvalar con calle 10\n\n🔀 Los buses continúan los desvíos. https://t.co/abc`,
  url: `https://x.com/TransMilenio/status/21100000000000000${n}`,
});

async function boot(page: Page, items: ReturnType<typeof post>[], path = '/'): Promise<void> {
  await page.route('**/api/novedades', (route) =>
    route.fulfill({
      json: { success: true, items, status: { lastAttemptAt: Date.now(), lastOkAt: Date.now(), lastError: null } },
    })
  );
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

test('a recent post shows in the banner, and the banner opens the page', async ({ page }) => {
  await boot(page, [post(12, 1), post(40, 2)]);

  const banner = page.locator('#novedades-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('hace 12 min');
  await expect(banner).toContainText('Manifestación número 1');
  await expect(banner).toHaveAttribute('aria-label', /Manifestación número 1.*las 2 novedades de hoy/);

  await banner.click();
  await expect(page).toHaveURL(/\/novedades\/$/);
  const items = page.locator('#novedades-page .novedades-lista > li');
  await expect(items).toHaveCount(2);
  // As written, minus the link to its own photo.
  await expect(items.first()).toContainText('Avenida Circunvalar con calle 10');
  await expect(items.first()).not.toContainText('t.co');
  await expect(items.first().getByRole('link', { name: 'Ver en X' })).toHaveAttribute(
    'href',
    'https://x.com/TransMilenio/status/211000000000000001'
  );
});

test('an old post stays on the page but not in the banner', async ({ page }) => {
  await boot(page, [post(4 * 60, 1)]);
  await expect(page.locator('#novedades-banner')).toBeHidden();
});

test('/novedades/ opens straight on the page', async ({ page }) => {
  await boot(page, [post(5, 1)], '/novedades/');
  await expect(page.locator('#novedades-page h1')).toHaveText('Novedades de la operación');
  await expect(page.locator('#novedades-page .novedades-lista > li')).toHaveCount(1);
});
