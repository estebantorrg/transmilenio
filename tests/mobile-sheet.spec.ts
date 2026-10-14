import { test, expect } from '@playwright/test';

/**
 * The website's bottom sheet with the keyboard up (`client/style.css`, the
 * `max-width: 768px` block; `initKeyboardAwareSheet` in `sidebar.ts`).
 *
 * Focusing a field promotes the sheet to its full detent — 92% of the screen —
 * and `--kb-inset` lifts it above the keyboard. Lifted without giving up any
 * height, the sheet's top went off the top of the screen and took the search
 * bar being typed in with it.
 */

test.describe.configure({ timeout: 180_000 });
test.use({ viewport: { width: 375, height: 812 } });

const KEYBOARD_PX = 300;

test('the search bar stays on screen when the keyboard lifts a full sheet', async ({ page }) => {
  await page.goto('/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 90_000 });

  const search = page.locator('#search-input');
  await search.focus();
  await expect(page.locator('#sidebar')).toHaveClass(/sheet-full/);
  // A headless browser has no soft keyboard; this is what `applyInset` sets.
  await page.evaluate((px) => document.documentElement.style.setProperty('--kb-inset', `${px}px`), KEYBOARD_PX);

  // Polled, not read once: the sheet slides to full (340 ms) and gives up the
  // keyboard's height (220 ms), and a reading taken mid-way catches it between.
  const sheet = page.locator('#sidebar');
  await expect.poll(async () => (await sheet.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return box ? box.y + box.height : Infinity;
    })
    .toBeLessThanOrEqual(812 - KEYBOARD_PX + 1);
  await expect.poll(async () => (await search.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
});
