import { test, expect } from '@playwright/test';
import { slugify } from '../shared/slug.js';

/**
 * A page's address is built from its name by one rule (`shared/slug.js`), used
 * by the prerender that writes the page, the app that links and shares it, and
 * the server that redirects to it (spec §5.5.4). If it changes, every published
 * URL changes with it — so these are the addresses that exist today.
 */

test('names become the addresses the site publishes', () => {
  expect(slugify('G47')).toBe('g47');
  expect(slugify('1-1')).toBe('1-1');
  expect(slugify('Calle 146')).toBe('calle-146');
  expect(slugify('Álamos')).toBe('alamos');
  expect(slugify('Alcalá - Colegio S. Tomás Dominicos')).toBe('alcala-colegio-s-tomas-dominicos');
  expect(slugify('Ricaurte (Cl 13)')).toBe('ricaurte-cl-13');
  expect(slugify('Peñalosa')).toBe('penalosa');
  expect(slugify('Portal 20  de Julio')).toBe('portal-20-de-julio');
  expect(slugify('')).toBe('');
});
