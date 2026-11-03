import { test, expect, type Page } from '@playwright/test';
import { ruteroSvg } from '../shared/rutero.js';

/**
 * The zonal LED sign (planA2 step 8): built, unverified, and held back behind
 * the `rutero-zonal` flag. Drawn from the ITS annexes — zone colour in a top
 * strip and behind the código, amber LEDs — not from a photograph.
 */

test.describe('the zonal panel', () => {
  test('carries the zone colour and amber LEDs; the troncal sign is unchanged', () => {
    const zonal = ruteroSvg({ code: 'H629', destination: 'Arborizadora Alta', zona: '#F18500', uid: 'a' });
    expect(zonal.match(/fill="#F18500"/g)).toHaveLength(2);
    expect(zonal).toContain('stroke="#ffd27a"');
    // The código is lit white on the zone colour (amber on orange could not be read),
    // and dark on a light one, where white would fade: C is yellow.
    expect(zonal).toContain('stroke="#fff"');
    expect(ruteroSvg({ code: 'C118', destination: 'Suba', zona: '#FCBD1B', uid: 'd' })).toContain('stroke="#111"');
    const troncal = ruteroSvg({ code: 'F23', destination: 'Portal Américas', uid: 'b' });
    expect(troncal).not.toContain('#ffd27a');
    expect(troncal).toContain('stroke="#e9f6ff"');
  });

  test('a colour that is not a plain hex is ignored, not written into the SVG', () => {
    const svg = ruteroSvg({ code: 'H629', destination: 'X', zona: '"/><script>', uid: 'c' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('stroke="#e9f6ff"');
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
