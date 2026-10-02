import { test, expect, type Page } from '@playwright/test';
import { abordajeEn, vagonTexto } from '../shared/route_stop.js';

/**
 * The route page's stop list (spec §5.5.5): beside each estación, the vagón the
 * route boards there and the lines it meets — the two things a stop's name does
 * not say, and what a rider reading a route is actually trying to find out. It
 * used to print the catalog's TM código under every stop instead, a number no
 * sign at the station carries.
 *
 * The answer is `shared/route_stop.js`, the same for the app and the
 * prerendered page, so it is tested on its own first.
 */

const estacion = (extra: Record<string, unknown>) => ({ codigo: 'TM9999', nombre: 'Prueba', wagons: {}, ...extra });
const ruta = (codigo: string) => ({ codigo, nombre: 'x' });

test.describe('where a route boards at a stop', () => {
  test("the station's plan says which vagón", () => {
    const st = estacion({
      wagons: { A: [ruta('B75')], B: [ruta('H20')] },
      planoLayout: { rows: [{ offset: 0, vagones: [{ vagon: '2', arriba: ['B75'] }, { vagon: '1', abajo: ['H20'] }] }] },
    });
    expect(abordajeEn(st, 'B75', 'Portal Norte')?.vagon).toBe('2');
    expect(abordajeEn(st, 'H20', 'Portal Usme')?.vagon).toBe('1');
  });

  test('a código on two vagones is settled by the destination, or left unsaid', () => {
    // Ricaurte: route 4 boards Vagón 2 towards Héroes and Vagón 1 towards Portal Sur.
    const st = estacion({
      wagons: { B: [ruta('4')], C: [ruta('4')] },
      planoLayout: {
        rows: [{
          offset: 0,
          vagones: [
            { vagon: '2', arriba: ['4'], destinos: { '4': 'Héroes' } },
            { vagon: '1', abajo: ['4'], destinos: { '4': 'Portal Sur' } },
          ],
        }],
      },
    });
    expect(abordajeEn(st, '4', 'HEROES')?.vagon).toBe('2');
    // The catalog writes the destination longer than the plan does.
    expect(abordajeEn(st, '4', 'Portal Sur - JFK Coop. Financiera')?.vagon).toBe('1');
    // No destination to settle it with: neither, rather than one of the two.
    expect(abordajeEn(st, '4', undefined)?.vagon).toBeUndefined();
  });

  test("the plate answers where the plan does not, and only for one wagon", () => {
    const st = estacion({ wagons: { A: [ruta('D20')], B: [ruta('D20'), ruta('B13')] }, vagonLabels: { A: '1', B: '2' } });
    expect(abordajeEn(st, 'B13', 'Portal Norte')?.vagon).toBe('2');
    // Filed under two wagons: no single plate to read.
    expect(abordajeEn(st, 'D20', 'Portal 80')?.vagon).toBeUndefined();
  });

  test('at a stop filed as two stations, the platform the route stops at', () => {
    // Ricaurte's catalog stop: NQS on A–C, Calle 13 on D–F (station_platforms.js).
    const st = { ...estacion({}), codigo: 'TM0069', wagons: { A: [ruta('E48')], E: [ruta('F19')] } };
    expect(abordajeEn(st, 'F19', 'P. Américas')?.platform?.codigo).toBe('TM0069C13');
    expect(abordajeEn(st, 'E48', 'CAD')?.platform?.codigo).toBe('TM0069NQS');
  });

  test('a vagón reads as its sign does', () => {
    expect(vagonTexto('3')).toBe('Vagón 3');
    expect(vagonTexto('T7')).toBe('T7');
  });
});

const BOOT_TIMEOUT_MS = 90_000;

async function openRoute(page: Page, code: string): Promise<void> {
  await page.goto(`/ruta/${code}/`);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await page.locator('.route-page .timeline-stop').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('the stop list on a route page', () => {
  test.describe.configure({ timeout: 180_000 });

  test('each estación names its vagón and the lines it meets, and no catalog código', async ({ page }) => {
    await openRoute(page, 'f19');
    const stops = await page.evaluate(() =>
      [...document.querySelectorAll('.route-page .timeline-stop')].map((el) => ({
        name: el.querySelector('.timeline-stop-name')?.textContent?.trim() ?? '',
        vagon: el.querySelector('.timeline-vagon')?.textContent?.trim() ?? '',
        lines: [...el.querySelectorAll('.timeline-line-tile')].map((t) => t.textContent?.trim()),
        href: el.querySelector('.timeline-stop-name a')?.getAttribute('href') ?? '',
        sub: el.querySelector('.timeline-stop-code')?.textContent?.trim() ?? '',
      }))
    );
    expect(stops.length).toBeGreaterThan(10);
    // F19 boards Vagón 5 at Ricaurte, on the Calle 13 platform, and links there.
    const ricaurte = stops.find((s) => s.name === 'Ricaurte');
    expect(ricaurte?.vagon).toBe('Vagón 5');
    expect(ricaurte?.href).toContain('tm0069c13');
    expect(ricaurte?.lines.length).toBeGreaterThan(0);
    // Its own line is not a connection.
    expect(stops.every((s) => !s.lines.includes('F'))).toBe(true);
    // No estación prints the catalog's TM código.
    expect(stops.filter((s) => /^#\s*TM\d+/i.test(s.sub))).toEqual([]);
  });
});
