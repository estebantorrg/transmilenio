import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { movedPagePath, readPrerenderedPages } from '../server/src/page_redirect.ts';

/**
 * An address the static mounts did not serve, of a ruta or estación page that
 * exists under another one, gets a 301 there (`server/src/page_redirect.ts`,
 * spec §5.5.4) — not the shell with a 200 and a canonical to the home page,
 * which got renamed and uppercase addresses dropped from search.
 */

const pages = {
  routes: new Set(['g47', 'h439', 'f439', 'b23']),
  stationByCode: new Map([
    ['tm0025', 'calle-146-tm0025'],
    ['tm0006', 'calle-53-umb-tm0006'],
    ['tm0069nqs', 'ricaurte-nqs-tm0069nqs'],
  ]),
};

test.describe('a page that moved', () => {
  test('an uppercase or slash-less route address goes to the published one', () => {
    expect(movedPagePath('/ruta/G47/', pages)).toBe('/ruta/g47/');
    expect(movedPagePath('/ruta/G47', pages)).toBe('/ruta/g47/');
  });

  test('a renamed or misspelt estación goes to its current name, by código', () => {
    expect(movedPagePath('/estacion/marly-tm0006/', pages)).toBe('/estacion/calle-53-umb-tm0006/');
    expect(movedPagePath('/estacion/calle-100-tm0025/', pages)).toBe('/estacion/calle-146-tm0025/');
    expect(movedPagePath('/estacion/RICAURTE-TM0069NQS', pages)).toBe('/estacion/ricaurte-nqs-tm0069nqs/');
  });

  test('a retired código goes to its replacement only when there is just one', () => {
    // `39` became H439 and F439: no single answer, so no redirect.
    expect(movedPagePath('/ruta/39/', pages)).toBeNull();
  });

  test('the published address, and anything with no page, are left alone', () => {
    expect(movedPagePath('/ruta/g47/', pages)).toBeNull();
    expect(movedPagePath('/estacion/calle-146-tm0025/', pages)).toBeNull();
    expect(movedPagePath('/ruta/zzz999/', pages)).toBeNull();
    expect(movedPagePath('/estacion/no-existe-tm9999/', pages)).toBeNull();
    expect(movedPagePath('/novedades/', pages)).toBeNull();
  });

  test('the pages are read from what the prerender wrote', () => {
    const dist = mkdtempSync(path.join(tmpdir(), 'tm-dist-'));
    mkdirSync(path.join(dist, 'ruta', 'g47'), { recursive: true });
    mkdirSync(path.join(dist, 'estacion', 'calle-146-tm0025'), { recursive: true });
    const read = readPrerenderedPages(dist);
    expect([...read.routes]).toEqual(['g47']);
    expect([...read.stationByCode]).toEqual([['tm0025', 'calle-146-tm0025']]);
    // No build at all (a dev server): nothing to redirect to.
    expect(readPrerenderedPages(path.join(dist, 'nope')).routes.size).toBe(0);
  });
});
