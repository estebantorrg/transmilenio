import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { normalizeRuteroText, RUTERO_ZONAL_NOTA, ruteroSvg } from '../shared/rutero.js';

/**
 * The zonal LED sign (planA2 step 8), on every route whose piece prints the
 * electronic layout, captioned as unverified. Shaped after photographs of zonal
 * buses: lit in the route's colour, código and destino on top, and a small
 * mixed-case line beside the código's box scrolling right to left.
 */

const pasaPath = (svg: string) => /<path id="rt-p-[^"]*" d="([^"]*)"/.exec(svg)?.[1] ?? '';

test.describe('the zonal panel', () => {
  test('the top line and the código box are lit in the zone colour, as one shape', () => {
    const zonal = ruteroSvg({ code: 'C124', destination: 'Bilbao', zona: '#FCBD1B', uid: 'a', pasa: 'Porciúncula/AK 7' });
    expect(zonal).toContain('fill="#FCBD1B"');
    // One shape for both, so no dot is drawn twice where the band and the box meet.
    expect(zonal.match(/fill="url\(#rt-z-a\)"/g)).toHaveLength(1);
    // Down the box (2 pad + 4 characters of 7 = 30 columns) to the panel's foot (22 rows).
    expect(zonal).toMatch(/<path d="M0 0H\d+V13H30V22H0Z" fill="url\(#rt-z-a\)"\/>/);
    // Without a zone, the plain panel the troncal sign has.
    const plano = ruteroSvg({ code: 'F23', destination: 'Portal Américas', uid: 'b' });
    expect(plano.match(/fill="#[0-9a-f]{6}"/gi)?.sort()).toEqual(['fill="#05080c"', 'fill="#161d26"']);
  });

  test('letters white on zone A\'s navy, dark on the other colours, as photographed', () => {
    const oscuras = (zona: string) => ruteroSvg({ code: 'X1', destination: 'X', zona, uid: 'z' }).includes('stroke="#05080c" stroke-width=".9"');
    expect(oscuras('#26358C')).toBe(false); // A720, A818, A702
    expect(oscuras('#DC0814')).toBe(true); // F918
    expect(oscuras('#FCBD1B')).toBe(true); // C124
    expect(oscuras('#009A9D')).toBe(true); // L149
  });

  test('the second line runs beside the código box, not under it', () => {
    const svg = ruteroSvg({ code: 'C124', destination: 'Bilbao', zona: '#FCBD1B', uid: 'g', pasa: 'Suba' });
    expect(svg).toContain('<rect x="30" y="13"');
    expect(svg).toContain('stroke="#e9f6ff"');
  });

  test('the barrios scroll on a smaller second line under the destino', () => {
    const one = ruteroSvg({ code: 'C124', destination: 'Bilbao', uid: 'e' });
    const two = ruteroSvg({ code: 'C124', destination: 'Bilbao', uid: 'f', pasa: 'Porciúncula/AK 7 - San Fernando/AC 72' });
    expect(one).not.toContain('rutero-pasa');
    expect(two).toContain('class="rutero-pasa"');
    expect(two).toContain('clip-path="url(#rt-c-f)"');
    // The 11-row line and the 8-row small face, three pad rows: 11 + 8 + 3.
    expect(two).toMatch(/viewBox="0 0 \d+ 22"/);
    expect(one).toMatch(/viewBox="0 0 \d+ 13"/);
  });

  test('the small face has every letter, both cases, and the digits', () => {
    for (const ch of 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZabcdefghijklmnñopqrstuvwxyz0123456789./-°') {
      expect(pasaPath(ruteroSvg({ code: 'C1', destination: 'X', pasa: ch })), ch).toMatch(/^M/);
    }
    // Accents are dropped, as the big face drops them; the letter stays lit.
    expect(pasaPath(ruteroSvg({ code: 'C1', destination: 'X', pasa: 'ú' }))).toBe(pasaPath(ruteroSvg({ code: 'C1', destination: 'X', pasa: 'u' })));
  });

  test('the small ñ is an n under a tilde that does not touch it, so it never reads as Ñ', () => {
    // Dots as "x y" pairs, from the one lit path the small line draws.
    const dots = (ch: string) => [...pasaPath(ruteroSvg({ code: 'C1', destination: 'X', pasa: ch })).matchAll(/M([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const top = Math.min(...dots('n').map(([, y]) => y)); // the n's x-height
    const ene = dots('ñ');
    // The n itself, unchanged; above it a blank row, then the tilde.
    expect(ene.filter(([, y]) => y >= top)).toEqual(dots('n'));
    expect(ene.some(([, y]) => y === top - 1)).toBe(false);
    expect(ene.some(([, y]) => y === top - 2)).toBe(true);
    // The capital wears the same tilde, over its own N.
    const tilde = (ch: string) => dots(ch).filter(([, y]) => y < top);
    expect(tilde('Ñ')).toEqual(tilde('ñ'));
    expect(dots('Ñ').filter(([, y]) => y >= top)).not.toEqual(dots('n'));
  });

  test('D, Q and B stand apart from O and 8 on the faces that draw them', () => {
    const lit = (d: string) => new Set(d.match(/M[\d.]+ [\d.]+/g));
    // One character as the destino (centred, so every one lands in the same cells), or alone on the strip.
    const big = (ch: string) => lit(/<path id="rt-l-[^"]*" d="([^"]*)"/.exec(ruteroSvg({ code: 'X', destination: ch, uid: 'd' }))?.[1] ?? '');
    const small = (ch: string) => lit(pasaPath(ruteroSvg({ code: 'X', destination: 'X', pasa: ch, uid: 'd' })));
    const apart = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length;
    // Square-cornered copies of O and 8 were 2 and 3 dots off: MODELIA read MOOELIA, B918 read 8918.
    expect(apart(big('D'), big('O'))).toBeGreaterThanOrEqual(6);
    expect(apart(big('Q'), big('O'))).toBeGreaterThanOrEqual(6);
    expect(apart(big('B'), big('8'))).toBeGreaterThanOrEqual(6);
    expect(apart(small('D'), small('O'))).toBeGreaterThanOrEqual(6);
    // The panels print 0 as a plain O (photographed): that pair is identical on purpose.
    expect(apart(big('0'), big('O'))).toBe(0);
  });

  test('the zonal panel says it is an unverified drawing, in one caption for every surface', () => {
    expect(ruteroSvg({ code: 'A818', destination: 'GALERÍAS', zona: '#26358C', uid: 'n' })).toContain('aria-label="Rutero electrónico de la ruta A818 hacia GALERÍAS, dibujo sin verificar"');
    // The troncal sign keeps its plain label.
    expect(ruteroSvg({ code: 'F23', destination: 'Portal Américas', uid: 'n' })).toContain('aria-label="Rutero: F23 PORTAL AMERICAS"');
    for (const file of ['client/src/ui/routePage.ts', 'server/src/prerender_seo.ts']) {
      const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain('${RUTERO_ZONAL_NOTA}');
      expect(source, file).not.toContain(RUTERO_ZONAL_NOTA);
    }
  });

  test('the big face prints the degree sign, as 149\'s panel does', () => {
    expect(normalizeRuteroText('Est. Av. 1° de Mayo')).toBe('EST. AV. 1° DE MAYO');
  });
});

const BOOT_TIMEOUT_MS = 90_000;

async function openTabla(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await page.locator('.route-page .tabla-rutero').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('on the route page', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a route whose piece is digital shows it to everyone; a printed table alone gets none', async ({ page }) => {
    // H629 prints its rutero in the digital format, A410 as a table.
    await openTabla(page, '/ruta/h629/');
    await expect(page.locator('.route-rutero-tradicional .rutero-svg')).toHaveCount(1);
    await expect(page.locator('.route-rutero-tradicional .rutero-caption')).toContainText('sin verificar');
    await openTabla(page, '/ruta/a410/');
    await expect(page.locator('.route-rutero-tradicional .rutero-svg')).toHaveCount(0);
  });
});
