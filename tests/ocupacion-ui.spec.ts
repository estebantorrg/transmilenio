import { test, expect, type Page } from '@playwright/test';

/**
 * How full a live bus is, where a rider sees it (spec §5.2, `ocupacion_bus`):
 * the "Próximos a llegar" board and the bus popup. The feed is geofenced to
 * Colombia and CI is not there, so the board's answer is stubbed; the popup is
 * rendered through the function the map calls, since picking a 3D bus by pixel
 * is not something a test can do reliably.
 */

test.describe.configure({ timeout: 240_000 });
const BOOT_TIMEOUT_MS = 180_000;

async function open(page: Page, path: string): Promise<void> {
  // A weekday noon in Bogotá: inside the live-tracking hours whenever CI runs.
  await page.clock.setFixedTime(new Date('2026-10-05T12:00:00-05:00'));
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

test('the board names how full the nearest bus is, and says nothing for one that sent no reading', async ({ page }) => {
  await page.route('**/api/stop-arrivals', (route) =>
    route.fulfill({
      json: {
        success: true,
        count: 2,
        routesServing: 2,
        arrivals: [
          { codigo: 'B23', destino: 'Alcalá', color: '#00A651', type: 'troncal', etaMinutes: 3, distanceMeters: 900, busCount: 2, ocupacion: 'LLENO' },
          { codigo: 'H15', destino: 'Portal Tunal', color: '#F18500', type: 'troncal', etaMinutes: 6, distanceMeters: 2100, busCount: 1 },
        ],
      },
    })
  );
  await open(page, '/estacion/calle-146-tm0025/');
  const rows = page.locator('#station-page .station-arrivals .arr-row');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.nth(0).locator('.arr-ocupacion')).toHaveText('Lleno');
  await expect(rows.nth(0).locator('.arr-ocupacion')).toHaveClass(/ocupacion-lleno/);
  // No reading is not "empty": the row just has no level.
  await expect(rows.nth(1).locator('.arr-ocupacion')).toHaveCount(0);
});

test('the bus popup has an Ocupación row, and "Sin dato" when the bus sent none', async ({ page }) => {
  await open(page, '/');
  const rows = await page.evaluate(async () => {
    const mod = await import('/src/layers/buses.ts');
    const bus = { id: 'K10660', label: 'K10660', latitude: 4.6, longitude: -74.06, destino_limpio: 'Portal Américas' };
    const row = (html: string) => {
      const el = document.createElement('div');
      el.innerHTML = html;
      const r = el.querySelector('.bus-popup-ocupacion strong');
      return { text: r?.textContent, cls: r?.className };
    };
    return {
      lleno: row(mod.buildBusPopupHTML({ ...bus, ocupacion: 'LLENO' }, 'troncal')),
      none: row(mod.buildBusPopupHTML({ ...bus, ocupacion: null }, 'troncal')),
    };
  });
  expect(rows.lleno).toEqual({ text: 'Lleno', cls: 'ocupacion ocupacion-lleno' });
  expect(rows.none).toEqual({ text: 'Sin dato', cls: 'ocupacion ocupacion-none' });
});
