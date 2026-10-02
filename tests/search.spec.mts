import { test, expect, type Page } from '@playwright/test';

/**
 * The Explore search (`client/src/ui/sidebar.ts`, spec §5.4.2b).
 *
 * A query is first a search for routes: that is what the list is. Searching
 * "100" put a tullave kiosk whose address happens to say "100" at the top, in
 * a framed card with a dot and a pill — a different kind of object from the
 * clean rows of the routes that actually run along Calle 100, pushed down
 * under it. Routes now come first, and the places that match follow them,
 * set as route rows are.
 */

const BOOT_TIMEOUT_MS = 90_000;

async function bootApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

async function search(page: Page, query: string): Promise<void> {
  await page.locator('#search-input').fill(query);
  await page.locator('#route-list .route-item').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('the Explore search', () => {
  test.describe.configure({ timeout: 180_000 });

  test('routes come first, and the places that match follow them', async ({ page }) => {
    await bootApp(page);
    await search(page, '100');
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('#route-list .route-item')].map((el) => (el.classList.contains('place-item') ? 'place' : 'route'))
    );
    expect(order.length).toBeGreaterThan(1);
    expect(order[0]).toBe('route');
    // No route after the first place: the places are one block, under the routes.
    const firstPlace = order.indexOf('place');
    expect(firstPlace).toBeGreaterThan(0);
    expect(order.slice(firstPlace).every((kind) => kind === 'place')).toBe(true);
  });

  test('a place reads as a route row does: badge, name, kind and detail', async ({ page }) => {
    await bootApp(page);
    await search(page, '100');
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#route-list .place-item')].map((el) => ({
        badge: !!el.querySelector('.route-item-badge svg'),
        name: el.querySelector('.route-item-name')?.textContent?.trim() ?? '',
        kind: el.querySelector('.route-item-type')?.textContent?.trim() ?? '',
        // Drawn with the route row's own box, not a card of its own.
        border: getComputedStyle(el).borderTopColor,
        ground: getComputedStyle(el).backgroundColor,
      }))
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.badge).toBe(true);
      expect(row.name).not.toBe('');
      expect(row.kind).not.toBe('');
      expect(row.ground).toBe('rgba(0, 0, 0, 0)');
    }
    // And the Cerca tab's framed card is not what search draws.
    expect(await page.locator('#route-list .near-row').count()).toBe(0);
  });
});
