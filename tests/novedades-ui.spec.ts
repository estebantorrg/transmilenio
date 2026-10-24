import { test, expect, type Page } from '@playwright/test';

/**
 * Novedades on the website (`client/src/ui/novedadesPage.ts`, spec §5.5.9): a
 * bell over the map, marked while the newest #TMAhora post is recent and
 * unseen, that opens the last day's posts in a popup, and the `/novedades/`
 * page with the same list. The API is stubbed, so the
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
  await page.unroute('**/api/novedades');
  await page.route('**/api/novedades', (route) =>
    route.fulfill({
      json: { success: true, items, status: { lastAttemptAt: Date.now(), lastOkAt: Date.now(), lastError: null } },
    })
  );
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

test('a recent post marks the bell, and the bell opens the posts in a popup', async ({ page }) => {
  await boot(page, [post(12, 1), post(40, 2)]);

  const bell = page.locator('#novedades-bell');
  await expect(bell).toBeVisible();
  await expect(bell).toHaveClass(/unread/);
  await expect(bell).toHaveAttribute('aria-label', /hace 12 min: ⚠️ Manifestación número 1/);

  await bell.click();
  const pop = page.locator('#novedades-pop');
  await expect(pop).toBeVisible();
  await expect(bell).toHaveAttribute('aria-expanded', 'true');
  const items = pop.locator('.novedades-lista > li');
  await expect(items).toHaveCount(2);
  // As written, minus the link to its own photo.
  await expect(items.first()).toContainText('Avenida Circunvalar con calle 10');
  await expect(items.first()).not.toContainText('t.co');
  await expect(items.first().getByRole('link', { name: 'Ver en X' })).toHaveAttribute(
    'href',
    'https://x.com/TransMilenio/status/211000000000000001'
  );
  // Opened is read.
  await expect(bell).not.toHaveClass(/unread/);

  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(bell).toBeFocused();
});

test('an old post is in the popup but does not mark the bell', async ({ page }) => {
  await boot(page, [post(4 * 60, 1)]);
  const bell = page.locator('#novedades-bell');
  await expect(bell).not.toHaveClass(/unread/);
  await bell.click();
  await expect(page.locator('#novedades-pop .novedades-lista > li')).toHaveCount(1);
});

test('a click outside closes the popup', async ({ page }) => {
  await boot(page, [post(12, 1)]);
  await page.locator('#novedades-bell').click();
  await expect(page.locator('#novedades-pop')).toBeVisible();
  await page.locator('#search-input').click();
  await expect(page.locator('#novedades-pop')).toBeHidden();
});

test('/novedades/ opens straight on the page', async ({ page }) => {
  await boot(page, [post(5, 1)], '/novedades/');
  await expect(page.locator('#novedades-page h1')).toHaveText('Novedades de la operación');
  await expect(page.locator('#novedades-page .novedades-lista > li')).toHaveCount(1);
});

test('a seen post keeps the bell unmarked until TransMilenio posts again', async ({ page }) => {
  // ONE post, served on every boot: `post()` stamps `Date.now()`, so building it
  // again seconds later made a newer post than the one seen — which the bell
  // rightly marked as unseen, and the test failed on every run.
  const seen = post(12, 1);
  await boot(page, [seen]);
  await page.locator('#novedades-bell').click();
  await expect(page.locator('#novedades-bell')).not.toHaveClass(/unread/);

  await boot(page, [seen]);
  await expect(page.locator('#novedades-bell')).not.toHaveClass(/unread/);

  await boot(page, [post(1, 2), seen]);
  await expect(page.locator('#novedades-bell')).toHaveAttribute('aria-label', /Manifestación número 2/);
});

test('reading the page counts as seeing the posts', async ({ page }) => {
  await boot(page, [post(5, 1)], '/novedades/');
  await expect(page.locator('#novedades-page .novedades-lista > li')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#novedades-bell')).not.toHaveClass(/unread/);
});

