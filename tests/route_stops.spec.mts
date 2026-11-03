import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { abordajeEn, plataformasDe, vagonTexto } from '../shared/route_stop.js';
import { platformStation, stationPlatform } from '../shared/station_platforms.js';

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

  test('the planner gets the half a route calls at, and both only for the service that links them', () => {
    // Av. Jiménez: Caracas on A–C, Calle 13 on D–E, tunnel closed. Route 5 leaves
    // from Caracas and is printed on Calle 13 too — the one way across.
    const st = { ...estacion({}), codigo: 'TM0013', wagons: { A: [ruta('C15')], B: [ruta('5')], E: [ruta('J23')] } };
    const codigos = (codigo: string, saliendo?: boolean) => plataformasDe(st, codigo, saliendo).map((p) => p.codigo);
    expect(codigos('C15')).toEqual(['TM0013CAR']);
    expect(codigos('J23', true)).toEqual(['TM0013C13']);
    expect(codigos('5', true)).toEqual(['TM0013CAR', 'TM0013C13']);
    expect(codigos('5')).toEqual(['TM0013CAR']);
    // No wagon carries it: the half is not known, and not guessed.
    expect(codigos('X99')).toEqual([]);
    expect(plataformasDe(estacion({ wagons: { A: [ruta('C15')] } }), 'C15')).toEqual([]);
  });

  test('a vagón reads as its sign does', () => {
    expect(vagonTexto('3')).toBe('Vagón 3');
    expect(vagonTexto('T7')).toBe('T7');
  });
});

test("a platform gives its own address, not the merged stop's", () => {
  const ricaurte = { codigo: 'TM0069', nombre: 'Ricaurte', direccion: 'AV. NQS - CL 10', wagons: {} };
  expect(platformStation(stationPlatform('TM0069C13'), ricaurte)?.direccion).toBe('AC 13 - KR 27');
  expect(platformStation(stationPlatform('TM0069NQS'), ricaurte)?.direccion).toBe('AV. NQS - CL 10');
});

const BOOT_TIMEOUT_MS = 90_000;

