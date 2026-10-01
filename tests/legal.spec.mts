/**
 * The privacy policy (spec §5.5.7): that it says what the law requires it to
 * say, that it is reachable at its own URL, and that the app opens it as a page.
 *
 * The text is checked on `shared/legal.js` directly, the same copy the
 * prerender and the app render, so a clause cannot pass here and be missing
 * from either surface. The page tests run against the dev server, where the
 * SPA fallback serves the shell for `/privacidad/` and the client's resolver
 * opens the overlay page — the path a reader clicking the link inside the app
 * takes.
 */

import { expect, test } from '@playwright/test';
import { LEGAL_DOCS, PRIVACIDAD, RESPONSABLE, TERMINOS, legalDocForPath, legalDocHtml } from '../shared/legal.js';

/** The rendered policy as plain text, the way a reader (or a regulator) reads it. */
const texto = legalDocHtml(PRIVACIDAD)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

test.describe('what the policy says', () => {
  test('names the controller: a natural person, with email and city and no postal address', () => {
    expect(RESPONSABLE.nombre).toBe('E. T. G.');
    expect(texto).toContain('E. T. G.');
    expect(texto).toContain('persona natural');
    expect(texto).toContain('estebantorrg.dev@proton.me');
    expect(texto).toContain('Bogotá');
  });

  test('is a notice as well as a policy: the aviso de privacidad heads the page', () => {
    const html = legalDocHtml(PRIVACIDAD);
    expect(html.indexOf('Aviso de privacidad')).toBeLessThan(html.indexOf('<section'));
  });

  test('covers every kind of data the service handles', () => {
    for (const item of [
      'tarjeta tu llave',
      'Tu ubicación',
      'Dirección IP',
      'Búsquedas de direcciones',
      'identificador de instalación',
      'Voz',
      'Preferencias guardadas',
    ]) {
      expect(texto, item).toContain(item);
    }
  });

  test('names every recipient that actually receives data', () => {
    for (const quien of [
      'Render Services, Inc.',
      'Cloudflare, Inc.',
      'CARTO',
      'TRANSMILENIO S.A.',
      'FOSSGIS e.V.',
      'Photon',
      'Nominatim',
      'Esri',
      'GeoJS',
      'proxy públicos',
    ]) {
      expect(texto, quien).toContain(quien);
    }
    expect(texto).toContain('artículo 26 de la Ley 1581 de 2012');
  });

  test('explains the public proxies in plain words: what they see and what they cannot', () => {
    expect(texto).toContain('Lo que ven:');
    expect(texto).toContain('Lo que no ven:');
    expect(texto).toMatch(/cifrado \(HTTPS\) de extremo a extremo/);
    expect(texto).toContain('La app para Android no usa estos proxies');
  });

  test('lists the rights and the legal response times', () => {
    expect(texto).toContain('artículo 8 de la Ley 1581 de 2012');
    expect(texto).toContain('diez (10) días hábiles');
    expect(texto).toContain('cinco (5) días hábiles');
    expect(texto).toContain('quince (15) días hábiles');
    expect(texto).toContain('ocho (8) días hábiles');
    expect(texto).toContain('Superintendencia de Industria y Comercio');
  });

  test('says how it changes and when it took effect', () => {
    expect(texto).toContain('Cambios a esta política');
    expect(texto).toContain(`Vigente desde el ${PRIVACIDAD.vigencia}`);
    expect(PRIVACIDAD.vigencia).toMatch(/^\d{1,2} de [a-z]+ de \d{4}$/);
  });

  test('keeps the meta description within what search engines show', () => {
    expect(PRIVACIDAD.descripcion.length).toBeLessThanOrEqual(158);
  });
});

