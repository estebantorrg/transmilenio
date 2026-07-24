import { test, expect, type Page } from '@playwright/test';

/**
 * ArcGIS layer resilience (spec §4.2, §5.7 acceptance criterion 6).
 *
 * The map's default-on layers (trunk corridors, station pins) are fed by ArcGIS
 * through our API. A transient upstream failure at page-open must NOT leave them
 * missing for the session: the catalog fallback has to draw them immediately and
 * the recovery pass has to upgrade them to the real payload once upstream
 * answers again.
 */

// Boot pulls the multi-MB master catalog and the recovery pass sits behind the
// background zonal load plus a widening retry ladder, so both cases outlive the
// default per-test budget.
test.describe.configure({ timeout: 180_000 });

const BOOT_TIMEOUT_MS = 90_000;

/** Feature count of a MapLibre GeoJSON source, `-1` when the source is absent. */
async function sourceCount(page: Page, id: string): Promise<number> {
  return page.evaluate((sourceId) => {
    const map = (window as any).__tmMap;
    const source = map?.getSource(sourceId);
    return source ? (source as any)._data?.features?.length ?? 0 : -1;
  }, id);
}

async function bootApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

test('every default-on layer renders on a healthy load', async ({ page }) => {
  await bootApp(page);

  expect(await sourceCount(page, 'troncal-corridors')).toBeGreaterThan(0);
  expect(await sourceCount(page, 'stations')).toBeGreaterThan(0);
  expect(await sourceCount(page, 'troncal-routes')).toBeGreaterThan(0);
  expect(await sourceCount(page, 'zonal-routes')).toBeGreaterThan(0);

  // A symbol layer whose icon is unregistered renders nothing — the pins would
  // be invisible even with a fully loaded source (client/src/map.ts).
  const iconsReady = await page.evaluate(() => {
    const map = (window as any).__tmMap;
    return ['stop-red', 'stop-blue', 'stop-orange'].every((name) => map?.hasImage(name));
  });
  expect(iconsReady).toBe(true);
});

test('corridors and stations survive an ArcGIS outage, then recover', async ({ page }) => {
  const recovered: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('[Recovery]')) recovered.push(msg.text());
  });

  // Fail the FIRST request to each layer (plus the client's own quick retry),
  // then let the endpoint through — exactly the transient upstream blip that
  // used to cost the layer permanently.
  const remainingFailures = new Map([
    ['/api/troncal/corridors', 2],
    ['/api/troncal/stations', 2],
  ]);

  await page.route('**/api/troncal/{corridors,stations}', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const left = remainingFailures.get(path) ?? 0;
    if (left > 0) {
      remainingFailures.set(path, left - 1);
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'simulated upstream outage' }),
      });
      return;
    }
    await route.continue();
  });

  await bootApp(page);

  // Degraded boot: both layers are still drawn — corridors from the catalog
  // traces, stations from the catalog station list (spec §4.2).
  const corridorsAtBoot = await sourceCount(page, 'troncal-corridors');
  const stationsAtBoot = await sourceCount(page, 'stations');
  expect(corridorsAtBoot).toBeGreaterThan(0);
  expect(stationsAtBoot).toBeGreaterThan(0);

  // ...and the recovery pass replaces them with the real ArcGIS payload.
  await expect
    .poll(() => recovered.join('\n'), { timeout: BOOT_TIMEOUT_MS })
    .toContain('Troncal corridors restored from upstream');
  await expect
    .poll(() => recovered.join('\n'), { timeout: BOOT_TIMEOUT_MS })
    .toContain('Troncal stations restored from upstream');

  expect(await sourceCount(page, 'stations')).toBeGreaterThan(0);
  expect(await sourceCount(page, 'troncal-corridors')).toBeGreaterThan(0);
});
