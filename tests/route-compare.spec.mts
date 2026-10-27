import { test, expect } from '@playwright/test';
import { COMPARE_MAX, COMPARE_PALETTE, toggledCompared } from '../client/src/layers/compare.ts';

/**
 * "Comparar en el mapa" (`client/src/layers/compare.ts`, the route panel in
 * `ui/sidebar.ts`): a route can be kept on the map, in a colour of its own,
 * while another one is selected, so two routes to the same place read side by
 * side. Up to three at a time; each can be taken off again.
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

test('a route kept for comparison stays listed while another is selected', async ({ page }) => {
  await page.goto('/#/r/B11');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  const compare = page.locator('#route-detail-compare');
  await expect(compare).toBeEnabled({ timeout: 60_000 });
  await compare.click();
  await expect(compare).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/#/r/B16');
  await expect(page.locator('.detail-badge')).toHaveText('B16', { timeout: 60_000 });
  await expect(page.locator('.detail-compare-list li')).toHaveText(['B11×']);
  await expect(page.locator('#route-detail-compare')).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: 'Quitar B11 de la comparación' }).click();
  await expect(page.locator('.detail-compare-list')).toHaveCount(0);
});
