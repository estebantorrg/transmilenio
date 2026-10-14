import { test, expect } from '@playwright/test';
import { isKnownPage } from '../server/src/known_page.ts';

/**
 * Which addresses are pages (`server/src/known_page.ts`, spec §5.5.8): the
 * shell is sent for all of them, with a 404 for the ones that are not. A wrong
 * 404 on a page that works would get it de-indexed, so the cases that only
 * exist in the bundle — zonal routes, renumbered códigos, platform pages — are
 * pinned here.
 */

const catalog = {
  routes: { G47: [], C103: [], '1-1': [], H439: [] },
  stations: { TM0025: {}, TM0069: {}, '90010': {} },
};
const known = (pathname: string) => isKnownPage(pathname, catalog);

test.describe('which addresses are pages', () => {
  test('home and the legal pages', () => {
    expect(known('/')).toBe(true);
    expect(known('/privacidad/')).toBe(true);
    expect(known('/terminos')).toBe(true);
  });

  test('a route the catalog has, however its código is cased', () => {
    expect(known('/ruta/g47/')).toBe(true);
    expect(known('/ruta/G47')).toBe(true);
    // Zonal and alimentador pages are not prerendered: no file, still a page.
    expect(known('/ruta/c103/')).toBe(true);
    expect(known('/ruta/1-1/')).toBe(true);
  });

  test('a código retired by renumbering still opens its route', () => {
    expect(known('/ruta/39/')).toBe(true);
  });

  test('an estación by the código after the last hyphen, and a platform of a merged stop', () => {
    expect(known('/estacion/calle-100-tm0025/')).toBe(true);
    expect(known('/estacion/laureles-90010/')).toBe(true);
    expect(known('/estacion/ricaurte-nqs-tm0069nqs/')).toBe(true);
  });

  test('everything made up is not a page', () => {
    expect(known('/ruta/1-1000000/')).toBe(false);
    expect(known('/estacion/nada-tm9999/')).toBe(false);
    expect(known('/cualquier/cosa')).toBe(false);
    expect(known('/ruta/g47/extra')).toBe(false);
    // `constructor` is a property of every object, and it is not a route.
    expect(known('/ruta/constructor/')).toBe(false);
  });
});
