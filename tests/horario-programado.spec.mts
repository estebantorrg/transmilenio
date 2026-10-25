import { test, expect, type Page } from '@playwright/test';
import {
  cadaPico,
  cadaTexto,
  hora,
  pasoTexto,
  programadoHtml,
  resumenFrecuencia,
  sentidoDe,
  type SentidoHorario,
} from '../shared/horario_programado.js';

/**
 * A zonal route's scheduled service as riders read it (`shared/horario_programado.js`,
 * spec §5.5.10): the wording both the prerendered page and the bundle's route
 * page use, and the bundle's page showing it.
 */

const dia = (o: Partial<SentidoHorario['dias']['LV']>) => ({
  desde: 0,
  salidas: 3,
  primera: 300,
  ultima: 1335,
  cada: [[2, 12, 13], [6, 7, 9], null, [5, 8, 10], null, null] as SentidoHorario['dias']['LV']['cada'],
  pasos: [[300, 1335], [304, 1339], null],
  ...o,
});
const palermo: SentidoHorario = { destino: 'Palermo', paradas: ['a', 'b', 'c'], dias: { LV: dia({}), DF: dia({ primera: 360 }) } };
const bosa: SentidoHorario = {
  destino: 'Bosa San José',
  paradas: ['c', 'b', 'a'],
  dias: { LV: dia({ cada: [null, [4, 9, 11], null, [4, 10, 11], null, null] }) },
};

test.describe('how a schedule is worded', () => {
  test('hours as the questions write them, past midnight included', () => {
    expect(hora(270)).toBe('4:30 a. m.');
    expect(hora(780)).toBe('1:00 p. m.');
    expect(hora(1452)).toBe('12:12 a. m.');
  });

  test('a period is a frequency, or the number of buses when there are too few for one', () => {
    expect(cadaTexto([5, 8, 10])).toBe('cada 8–10 min');
    expect(cadaTexto([3, 7, 7])).toBe('cada 7 min');
    expect(cadaTexto([1, null, null])).toBe('1 bus');
    // Two hours apart is not "cada 120 min" to anyone waiting.
    expect(cadaTexto([2, 90, 120])).toBe('2 buses');
    expect(cadaTexto(null)).toBeNull();
  });

  test('a variant finds its direction by destination, the Ciclovía detour none', () => {
    // The catalog spells the accent as a combining mark.
    expect(sentidoDe([palermo, bosa], 'Bosa San Jose\u0301')).toBe(bosa);
    expect(sentidoDe([palermo, bosa], 'Palermo Ciclovi\u0301a')).toBeNull();
    expect(sentidoDe(null, 'Palermo')).toBeNull();
  });

  test('the rush hour of one direction, or of all of them', () => {
    expect(cadaPico(palermo)).toBe('cada 7–10 min');
    expect(cadaPico([palermo, bosa])).toBe('cada 7–11 min');
  });

  test('a paradero gets its weekday window only', () => {
    expect(pasoTexto(palermo, 'b')).toBe('5:04 a. m. – 10:19 p. m.');
    expect(pasoTexto(palermo, 'c')).toBeNull();
    expect(pasoTexto(palermo, 'zz')).toBeNull();
  });

  test('the table: a column per day type that runs, a row per period any day runs', () => {
    const html = programadoHtml(palermo);
    expect(html).toContain('<th scope="col">Lun a vie</th><th scope="col">Dom y festivos</th>');
    expect(html).not.toContain('Sábados');
    expect(html).toContain('<th scope="row">6 a 9 a. m.</th><td>cada 7–9 min</td>');
    expect(html).not.toContain('9 a. m. a 4 p. m.');
    expect(html).toContain('<th scope="row">Primer bus</th><td>5:00 a. m.</td><td>6:00 a. m.</td>');
  });

  test('departures counted past the first stops say where, as text', () => {
    const lejos = { ...palermo, dias: { LV: dia({ desde: 1 }) } };
    expect(programadoHtml(lejos, () => '<b>Br. "Sucre"</b>')).toContain('contados en &lt;b&gt;Br. &quot;Sucre&quot;&lt;/b&gt;.');
  });

  test('the frequency question names its direction and ends once', () => {
    const r = resumenFrecuencia('731', [palermo, bosa])!;
    expect(r.pregunta).toBe('¿Cada cuánto pasa el 731?');
    expect(r.respuesta).toMatch(/^Hacia Palermo, de lunes a viernes en hora pico, el 731 pasa cada 7–10 min/);
    expect(r.respuesta.endsWith('10:15 p. m.')).toBe(true);
    expect(resumenFrecuencia('X1', [])).toBeNull();
  });
});

test.describe('on the route page', () => {
  test.describe.configure({ timeout: 240_000 });

  async function open(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: 180_000 });
  }

  test('the server hands a zonal código its directions, and a troncal one nothing', async ({ request }) => {
    const res = await request.get('/api/horario-programado/731');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.credit).toContain('CC BY 4.0');
    expect(body.sentidos.map((s: SentidoHorario) => s.destino).sort()).toEqual(['Bosa San José', 'Palermo']);
    expect((await request.get('/api/horario-programado/G47')).status()).toBe(404);
  });

  test('a zonal route says how often it comes, and when each paradero sees its first and last bus', async ({ page }) => {
    await open(page, '/ruta/731/');
    const seccion = page.locator('#route-page section[aria-labelledby="frecuencia-h"]');
    await expect(seccion.locator('.programado')).toBeVisible({ timeout: 30_000 });
    await expect(seccion.locator('thead')).toContainText('Lun a vie');
    await expect(seccion).toContainText('CC BY 4.0');
    await expect(page.locator('#route-page .timeline-stop-paso').first()).toHaveText(/\d:\d\d [ap]\. m\. – \d/);
  });

  test('a troncal route has no such section', async ({ page }) => {
    await open(page, '/ruta/g47/');
    await expect(page.locator('#route-page .route-plate')).toHaveText('G47');
    await expect(page.locator('#route-page section[aria-labelledby="frecuencia-h"]')).toHaveCount(0);
  });
});
