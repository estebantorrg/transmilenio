import { test, expect, type Page } from '@playwright/test';
import { normalizeRuteroText, ruteroSvg } from '../shared/rutero.js';

/**
 * The zonal LED sign (planA2 step 8): built, unverified, and held back behind
 * the `rutero-zonal` flag. Shaped after photographs of zonal buses (C124, 818,
 * 149): a plain panel in one LED colour, código and destino on top, and a small
 * mixed-case line under them scrolling right to left.
 */

const pasaPath = (svg: string) => /<path id="rt-p-[^"]*" d="([^"]*)"/.exec(svg)?.[1] ?? '';

test.describe('the zonal panel', () => {
  test('the top line is lit in the zone colour, and only it', () => {
    const zonal = ruteroSvg({ code: 'C124', destination: 'Bilbao', zona: '#FCBD1B', uid: 'a', pasa: 'Porciúncula/AK 7' });
    expect(zonal).toContain('fill="#FCBD1B"');
    // One band, the 13 rows of the top line: no box running down beside the second line.
    expect(zonal.match(/fill="url\(#rt-z-a\)"/g)).toHaveLength(1);
    expect(zonal).toMatch(/<rect width="\d+" height="13" fill="url\(#rt-z-a\)"\/>/);
    // Without a zone, the plain panel the troncal sign has.
    const plano = ruteroSvg({ code: 'F23', destination: 'Portal Américas', uid: 'b' });
    expect(plano.match(/fill="#[0-9a-f]{6}"/gi)?.sort()).toEqual(['fill="#05080c"', 'fill="#161d26"']);
  });

  test('letters white on zone A\'s navy, dark on the other colours, as photographed', () => {
    const oscuras = (zona: string) => ruteroSvg({ code: 'X1', destination: 'X', zona, uid: 'z' }).includes('stroke="#05080c" stroke-width=".9"');
    expect(oscuras('#26358C')).toBe(false); // A720, A818, A702
    expect(oscuras('#DC0814')).toBe(true); // F918
    expect(oscuras('#FCBD1B')).toBe(true); // C124
    expect(oscuras('#009A9D')).toBe(true); // L149
  });

  test('the second line runs the full width under the top line', () => {
    const svg = ruteroSvg({ code: 'C124', destination: 'Bilbao', zona: '#FCBD1B', uid: 'g', pasa: 'Suba' });
    expect(svg).toMatch(/<clipPath id="rt-c-g"><rect y="13" width="\d+" height="9"\/>/);
    expect(svg).toContain('stroke="#e9f6ff"');
  });

  test('the barrios scroll on a smaller second line under the destino', () => {
    const one = ruteroSvg({ code: 'C124', destination: 'Bilbao', uid: 'e' });
    const two = ruteroSvg({ code: 'C124', destination: 'Bilbao', uid: 'f', pasa: 'Porciúncula/AK 7 - San Fernando/AC 72' });
    expect(one).not.toContain('rutero-pasa');
    expect(two).toContain('class="rutero-pasa"');
    expect(two).toContain('clip-path="url(#rt-c-f)"');
    // The 11-row line and the 8-row small face, three pad rows: 11 + 8 + 3.
    expect(two).toMatch(/viewBox="0 0 \d+ 22"/);
    expect(one).toMatch(/viewBox="0 0 \d+ 13"/);
  });

  test('the small face has every letter, both cases, and the digits', () => {
    for (const ch of 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZabcdefghijklmnñopqrstuvwxyz0123456789./-°') {
      expect(pasaPath(ruteroSvg({ code: 'C1', destination: 'X', pasa: ch })), ch).toMatch(/^M/);
    }
    // Accents are dropped, as the big face drops them; the letter stays lit.
    expect(pasaPath(ruteroSvg({ code: 'C1', destination: 'X', pasa: 'ú' }))).toBe(pasaPath(ruteroSvg({ code: 'C1', destination: 'X', pasa: 'u' })));
  });

  test('the big face prints the degree sign, as 149\'s panel does', () => {
    expect(normalizeRuteroText('Est. Av. 1° de Mayo')).toBe('EST. AV. 1° DE MAYO');
  });
});

const BOOT_TIMEOUT_MS = 90_000;

async function openTabla(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await page.locator('.route-page .tabla-rutero').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('on the route page', () => {
  test.describe.configure({ timeout: 180_000 });

  test('it is off by default and on with ?flag=rutero-zonal', async ({ page }) => {
    // H629 prints its rutero in the digital format.
    await openTabla(page, '/ruta/h629/');
    await expect(page.locator('.route-rutero-tradicional .rutero-svg')).toHaveCount(0);
    await openTabla(page, '/ruta/h629/?flag=rutero-zonal');
    await expect(page.locator('.route-rutero-tradicional .rutero-svg')).toHaveCount(1);
    await expect(page.locator('.route-rutero-tradicional .rutero-caption')).toContainText('sin verificar');
  });
});
