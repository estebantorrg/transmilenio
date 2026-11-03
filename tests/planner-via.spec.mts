import { test, expect } from '@playwright/test';

/**
 * A planned ride names the streets it runs along (`renderStepViaLine`,
 * client/src/ui/planner.ts), read off the addresses of the stops it passes
 * (`corredoresRecorridos`, shared/nomenclatura.js; its rules are in
 * nomenclatura.spec.mts).
 */

test.describe.configure({ timeout: 240_000 });

// Calle 100 → Portal Tunal, both estaciones: a long ride south, by troncal or zonal.
const TRIP =
  '/#/plan?o=4.684501%2C-74.057666&ol=Calle+100+-+Marketmedios+%28Estacion+TM%29&oc=TM0018' +
  '&d=4.570912%2C-74.139575&dl=Portal+Tunal+%28Estacion+TM%29&dc=TM0119';

test('a ride says the streets it runs along', async ({ page }) => {
  // A weekday noon in Bogotá: the network is in service whenever CI runs.
  await page.clock.setFixedTime(new Date('2026-10-05T12:00:00-05:00'));
  await page.goto(TRIP);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  const card = page.locator('#planner-results .journey-option-card.active');
  await card.waitFor({ state: 'visible', timeout: 60_000 });
  // Whichever option ranks first today (H75 + H15 down AV. CARACAS, or H610 along AC 100 and AK 68).
  const via = card.locator('.journey-step-via').first();
  if (!(await via.isVisible())) await card.click();
  await expect(via).toHaveText(/^por (AV\.|AC|AK|CL|KR|DG|TV|AUTO) /);
});

test('two rides on one línea keep its colour, the second as much as the first', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-05T12:00:00-05:00'));
  await page.goto(TRIP);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  await page.locator('#planner-results .journey-option-card').first().waitFor({ state: 'visible', timeout: 60_000 });
  // H75 then H15, both línea H (orange): the second used to be drawn in a stand-in coral.
  const badge = (code: string) => page.locator('.journey-card-badge', { hasText: new RegExp(`^\\s*${code}\\s*$`) });
  const card = page.locator('#planner-results .journey-option-card').filter({ has: badge('H75') }).filter({ has: badge('H15') });
  test.skip((await card.count()) === 0, 'no H75 + H15 option today');
  const colours = await card.first().locator('.journey-card-badge:not(.walk)').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(colours).size).toBe(1);
});
