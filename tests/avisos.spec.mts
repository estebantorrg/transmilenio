/**
 * Operator notices (spec §5.5.6): when one is in force, and what it does to the
 * drawn station while it is.
 *
 * The windows are the risky part. They are Bogotá time read from wherever the
 * browser happens to be, and Marly's weeknight closure crosses midnight — so
 * the edges are pinned here minute by minute, on the real notices in the file.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { avisoVigente, estadoAvisos } from '../shared/avisos.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = (p: string) => resolve(HERE, '..', p);
const { avisos } = JSON.parse(readFileSync(root('server/src/data/avisos.json'), 'utf8'));
const planos = JSON.parse(readFileSync(root('server/src/data/plano_vagones.json'), 'utf8'));

const byId = (id: string) => avisos.find((a: { id: string }) => a.id === id);
const FIN_DE_SEMANA = byId('marly-2026-09-18-cierre-fin-de-semana');
const NOCTURNO = byId('marly-cierre-nocturno');
/** A Bogotá wall-clock time as an instant. */
const bog = (local: string) => new Date(`${local}:00-05:00`);

test.describe('when a notice is in force', () => {
  test('Marly weekend closure: Friday 22:00 to Monday 04:00, edges exclusive at the end', () => {
    expect(avisoVigente(FIN_DE_SEMANA, bog('2026-09-18T21:59'))).toBe(false);
    expect(avisoVigente(FIN_DE_SEMANA, bog('2026-09-18T22:00'))).toBe(true);
    expect(avisoVigente(FIN_DE_SEMANA, bog('2026-09-20T12:00'))).toBe(true);
    expect(avisoVigente(FIN_DE_SEMANA, bog('2026-09-21T03:59'))).toBe(true);
    expect(avisoVigente(FIN_DE_SEMANA, bog('2026-09-21T04:00'))).toBe(false);
  });

  test('Marly weeknight closure: 22:00 to 04:00, belonging to the day it starts', () => {
    // Not before it takes over from the weekend closure.
    expect(avisoVigente(NOCTURNO, bog('2026-09-18T23:00'))).toBe(false);
    // Monday: nothing in the day, the window opens at 22:00 sharp.
    expect(avisoVigente(NOCTURNO, bog('2026-09-21T12:00'))).toBe(false);
    expect(avisoVigente(NOCTURNO, bog('2026-09-21T21:59'))).toBe(false);
    expect(avisoVigente(NOCTURNO, bog('2026-09-21T22:00'))).toBe(true);
    // Monday's window runs into Tuesday morning, and ends at 04:00.
    expect(avisoVigente(NOCTURNO, bog('2026-09-22T03:59'))).toBe(true);
    expect(avisoVigente(NOCTURNO, bog('2026-09-22T04:00'))).toBe(false);
    // Friday night into Saturday is Friday's window…
    expect(avisoVigente(NOCTURNO, bog('2026-09-25T23:30'))).toBe(true);
    expect(avisoVigente(NOCTURNO, bog('2026-09-26T03:00'))).toBe(true);
    // …and Saturday and Sunday nights are nobody's.
    expect(avisoVigente(NOCTURNO, bog('2026-09-26T23:30'))).toBe(false);
    expect(avisoVigente(NOCTURNO, bog('2026-09-27T23:30'))).toBe(false);
    expect(avisoVigente(NOCTURNO, bog('2026-09-28T02:00'))).toBe(false);
  });

  test('reads Bogotá time whatever instant it is handed', () => {
    // Instants whose UTC wall time lands on the other side of a window edge,
    // so a reading that forgot the offset gets both wrong.
    expect(avisoVigente(NOCTURNO, new Date('2026-09-26T08:30:00Z'))).toBe(true); // Sat 03:30 in Bogotá
    expect(avisoVigente(NOCTURNO, new Date('2026-09-22T02:30:00Z'))).toBe(false); // Mon 21:30 in Bogotá
  });

  test('a date that does not parse is never in force', () => {
    expect(avisoVigente({ ...FIN_DE_SEMANA, desde: 'mañana' }, bog('2026-09-19T12:00'))).toBe(false);
    expect(avisoVigente({ ...FIN_DE_SEMANA, hasta: 'luego' }, bog('2026-09-19T12:00'))).toBe(false);
    expect(avisoVigente({ ...NOCTURNO, franja: { desde: '22h', hasta: '04:00' } }, bog('2026-09-21T23:00'))).toBe(false);
  });

  test('merges what the notices in force close, skip and move', () => {
    const weekend = estadoAvisos(avisos, bog('2026-09-19T10:00'));
    expect(weekend.vigentes.map((a) => a.id)).toEqual([FIN_DE_SEMANA.id]);
    expect(weekend.vagones).toEqual(['2']);
    expect(weekend.accesos).toEqual(['Calle 50']);
    expect(weekend.omiten.sort()).toEqual(['B23', 'D24', 'J24', 'K23']);
    expect(weekend.traslados).toEqual({ 2: '1' });

    const night = estadoAvisos(avisos, bog('2026-09-22T23:00'));
    expect(night.vigentes.map((a) => a.id)).toEqual([NOCTURNO.id]);
    expect(night.accesos).toEqual([]);
    expect(night.omiten).toEqual([]);

    expect(estadoAvisos(avisos, bog('2026-09-22T12:00')).vigentes).toEqual([]);
  });
});

