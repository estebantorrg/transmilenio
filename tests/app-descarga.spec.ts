import { test, expect } from '@playwright/test';

/**
 * The app's download page, `/app/` (spec §5.5.11): the address to give someone
 * who should install the app — mitrasto.app, never GitHub — with the steps
 * Android will ask for.
 */

test.describe.configure({ timeout: 240_000 });

test('the page offers the download at the site’s own address, with the install steps', async ({ page }) => {
  await page.goto('/app/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  const pagina = page.locator('.app-descarga-page');
  await expect(pagina.getByRole('heading', { level: 1 })).toHaveText('MiTrasto para Android');
  await expect(pagina.getByRole('link', { name: 'Descargar la app' })).toHaveAttribute('href', '/app/descargar');
  // Play Protect named before the rider meets it, with the button to tap.
  await expect(pagina).toContainText('«Se recomienda analizar la app», toca Analizar app');
  await expect(pagina).toContainText('mitrasto.app/app');
  await expect(page.locator('a[href*="github.com"]')).toHaveCount(0);
});

test('the map’s sidebar offers it beside Consultar saldo, and opens it in place', async ({ page }) => {
  await page.goto('/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  await page.locator('.sidebar-footer').getByRole('link', { name: 'App Android' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.locator('.app-descarga-page h1')).toHaveText('MiTrasto para Android');
});