test.describe('where it lives', () => {
  test('resolves with or without the trailing slash, in any case', () => {
    for (const path of ['/privacidad/', '/privacidad', '/Privacidad/', '/PRIVACIDAD']) {
      expect(legalDocForPath(path), path).toBe(PRIVACIDAD);
    }
    expect(legalDocForPath('/')).toBeNull();
    expect(legalDocForPath('/privacidad/otra/')).toBeNull();
    expect(LEGAL_DOCS).toContain(PRIVACIDAD);
  });

  test('has no in-page anchors, which the page shell would swallow', () => {
    expect(legalDocHtml(PRIVACIDAD)).not.toMatch(/href="#/);
  });

  test('is kept out of search results, and names its controller by initials only', () => {
    // The page is for the people whose data it describes; it is not a search
    // result tying a private person to the site (spec §5.5.7).
    expect(PRIVACIDAD.noindex).toBe(true);
    expect(RESPONSABLE.nombre).toMatch(/^(\p{Lu}\.\s?)+$/u);
  });
});

test.describe('the page in the app', () => {
  test('/privacidad/ opens as a page, with the masthead and the full text', async ({ page }) => {
    await page.goto('/privacidad/');
    const legal = page.locator('#legal-page');
    await expect(legal).toBeVisible();
    await expect(legal.locator('h1')).toHaveText(PRIVACIDAD.titulo);
    await expect(legal.locator('.page-bar .page-back')).toBeVisible();
    await expect(legal.locator('.page-crumbs')).toContainText('Política de privacidad');
    await expect(legal.locator('.legal-sec')).toHaveCount(PRIVACIDAD.secciones.length);
    await expect(legal.locator(`a[href="mailto:${RESPONSABLE.correo}"]`).first()).toBeVisible();
    // The map behind is inert while the page is open (spec §1.1 R5).
    await expect(page.locator('#map')).toHaveAttribute('inert', '');
  });

  test('Escape leaves the page for the map and returns the address bar to /', async ({ page }) => {
    await page.goto('/privacidad/');
    await expect(page.locator('#legal-page')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#legal-page')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('the terms of use', () => {
  const terminos = legalDocHtml(TERMINOS).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  test('live at /terminos/, indexed, beside the policy', () => {
    expect(legalDocForPath('/terminos')).toBe(TERMINOS);
    expect(LEGAL_DOCS).toEqual([PRIVACIDAD, TERMINOS]);
    // Unlike the policy, nothing here ties a person to the site beyond initials.
    expect(TERMINOS.noindex).toBeFalsy();
    expect(legalDocHtml(TERMINOS)).not.toMatch(/href="#/);
  });

  test('say what the service is not, and what it cannot excuse', () => {
    expect(terminos).toContain('No está afiliado a TRANSMILENIO S.A.');
    // Dolo and culpa grave cannot be excused in advance (Código Civil art. 1522);
    // a clause claiming otherwise would be void, so the terms must not.
    expect(terminos).toContain('dolo o culpa grave');
    expect(terminos).toContain('1522');
    expect(legalDocHtml(TERMINOS)).toContain('href="/privacidad/"');
    expect(terminos).toContain(RESPONSABLE.correo);
  });

  test('/terminos/ opens as a page', async ({ page }) => {
    await page.goto('/terminos/');
    const legal = page.locator('#legal-page');
    await expect(legal).toBeVisible();
    await expect(legal.locator('h1')).toHaveText(TERMINOS.titulo);
    await expect(legal.locator('.legal-sec')).toHaveCount(TERMINOS.secciones.length);
    await expect(legal.locator('.legal-summary')).toHaveAttribute('aria-label', 'Resumen de los términos');
  });
});

test.describe('the card consent notice', () => {
  test('sits under the card field, describes it, and links the policy (policy §2.1)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#card-balance-open').click();
    const notice = page.locator('#card-consent');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('TRANSMILENIO S.A.');
    await expect(notice).toContainText('no guardamos el número');
    await expect(notice.locator('a')).toHaveAttribute('href', '/privacidad/');
    await expect(page.locator('#card-number-input')).toHaveAttribute('aria-describedby', 'card-consent');
  });
});
