import { test, expect, type Page } from '@playwright/test';

/**
 * "Usar mi ubicación actual" in the planner (spec §5.2.1b, `resolveLocation` in
 * `client/src/ui/planner.ts`).
 *
 * It used to fall back to the IP's location — one point downtown for any Bogotá
 * address — and then to the city centre, so a rider whose fix failed, or who was
 * not in the city, got "Mi ubicación actual" pinned in the middle of Bogotá and
 * a trip planned from there. It now names the cause and pins nothing.
 */

test.describe.configure({ timeout: 180_000 });
const BOOT_TIMEOUT_MS = 90_000;

async function askForMyLocation(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await page.locator('#tab-planner').click();
  await page.locator('#btn-origin-gps').click();
}

test.describe('permission denied', () => {
  test('names the cause and leaves the origin empty', async ({ page }) => {
    await askForMyLocation(page);
    await expect(page.locator('#planner-results')).toContainText('Escribe una dirección o usa', { timeout: 30_000 });
    await expect(page.locator('#plan-origin-input')).not.toHaveValue('Mi ubicación actual');
    // Nothing was pinned: the link carries no origin.
    expect(new URL(page.url()).hash).not.toContain('o=');
  });
});

test.describe('a fix outside the city', () => {
  // Medellín.
  test.use({ geolocation: { latitude: 6.2442, longitude: -75.5812 }, permissions: ['geolocation'] });

  test('says so instead of moving the rider to the centre of Bogotá', async ({ page }) => {
    await askForMyLocation(page);
    await expect(page.locator('#planner-results')).toContainText('Estás fuera de Bogotá', { timeout: 30_000 });
    expect(new URL(page.url()).hash).not.toContain('o=');
  });
});

test.describe('a fix in the city', () => {
  // Parque de la 93.
  test.use({ geolocation: { latitude: 4.6767, longitude: -74.0483 }, permissions: ['geolocation'] });

  test('is used as the origin', async ({ page }) => {
    await askForMyLocation(page);
    await expect(page.locator('#plan-origin-input')).toHaveValue('Mi ubicación actual', { timeout: 30_000 });
    expect(decodeURIComponent(new URL(page.url()).hash)).toContain('o=4.676700,-74.048300');
  });
});