async function openRoute(page: Page, code: string): Promise<void> {
  await page.goto(`/ruta/${code}/`);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await page.locator('.route-page .timeline-stop').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('the route page hero', () => {
  test.describe.configure({ timeout: 180_000 });

  test('names the zones a zonal código runs between, and nothing on a troncal one', async ({ page }) => {
    // C124 is A124's way back, read from its pair: not "De Suba a Suba".
    await openRoute(page, 'c124');
    await expect(page.locator('.route-hero-zonas')).toHaveText('De Chapinero - Centro a Suba');
    await openRoute(page, 'f19');
    await expect(page.locator('.route-hero-zonas')).toHaveCount(0);
  });
});

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
    // Its address is the platform it boards, not the merged stop's AV. NQS.
    expect(ricaurte?.sub).toBe('AC 13 - KR 27');
    // Its map pin stands on that platform too, not on the NQS point the catalog files the stop at.
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__tmMap
            ?.getSource('selected-route-stops')
            ?._data?.features?.find((f: any) => f.properties.code === 'TM0069')?.geometry.coordinates
        )
      )
      .toEqual(stationPlatform('TM0069C13')?.coordinate);
  });

  test('a paradero gives its address and código, and the módulo where it has several', async ({ page }) => {
    await openRoute(page, 'f410');
    const parque = page.locator('.route-page .timeline-stop', { hasText: 'Parque de la 93' }).first();
    await expect(parque.locator('.timeline-stop-code')).toHaveText('AK 11 - CL 93A · # 220B00');
    await expect(parque.locator('.timeline-vagon')).toHaveText('Módulo B');
  });

  test('a zonal route is as long as one direction, not as its round-trip trace', async ({ page }) => {
    await openRoute(page, 'l800');
    // L800's trace is the whole circuit, 72 km; towards Gaviotas it runs about 36.
    const longitud = page.locator('.route-page .page-fact', { hasText: 'Longitud' }).locator('.page-fact-value');
    const km = parseFloat((await longitud.textContent()) ?? '');
    expect(km).toBeGreaterThan(30);
    expect(km).toBeLessThan(42);
  });

  /** The highlighted line on the map, in km, every path of it; null until it is drawn. */
  const drawnKm = (page: Page) =>
    page.evaluate(() => {
      const paths: number[][][] | undefined = (window as any).__tmMap?.getSource('highlight-temp-source')?._data?.features?.[0]?.geometry.coordinates;
      if (!paths?.length) return null;
      let m = 0;
      for (const path of paths) {
        for (let i = 1; i < path.length; i++) {
          const [[x0, y0], [x1, y1]] = [path[i - 1], path[i]];
          m += Math.hypot((x1 - x0) * 111320 * Math.cos((y0 * Math.PI) / 180), (y1 - y0) * 110540);
        }
      }
      return m / 1000;
    });

  test('the map draws a zonal route one way, not its round-trip trace', async ({ page }) => {
    await openRoute(page, 'l800');
    // L800's trace is the whole 72 km circuit; towards Gaviotas it runs about 36.
    await expect.poll(() => drawnKm(page), { timeout: 30_000 }).toBeGreaterThan(30);
    expect(await drawnKm(page)).toBeLessThan(42);
  });

  test('the slicer stays out of the main bundle, fetched at boot instead', () => {
    const main = fs.readFileSync(new URL('../client/src/main.ts', import.meta.url), 'utf8');
    expect(main).not.toMatch(/^import [^;]+ from '\.\/services\/trace';/m);
    expect(main).toContain("import('./services/trace')");
  });

  test('an alimentador keeps its whole trazado on the map', async ({ page }) => {
    await openRoute(page, '16-6');
    // 14.4 km round trip; cut first stop to last it would be 7.4.
    await expect.poll(() => drawnKm(page), { timeout: 30_000 }).toBeGreaterThan(12);
  });

  test('the printed table fits its labels to the face it ends up in, on the first page of a visit', async ({ page }) => {
    // The race: the printed ruteros land after the page's last redraw, and the face after them.
    // Late, but inside the client's 15 s timeout for this request (`getRuterosTradicionales`): past it, no table at all.
    await page.route(/\/api\/ruteros-tradicionales/, async (route) => {
      await new Promise((ok) => setTimeout(ok, 12_000));
      await route.continue();
    });
    await page.route(/roboto-condensed/, async (route) => {
      await new Promise((ok) => setTimeout(ok, 5_000));
      await route.continue();
    });
    await openRoute(page, 'a410');
    await page.locator('.route-page .tabla-rutero').first().waitFor({ state: 'visible', timeout: 60_000 });
    await page.evaluate(() => document.fonts.load("700 1em 'Roboto Condensed'"));
    // Labels shrunk for a wider fallback face and left so once the condensed one arrived: they fit at full size.
    const sobranAchicadas = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.route-page .tabla-rutero :is(.tr-chip-texto, .tr-destino, .tr-codigo)')]
          .filter((el) => {
            const size = el.style.fontSize;
            if (!size) return false;
            el.style.fontSize = '';
            const fits = el.scrollWidth <= el.clientWidth + 1;
            el.style.fontSize = size;
            return fits;
          })
          .map((el) => el.textContent)
      );
    await expect.poll(sobranAchicadas, { timeout: 20_000 }).toEqual([]);
  });

  test('the printed rutero is drawn abbreviated and said spelled out', async ({ page }) => {
    await openRoute(page, 'a410');
    const lourdes = page.locator('.route-page .tabla-rutero td[title="PARQUE LOURDES"]');
    await expect(lourdes.locator('[aria-hidden="true"]')).toHaveText('PQ. LOURDES');
    await expect(lourdes.locator('.tr-sr')).toHaveText('PARQUE LOURDES');
    await expect(page.locator('.route-page .tabla-rutero th[title="AVENIDA CALLE 63"]')).toHaveCount(1);
  });

  test('a printed hito that names an estación opens it, and the estación lists the route back', async ({ page }) => {
    await page.goto('/ruta/b905/');
    await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
    const hito = page.locator('.route-page .tabla-rutero a', { hasText: 'PORTAL SUBA' });
    await expect(hito).toHaveAttribute('href', /tm0045/);
    await hito.click();
    await expect(page.locator('.station-hero-name')).toHaveText('Portal Suba');
    await expect(page.locator('.station-zonales-slot a.route-tag', { hasText: /^B905$/ })).toBeVisible();
  });

  test('a stop filed with no name reads by the name in its código, at its crossing', async ({ page }) => {
    await openRoute(page, 'f63');
    const chicala = page.locator('.route-page .timeline-stop', { hasText: 'Br. Chicalá' }).first();
    await expect(chicala.locator('.timeline-stop-name')).toHaveText('Br. Chicalá');
    await expect(chicala.locator('.timeline-stop-code')).toHaveText('AV. C. de Cali - CL 53 Sur');
  });

  test('a paradero múltiple lists its módulos in its popup, with the routes at each other one', async ({ page }) => {
    await page.goto('/');
    await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
    await page.locator('#search-input').fill('123B07');
    await page.locator('#route-list .place-item').first().click();
    const bahias = page.locator('.maplibregl-popup .popup-bahia');
    await expect(bahias).toHaveCount(2);
    await expect(bahias.filter({ hasText: 'Este módulo' }).locator('.popup-bahia-letra')).toHaveText('B');
    await expect(bahias.first().locator('.route-tag').first()).toBeVisible();
    // What a rider opened it for comes first.
    await expect(page.locator('.maplibregl-popup .popup-arrivals + .popup-bahias')).toHaveCount(1);
    // The card grows upward as these land, and stays on screen.
    await expect
      .poll(async () => (await page.locator('.maplibregl-popup-content').boundingBox())?.y ?? -1, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(0);
  });
});