test('every notice names things its station actually has', () => {
  const wrong: string[] = [];
  for (const aviso of avisos) {
    const layout = planos.layouts?.[aviso.estacion];
    if (!layout) {
      wrong.push(`${aviso.id}: ${aviso.estacion} has no drawn layout to mark`);
      continue;
    }
    const vagones = new Set<string>();
    const codigos = new Set<string>();
    for (const row of layout.rows) {
      for (const v of row.vagones) {
        vagones.add(String(v.vagon));
        for (const c of [...(v.arriba ?? []), ...(v.abajo ?? [])]) codigos.add(String(c).toUpperCase());
      }
    }
    const calles = new Set<string>(
      (planos.detalle?.[aviso.estacion]?.columnas ?? [])
        .filter((c: { t: string }) => c.t === 'vestibulo')
        .flatMap((c: { salidas?: Array<{ calle: string }> }) => (c.salidas ?? []).map((s) => s.calle))
    );
    for (const v of aviso.cierra?.vagones ?? []) if (!vagones.has(v)) wrong.push(`${aviso.id}: no vagón ${v}`);
    for (const a of aviso.cierra?.accesos ?? []) if (!calles.has(a)) wrong.push(`${aviso.id}: no access on ${a}`);
    for (const c of aviso.omiten ?? []) if (!codigos.has(c)) wrong.push(`${aviso.id}: ${c} does not stop here`);
    for (const [de, a] of Object.entries(aviso.trasladan ?? {})) {
      if (!(aviso.cierra?.vagones ?? []).includes(de)) wrong.push(`${aviso.id}: moves from ${de}, which it does not close`);
      if (!vagones.has(a as string)) wrong.push(`${aviso.id}: moves to vagón ${a}, which does not exist`);
    }
  }
  expect(wrong).toEqual([]);
});

const BOOT_TIMEOUT_MS = 90_000;

async function openMarly(page: Page): Promise<void> {
  await page.goto('/estacion/marly-tm0006/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
  await page.locator('#station-page .popup-plano').waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('the notice on screen', () => {
  test.describe.configure({ timeout: 240_000 });

  test('in force: the notice over the plan, and the plan marked to match', async ({ page }) => {
    await page.clock.setFixedTime(bog('2026-09-19T10:00'));
    await openMarly(page);
    const pagina = page.locator('#station-page');

    const banner = pagina.locator('.station-avisos');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner.locator('.aviso-titulo')).toHaveText(FIN_DE_SEMANA.titulo);

    const vagon2 = pagina.locator('.pvg[data-vagon="2"]');
    await expect(vagon2).toHaveClass(/aviso-cerrado/);
    await expect(vagon2).toHaveAttribute('aria-label', /cerrado: sus servicios paran en el Vagón 1/);
    await expect(vagon2.locator('.aviso-nota')).toHaveText('Cerrado · use el Vagón 1');
    await expect(pagina.locator('.pvg[data-vagon="1"]')).not.toHaveClass(/aviso-cerrado/);

    await expect(pagina.locator('.pdt-vestibulo[data-acceso="Calle 50"]')).toHaveClass(/aviso-cerrado/);
    await expect(pagina.locator('.pdt-vestibulo[data-acceso="Calle 48"]')).not.toHaveClass(/aviso-cerrado/);

    const omitidos = await pagina
      .locator('.popup-plano .aviso-omite')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-route-code')).sort());
    expect(omitidos).toEqual(['B23', 'D24', 'J24', 'K23']);
    // Moved, not skipped: still boardable, next door.
    await expect(vagon2.locator('[data-route-code="F60"]')).toHaveClass(/aviso-traslado/);
    await expect(vagon2.locator('[data-route-code="F60"]')).toHaveAttribute('title', /para en el Vagón 1/);

    // The popup the page hands back to says the same.
    await pagina.getByText('Ver en el mapa').click();
    const popup = page.locator('.tm-popup');
    await expect(popup.locator('.popup-avisos .aviso-titulo')).toHaveText(FIN_DE_SEMANA.titulo);
    await expect(popup.locator('.pvg[data-vagon="2"]')).toHaveClass(/aviso-cerrado/);
    await expect(popup.locator('.popup-plano .aviso-omite')).toHaveCount(4);
  });

  test('not in force: no notice and an unmarked plan, until the minute it starts', async ({ page }) => {
    await page.clock.setFixedTime(bog('2026-09-21T21:59'));
    await openMarly(page);
    const pagina = page.locator('#station-page');

    await expect(pagina.locator('.station-avisos')).toBeHidden();
    await expect(pagina.locator('.aviso-cerrado, .aviso-omite, .aviso-traslado, .aviso-nota')).toHaveCount(0);

    // The page re-reads the notices every minute; the weeknight closure has
    // to appear on a page that was opened before it began.
    await page.clock.setFixedTime(bog('2026-09-21T22:01'));
    await expect(pagina.locator('.station-avisos .aviso-titulo')).toHaveText(NOCTURNO.titulo, { timeout: 70_000 });
    await expect(pagina.locator('.pvg[data-vagon="2"]')).toHaveClass(/aviso-cerrado/);
    // The weeknight closure skips nobody and leaves both accesses open.
    await expect(pagina.locator('.aviso-omite')).toHaveCount(0);
    await expect(pagina.locator('.pdt-vestibulo.aviso-cerrado')).toHaveCount(0);
  });
});
