/**
 * A name as it appears in a page's address: diacritic-free, lowercase,
 * hyphenated — `Calle 146` → `calle-146`, `Álamos` → `alamos`, `TM0025` →
 * `tm0025` (spec §5.5.4).
 *
 * One copy for the three places that must agree on it: the prerender that
 * writes `/ruta/<código>/` and `/estacion/<nombre>-<código>/`, the app's links
 * and share URLs to those pages, and the server's redirects to them. The
 * prerender and the app each kept their own, and the two had already drifted in
 * how they stripped accents (same result on every name in today's catalog, but
 * nothing held them together).
 */
export function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
