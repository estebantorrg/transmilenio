import { test, expect, type Page } from '@playwright/test';

/**
 * The live wait at a trip's first boarding, on the planner's cards (spec
 * §5.6.6). The arithmetic is covered without a browser in
 * `live-boarding.spec.ts`; this is the part a rider sees: a trip leaving now
 * gets a line saying which bus they board, and a planned one does not.
 *
 * The live feed is mocked — it is geofenced to Colombia and CI is not there —
 * with one bus standing exactly at the origin station. Whatever route an
 * itinerary boards first, that bus projects onto its trace at the boarding
 * stop: it is pulling in as the rider stands there, so it is boarded and the
 * line says so — tight, not promised ("vas justo").
 */

const BOOT_TIMEOUT_MS = 90_000;
// Calle 100 → Portal Tunal, both stations, as the planner's own deep link.
const TRIP =
  '/#/plan?o=4.684501%2C-74.057666&ol=Calle+100+-+Marketmedios+%28Estacion+TM%29&oc=TM0018' +
  '&d=4.570912%2C-74.139575&dl=Portal+Tunal+%28Estacion+TM%29&dc=TM0119';
const BUS_AT_ORIGIN = { id: '1', latitude: 4.684501, longitude: -74.057666, destino_limpio: 'Prueba' };

async function openTrip(page: Page): Promise<void> {
  // A weekday noon in Bogotá, so the network is in service whenever CI runs.
  await page.clock.setFixedTime(new Date('2026-10-05T12:00:00-05:00'));
  await page.goto(TRIP);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  const cards = page.locator('#planner-results .journey-option-card');
  // The deep link restores the endpoints; ask for the plan if it did not run.
  if ((await cards.count()) === 0) await page.locator('#btn-calculate-route').click();
  await cards.first().waitFor({ state: 'visible', timeout: 30_000 });
}

test.describe('the first bus, on the planner cards', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a trip leaving now says which bus the rider boards', async ({ page }) => {
    let lookups = 0;
    await page.route('**/api/buses', async (route) => {
      lookups++;
      await route.fulfill({ json: { success: true, status: 'live', confidence: 'high', count: 1, data: [BUS_AT_ORIGIN], source: 'direct' } });
    });
    await openTrip(page);

    // The card that boards AT the origin station (another may walk to a
    // paradero the mocked bus is nowhere near, and say something else or nothing).
    const line = page.locator('#planner-results .journey-live.tight').first();
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(line.locator('.journey-live-text')).toContainText('vas justo');
    await expect(line).toHaveClass(/\btight\b/);
    await expect(line.locator('.journey-live-tag')).toHaveText('en vivo');
    // It belongs to the first ride of its card, and names that route.
    const card = line.locator('xpath=ancestor::div[contains(@class,"journey-option-card")]');
    const code = (await card.locator('.journey-card-badge:not(.walk)').first().innerText()).trim();
    await expect(line.locator('.journey-live-text')).toContainText(code);
    // One lookup per first-boarded route direction — a handful, not a fan-out.
    expect(lookups).toBeGreaterThan(0);
    expect(lookups).toBeLessThanOrEqual(8);
  });

  test('a feed that cannot be reached leaves the plan as it was', async ({ page }) => {
    await page.route('**/api/buses', (route) =>
      route.fulfill({ json: { success: true, status: 'unreachable', confidence: 'low', count: 0, data: [], source: null } })
    );
    await openTrip(page);
    // The lookups have answered (they are mocked): give the pass its turn.
    await page.waitForTimeout(1_500);
    await expect(page.locator('#planner-results .journey-option-card').first()).toBeVisible();
    await expect(page.locator('#planner-results .journey-live')).toHaveCount(0);
  });
});
