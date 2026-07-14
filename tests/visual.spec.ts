import { test, expect } from '@chromatic-com/playwright';

test('App visual snapshot', async ({ page }) => {
  // Capture console messages from the browser
  page.on('console', (msg) => {
    console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`);
  });

  // Capture unhandled errors in the page
  page.on('pageerror', (err) => {
    console.error(`[Browser Page Error] ${err.message}`);
  });

  // Go to the client homepage
  await page.goto('/');

  // Ensure the map element is visible
  await expect(page.locator('#map')).toBeVisible();

  // Wait for the loading screen to be fully detached (removed from DOM)
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 30000 });

  // Wait a short moment to allow MapLibre map styles/tiles to settle rendering
  await page.waitForTimeout(2000);
});
