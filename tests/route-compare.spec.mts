import { test, expect } from '@playwright/test';
import { COMPARE_MAX, COMPARE_PALETTE, toggledCompared } from '../client/src/layers/compare.ts';

/**
 * "Comparar en el mapa" (`client/src/layers/compare.ts`; the route rows and the
 * route panel in `ui/sidebar.ts`): a route can be kept on the map, in a colour
 * of its own, while another one is selected, so two routes to the same place
 * read side by side. Up to three at a time; each can be taken off again.
 */

test.describe.configure({ timeout: 240_000 });

const trace = { paths: [[[-74.1, 4.6], [-74.05, 4.7]]] };
const route = (id: string) => ({ id, code: id.toUpperCase(), geometry: trace });

test.describe('the compared list', () => {
  test('adds a route in the first free colour and takes it off again', () => {
    const one = toggledCompared([], route('b11'));
    expect(one.map((r) => [r.code, r.color])).toEqual([['B11', COMPARE_PALETTE[0]]]);
    const two = toggledCompared(one, route('b16'));
    expect(two.map((r) => r.color)).toEqual([COMPARE_PALETTE[0], COMPARE_PALETTE[1]]);
    // Removing the first frees its colour for the next one, instead of repeating the second's.
    const back = toggledCompared(toggledCompared(two, route('b11')), route('c19'));
    expect(back.map((r) => [r.code, r.color])).toEqual([['B16', COMPARE_PALETTE[1]], ['C19', COMPARE_PALETTE[0]]]);
  });

  test('stops at the maximum and ignores a route whose trace has not loaded', () => {
    let list = toggledCompared([], route('a'));
    for (const id of ['b', 'c', 'd']) list = toggledCompared(list, route(id));
    expect(list).toHaveLength(COMPARE_MAX);
    expect(toggledCompared([], { id: 'x', code: 'X' })).toEqual([]);
  });
});

test('a kept route is named in the legend on the map, while others are picked, and taken off from there', async ({ page }) => {
  await page.goto('/#/r/B11');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  const compare = page.locator('#route-detail-compare');
  await expect(compare).toBeEnabled({ timeout: 60_000 });
  await expect(compare).toHaveText('Comparar con otra ruta');
  await compare.click();
  // Kept, and back to the list, where the other route is picked.
  await expect(page.locator('#route-detail')).toBeHidden();
  const legend = page.getByRole('list', { name: 'Rutas en comparación' });
  await expect(legend.getByRole('listitem')).toHaveText(['B11×']);

  await page.goto('/#/r/B16');
  await expect(page.locator('.detail-badge')).toHaveText('B16', { timeout: 60_000 });
  await expect(legend.getByRole('listitem')).toHaveText(['B11×']);
  await expect(compare).toHaveText('Comparar con otra ruta');

  await page.goto('/#/r/B11');
  await expect(compare).toHaveText('Quitar de la comparación', { timeout: 60_000 });
  await legend.getByRole('button', { name: 'Quitar B11 de la comparación' }).click();
  await expect(legend).toHaveCount(0);
  // The open panel follows the legend.
  await expect(compare).toHaveText('Comparar con otra ruta');
});

test('a route row adds it to the comparison without opening it, and fades the network', async ({ page }) => {
  await page.goto('/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  await page.getByPlaceholder(/Rutas, estaciones/).fill('K54');
  const row = page.locator('.route-item:not(.place-item)').filter({ has: page.locator('.route-item-badge', { hasText: /^K54$/ }) }).first();
  const button = row.getByRole('button', { name: 'Comparar K54 en el mapa' });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#route-detail')).toBeHidden();
  const legend = page.getByRole('list', { name: 'Rutas en comparación' });
  await expect(legend.getByRole('listitem')).toHaveText(['K54×']);
  // Among full-colour corridors a compared line is one more coloured line.
  const corridorOpacity = () => page.evaluate(() => (window as any).__tmMap.getPaintProperty('troncal-corridors-line', 'line-opacity'));
  await expect.poll(corridorOpacity).toBe(0.1);

  // Enter on the button is the button's, not the row's: it takes K54 off and opens nothing.
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(legend).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#route-detail')).toBeHidden();
  await expect.poll(corridorOpacity).not.toBe(0.1);
});
