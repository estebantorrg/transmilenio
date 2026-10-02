import { test, expect, type Page } from '@playwright/test';

/**
 * Two things a place says on screen (`ui/cerca.ts`, `layers/arrivals.ts`).
 *
 *  · **A place row is a route row**, in the Cerca tab as in search: a badge
 *    carrying the kind's glyph, the name, kind and address, and here the
 *    distance and the walk. It was a framed card with a dot and a pill, so the
 *    same place looked like a different object depending on how it was found.
 *  · **An empty arrivals board after hours says the service is closed.** At
 *    00:17 a station read "Sin buses en aproximación ahora" while the route page
 *    at the same moment said "Fuera de servicio": the live feed is down by
 *    design outside its hours, and that is what the board now says.
 */

const BOOT_TIMEOUT_MS = 90_000;
const bog = (local: string) => new Date(`${local}:00-05:00`);

async function boot(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

test.describe('a place on screen', () => {
  test.describe.configure({ timeout: 180_000 });

  test.describe('in the Cerca tab', () => {
    // Calle 100, so there is something within walking distance of every kind.
    test.use({ geolocation: { latitude: 4.6826, longitude: -74.0486 }, permissions: ['geolocation'] });

    test('each place is a route row, with its distance and walk', async ({ page }) => {
      await boot(page);
      await page.locator('#tab-cerca').click();
      await page.locator('#cerca-locate').click();
      await page.locator('#cerca-list .place-item').first().waitFor({ state: 'visible', timeout: 30_000 });
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('#cerca-list .place-item')].map((el) => ({
          badge: !!el.querySelector('.route-item-badge svg'),
          name: el.querySelector('.route-item-name')?.textContent?.trim() ?? '',
          kind: el.querySelector('.route-item-type')?.textContent?.trim() ?? '',
          dist: el.querySelector('.place-dist')?.textContent?.trim() ?? '',
          walk: el.querySelector('.place-walk')?.textContent?.trim() ?? '',
        }))
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.badge).toBe(true);
        expect(row.name).not.toBe('');
        expect(row.kind).not.toBe('');
        expect(row.dist).toMatch(/\d/);
        expect(row.walk).toMatch(/min$/);
      }
      // The framed card with a dot and a pill is gone.
      expect(await page.locator('#cerca-list .near-row, #cerca-list .near-dot').count()).toBe(0);
    });
  });

  test('an empty board after hours says the service is closed', async ({ page }) => {
    await page.clock.setFixedTime(bog('2026-10-02T00:30'));
    await boot(page, '/estacion/e-tm0018/');
    const board = page.locator('#station-page .popup-arrivals');
    await board.waitFor({ state: 'visible', timeout: 20_000 });
    // Whatever the live feed answers at night — nothing, or nothing at all —
    // an empty board names the closed window rather than an absence of buses.
    await expect(board.locator('.arr-loading')).toHaveCount(0, { timeout: 30_000 });
    if ((await board.locator('.arr-row').count()) === 0) {
      await expect(board).toContainText('Servicio cerrado');
      await expect(board).not.toContainText('Sin buses en aproximación');
    }
  });
});
