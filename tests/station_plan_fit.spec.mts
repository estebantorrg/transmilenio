import { test, expect, type Page } from '@playwright/test';

/**
 * The column-drawn plan on an estación page fits its page as a portal's does
 * (`ui/stationPage.ts` fitPlan). It used to be drawn at one scale inside the
 * 760px text column, so Toberín's five vagones ran past the column's edge on a
 * laptop window and scrolled sideways while the page sat empty either side.
 *
 * Now: at its page scale where the view has the room, stepping out of the
 * column centred on its axis; smaller as the room shrinks, never below the
 * popup's scale of 1; scrolling inside its own box only below that — and the
 * page itself never scrolls sideways.
 */

const BOOT_TIMEOUT_MS = 90_000;

interface Fit {
  scale: number;
  left: number;
  right: number;
  overflow: number;
  pageScroll: number;
}

async function planFit(page: Page, path: string): Promise<Fit> {
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  const plano = page.locator('#station-page .station-plano > .popup-plano:not(.popup-plano-portal)');
  await plano.waitFor({ state: 'visible', timeout: 30_000 });
  // One frame for the fit and the ResizeObserver's pass after it.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('#station-page .station-plano')!;
    const p = box.querySelector<HTMLElement>(':scope > .popup-plano')!;
    const r = p.getBoundingClientRect();
    const vista = document.querySelector<HTMLElement>('#station-page')!.clientWidth || window.innerWidth;
    return {
      scale: parseFloat(getComputedStyle(box).getPropertyValue('--tm-scale')),
      left: r.left,
      right: vista - r.right,
      overflow: p.scrollWidth - p.clientWidth,
      pageScroll: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

test.describe('the column plan on an estación page', () => {
  test.describe.configure({ timeout: 180_000 });

  test.describe('on a laptop window', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('a wide station fits, centred, without scrolling', async ({ page }) => {
      // Toberín: five vagones, two crossings, a bridge.
      const fit = await planFit(page, '/estacion/e-tm0028/');
      expect(fit.overflow).toBeLessThanOrEqual(0);
      expect(fit.pageScroll).toBeLessThanOrEqual(0);
      expect(fit.scale).toBeGreaterThanOrEqual(1);
      expect(Math.abs(fit.left - fit.right)).toBeLessThanOrEqual(1);
    });
  });

  test.describe('on a narrower window', () => {
    test.use({ viewport: { width: 1024, height: 800 } });

    test('a station with the room keeps its page scale and fits', async ({ page }) => {
      const fit = await planFit(page, '/estacion/e-tm0018/');
      expect(fit.scale).toBeCloseTo(1.3, 2);
      expect(fit.overflow).toBeLessThanOrEqual(0);
      expect(fit.pageScroll).toBeLessThanOrEqual(0);
      expect(Math.abs(fit.left - fit.right)).toBeLessThanOrEqual(1);
    });

    test('a station without it shrinks to 1 and scrolls in its own box only', async ({ page }) => {
      const fit = await planFit(page, '/estacion/e-tm0028/');
      expect(fit.scale).toBeCloseTo(1, 2);
      expect(fit.pageScroll).toBeLessThanOrEqual(0);
      expect(Math.abs(fit.left - fit.right)).toBeLessThanOrEqual(1);
    });

    test('it refits when the window shrinks', async ({ page }) => {
      await planFit(page, '/estacion/e-tm0018/');
      await page.setViewportSize({ width: 800, height: 800 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const p = document.querySelector<HTMLElement>('#station-page .station-plano > .popup-plano')!;
            const r = p.getBoundingClientRect();
            return r.left >= 0 && r.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
          })
        )
        .toBe(true);
    });
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('the page never scrolls sideways', async ({ page }) => {
      const fit = await planFit(page, '/estacion/e-tm0028/');
      expect(fit.pageScroll).toBeLessThanOrEqual(0);
      expect(fit.scale).toBeGreaterThanOrEqual(1);
      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(fit.right).toBeGreaterThanOrEqual(0);
    });
  });
});
