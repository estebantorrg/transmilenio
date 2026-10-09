/**
 * Renumbered zonal routes (`shared/renumeraciones.js`): a rider who knows the
 * old código still finds the route. The table is TRANSMILENIO's own change log
 * (radicado 2026-ER-53567); what is tested here is how the site reads it.
 */

import { expect, test } from '@playwright/test';
import { RENUMERACIONES, codigosActuales, codigosAnteriores } from '../shared/renumeraciones.js';

test.describe('the renumbering table', () => {
  test('answers both ways, whatever the case', () => {
    expect(codigosActuales('39')).toEqual(['H439', 'F439']);
    expect(codigosActuales('742a')).toEqual(['K646', 'H646']);
    expect(codigosAnteriores('h439')).toEqual(['39']);
    expect(codigosAnteriores('F439')).toEqual(['39']);
    expect(codigosActuales('TC6')).toEqual(['K337']);
  });

  test('says nothing about a route that was never renumbered', () => {
    expect(codigosActuales('A410')).toEqual([]);
    expect(codigosAnteriores('A410')).toEqual([]);
    expect(codigosActuales('')).toEqual([]);
  });

  test('never redirects a live código: H715 still runs, only its other sentido became K715', () => {
    expect(codigosActuales('H715')).toEqual([]);
    expect(codigosAnteriores('K715')).toEqual([]);
  });

  test('no código is both retired and current, and every entry is dated', () => {
    const antes = new Set(RENUMERACIONES.map((r) => r.antes.toUpperCase()));
    for (const r of RENUMERACIONES) {
      expect(r.desde, r.antes).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.ahora.length, r.antes).toBeGreaterThan(0);
      for (const codigo of r.ahora) expect(antes.has(codigo.toUpperCase()), `${r.antes} → ${codigo}`).toBe(false);
    }
    expect(antes.size).toBe(RENUMERACIONES.length);
  });
});

test.describe('finding a route by the código it used to carry', () => {
  test.describe.configure({ timeout: 240_000 });

  test('searching "39" offers H439 and F439 first, marked "antes 39"', async ({ page }) => {
    await page.goto('/');
    await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
    await page.locator('#search-input').fill('39');
    const rows = page.locator('.route-item');
    await expect(rows.first().locator('.route-item-antes')).toHaveText('antes 39');
    const first = await rows.evaluateAll((els) =>
      els.slice(0, 2).map((el) => el.querySelector('.route-item-badge')?.textContent).sort());
    expect(first).toEqual(['F439', 'H439']);
    // The retired código itself is no longer a route in the list.
    await expect(page.locator('.route-item-badge', { hasText: /^39$/ })).toHaveCount(0);
  });

  test('an old link opens the route under its new código, and the address follows', async ({ page }) => {
    await page.goto('/ruta/39/');
    const plate = page.locator('#route-page .route-plate');
    await expect(plate).toHaveText(/^[FH]439$/, { timeout: 180_000 });
    await expect(page).toHaveURL(/\/ruta\/[fh]439\/$/i);
    await expect(page.locator('#route-page')).toContainText('Antes');
  });
});
