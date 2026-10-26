import { test, expect, type Page } from '@playwright/test';

/**
 * Sharing a planned trip from the website planner (spec §5.6.7): the link
 * reopens THE option the sharer picked, says so when that option is gone, and
 * never carries the sharer's exact GPS position.
 */

test.describe.configure({ timeout: 240_000 });
const BOOT_TIMEOUT_MS = 180_000;
// Calle 100 → Portal Tunal, both estaciones, as the planner's own deep link.
const TRIP =
  '/#/plan?o=4.684501%2C-74.057666&ol=Calle+100+-+Marketmedios+%28Estacion+TM%29&oc=TM0018' +
  '&d=4.570912%2C-74.139575&dl=Portal+Tunal+%28Estacion+TM%29&dc=TM0119';

async function open(page: Page, url: string): Promise<void> {
  // A weekday noon in Bogotá: the network is in service whenever CI runs.
  await page.clock.setFixedTime(new Date('2026-10-05T12:00:00-05:00'));
  // The share button copies on a desktop pointer; keep what it copied.
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void (window as unknown as { __copied: string[] }).__copied.push(text) },
    });
  });
  await page.goto(url);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await page.locator('#planner-results .journey-option-card').first().waitFor({ state: 'visible', timeout: 60_000 });
}

/** The códigos a card rides, as the link names them. */
const viaOf = (page: Page, card: string) =>
  page.locator(card).locator('.journey-card-badge:not(.walk)').allInnerTexts().then((codes) => codes.map((c) => c.trim()).join('.'));

const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '');

test('the link reopens the option that was picked, not the first one', async ({ page }) => {
  await open(page, TRIP);
  const cards = page.locator('#planner-results .journey-option-card');
  test.skip((await cards.count()) < 2, 'this plan has a single option today');
  const second = await viaOf(page, '#planner-results .journey-option-card >> nth=1');
  const first = await viaOf(page, '#planner-results .journey-option-card >> nth=0');
  test.skip(second === first, 'the two first options ride the same códigos');

  await open(page, `${TRIP}&v=${second}`);
  await expect.poll(() => viaOf(page, '#planner-results .journey-option-card.active'), { timeout: 30_000 }).toBe(second);
  await expect(page.locator('#planner-results .planner-notice')).toHaveCount(0);

  // Shared from there, the link names that option.
  await page.locator('#planner-results .planner-share-btn').click();
  await expect.poll(() => copied(page)).toContain('/viaje?');
  const link = new URL(await copied(page));
  expect(link.searchParams.get('v')).toBe(second);

  // Opened as shared — `/viaje?…`, the address the server previews — it is the planner, on that option.
  await open(page, `${link.pathname}${link.search}`);
  await expect(page).toHaveURL(/\/#\/plan\?/);
  await expect.poll(() => viaOf(page, '#planner-results .journey-option-card.active'), { timeout: 30_000 }).toBe(second);
});

test('an option that is gone is said, and the best one shown', async ({ page }) => {
  await open(page, `${TRIP}&v=ZZ1.ZZ2`);
  await expect(page.locator('#planner-results .planner-notice')).toContainText('La opción compartida no aparece ahora');
  await expect(page.locator('#planner-results .journey-option-card').first()).toHaveClass(/\bactive\b/);
});

test("a GPS origin travels rounded and named after the nearest stop, never as the sharer's position", async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 4.684123, longitude: -74.057891 });
  await open(page, TRIP);
  await page.locator('#btn-origin-gps').click();
  await expect(page.locator('#plan-origin-input')).toHaveValue('Mi ubicación actual', { timeout: 30_000 });
  await page.locator('#btn-calculate-route').click();
  await page.locator('#planner-results .journey-option-card').first().waitFor({ state: 'visible', timeout: 60_000 });

  await page.locator('#planner-results .planner-share-btn').click();
  await expect.poll(() => copied(page)).toContain('/viaje?');
  const sp = new URL(await copied(page)).searchParams;
  expect(sp.get('o')).toBe('4.684000,-74.058000');
  expect(sp.get('ol')).toMatch(/^Cerca de |^Punto cercano$/);
  expect(sp.get('ol')).not.toContain('Mi ubicación');
  expect(sp.get('oc')).toBeNull();
});
