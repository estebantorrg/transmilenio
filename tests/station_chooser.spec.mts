import { test, expect, type Page } from '@playwright/test';

/**
 * The address of a stop the catalog files as one and that stands as two
 * stations (Ricaurte, Av. Jiménez) is a chooser between its halves
 * (`ui/stationPage.ts` renderChooser, `prerender_seo.ts` renderStationChooser).
 *
 * It used to draw both halves as one station, which is the thing the platform
 * pages were split to stop. Nothing on the site links to it any more; a search
 * result and every link shared before the split still land on it, and that
 * reader does not know yet which half they need.
 */

const BOOT_TIMEOUT_MS = 90_000;

async function boot(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

const CASES = [
  {
    path: '/estacion/ricaurte-tm0069/',
    halves: ['/estacion/ricaurte-nqs-tm0069nqs/', '/estacion/ricaurte-cl-13-tm0069c13/'],
    tunnel: true,
  },
  {
    path: '/estacion/avenida-jimenez-tm0013/',
    halves: ['/estacion/av-jimenez-caracas-tm0013car/', '/estacion/av-jimenez-cl-13-tm0013c13/'],
    // Its own plano strikes the tunnel through: the page must not offer it.
    tunnel: false,
  },
];

test.describe('a stop filed as one and standing as two', () => {
  test.describe.configure({ timeout: 180_000 });

  for (const c of CASES) {
    test(`${c.path} offers its two halves, not a plan of both`, async ({ page }) => {
      await boot(page, c.path);
      const el = page.locator('#station-page');
      const cards = el.locator('.station-choices .station-choice');
      await expect(cards).toHaveCount(2, { timeout: 30_000 });
      expect(await cards.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(c.halves);

      // Each half on its own troncal: two different accents, and códigos on each.
      const accents = await cards.evaluateAll((as) => as.map((a) => getComputedStyle(a).borderLeftColor));
      expect(accents[0]).not.toBe(accents[1]);
      for (let i = 0; i < 2; i++) {
        expect(await cards.nth(i).locator('.route-tag').count()).toBeGreaterThan(0);
      }

      // No drawing of both, no board or ridership that belongs to one half.
      await expect(el.locator('.station-plano')).toHaveCount(0);
      await expect(el.locator('.popup-arrivals')).toHaveCount(0);
      await expect(el.locator('.station-demand')).toHaveCount(0);

      const note = el.locator('.page-section .page-note').first();
      if (c.tunnel) await expect(note).toContainText('túnel peatonal');
      else await expect(note).toContainText('cerrado');
    });
  }

  test('a card opens its half', async ({ page }) => {
    await boot(page, '/estacion/ricaurte-tm0069/');
    await page.locator('#station-page .station-choice').nth(1).click();
    await expect(page).toHaveURL(/\/estacion\/ricaurte-cl-13-tm0069c13\/$/);
    await expect(page.locator('#station-page .station-hero-name')).toHaveText('Ricaurte - CL 13');
  });
});
