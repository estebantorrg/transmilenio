import { test, expect } from '@playwright/test';

/**
 * The two tullave POI catalogues are reachable BY NAME, not only by GPS
 * proximity (spec §5.4.2b) — and each is labelled as its own kind.
 *
 * `personalizacion` is the regression this guards: it was added to the shared
 * `POINT_KINDS` vocabulary, and every lookup surface derives from that list, so
 * a surface that quietly kept its own hardcoded kind list would drop the kind
 * without failing a type check (spec §1.1 R2).
 */
test.describe('tullave POI lookup', () => {
  test('both catalogues are served and non-empty', async ({ request }) => {
    for (const path of ['/api/recarga-points', '/api/personalizacion-points']) {
      const res = await request.get(path);
      expect(res.ok(), `${path} responded ${res.status()}`).toBe(true);
      const body = await res.json();
      expect(body.success, `${path} success flag`).toBe(true);
      expect(body.count, `${path} is empty — a silently emptied catalog reads as "no points"`).toBeGreaterThan(0);
      // Every point must be placeable and nameable, or it cannot be a search hit.
      for (const point of body.points) {
        expect(Number.isFinite(point.latitud) && Number.isFinite(point.longitud)).toBe(true);
        expect(String(point.nombre).length).toBeGreaterThan(0);
      }
    }
  });

  test('a personalization point is findable by name and badged as its own kind', async ({ page }) => {
    await page.goto('/');
    await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 30000 });

    // A real point from the committed catalogue, matched on a distinctive
    // fragment of its name rather than the whole string.
    await page.locator('#search-input').fill('Centro Mayor');

    const row = page.locator('.near-row[data-kind="personalizacion"]').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText('Centro Mayor');

    // The scope chip for the kind exists and carries a non-zero hit count, i.e.
    // the kind reached the scope row rather than only the mixed preview.
    const chip = page.locator('#search-scope-chips [data-scope="personalizacion"]');
    await expect(chip).toBeVisible();
    await expect(chip).not.toBeDisabled();
  });

  test('opening hours come from the weekday field, never the Sunday one', async ({ request }) => {
    // `wks` is "Horario Domingos y Festivos" and is very often "No Opera";
    // rendering it as THE opening hours made an open counter read as closed.
    const res = await request.get('/api/personalizacion-points');
    const body = await res.json();
    const closedOnSunday = body.points.filter((p: any) => /no opera/i.test(String(p.wks ?? '')));
    expect(closedOnSunday.length, 'expected some points closed on Sundays').toBeGreaterThan(0);
    // Those same points must still advertise real weekday hours.
    for (const point of closedOnSunday) {
      expect(/no opera/i.test(String(point.hds ?? '')), `${point.nombre} has no weekday hours`).toBe(false);
    }
  });
});
