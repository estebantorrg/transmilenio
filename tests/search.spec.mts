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

  test('a barrio lists the routes that pass there, after the ones it names', async ({ page }) => {
    await bootApp(page);
    await search(page, 'Modelia');
    const titulo = page.locator('#route-list .search-points-title', { hasText: 'Rutas que pasan por Modelia' });
    await expect(titulo).toBeVisible();
    // Above the places it is a preview, so the places stay within reach; one button opens them all.
    await expect(page.locator('#route-list .place-item').first()).toBeVisible();
    await page.locator('#route-list [data-more="pasan"]').click();
    await expect(page.locator('#route-list .place-item')).toHaveCount(0);
    const filas = await page.evaluate(() =>
      [...document.querySelectorAll('#route-list .route-item:not(.place-item)')].map((el) => ({
        code: el.querySelector('.route-item-badge')?.textContent?.trim() ?? '',
        name: el.querySelector('.route-item-name')?.textContent?.trim() ?? '',
        por: el.querySelector('.route-item-endpoints')?.textContent?.trim() ?? '',
      }))
    );
    const pasan = filas.filter((f) => f.por.startsWith('por '));
    expect(pasan.length).toBeGreaterThan(30);
    // Each says the place that brought it here.
    expect(pasan.every((f) => /modelia/i.test(f.por))).toBe(true);
    // The ones that name it in their ends come first.
    expect(filas.findIndex((f) => f.por.startsWith('por '))).toBe(filas.length - pasan.length);
    // A Ciclovía variant does not double its ordinary service.
    const ciclovia = pasan.filter((f) => /ciclov/i.test(f.name)).map((f) => f.code);
    const ordinaria = new Set(pasan.filter((f) => !/ciclov/i.test(f.name)).map((f) => f.code));
    expect(ciclovia.filter((c) => ordinaria.has(c))).toEqual([]);
  });

  test('a landmark is found spelled out, from the printed hito', async ({ page }) => {
    await bootApp(page);
    await search(page, 'hospital kennedy');
    await expect(page.locator('#route-list .search-points-title', { hasText: 'Rutas que pasan por hospital kennedy' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#route-list .route-item-endpoints', { hasText: /HSP\. KENNEDY/i }).first()).toBeVisible();
  });

  test('a route with a printed rutero says the corredores it runs along, the main one first', async ({ page }) => {
    await bootApp(page);
    await search(page, 'A410');
    const fila = page.locator('#route-list .route-item', { has: page.locator('.route-item-badge', { hasText: /^A410$/ }) }).first();
    await expect(fila.locator('.route-item-via')).toHaveText(/^por AV\. ESPERANZA · /, { timeout: 20_000 });
    await expect(fila).toHaveAttribute('aria-label', /por Avenida Esperanza/);
  });
});
