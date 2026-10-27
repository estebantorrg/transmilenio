import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { withHead } from '../server/src/seo_head.ts';

/**
 * A page's own head on the app shell (`server/src/seo_head.ts`): the prerender
 * writes it for every static page, the server for a shared trip (`/viaje?…`,
 * spec §5.6.7), whose address and labels anyone can write.
 */

const shell = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const meta = (html: string, attr: string, key: string) =>
  new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)?.[1];

test('a page gets its own title, description, canonical and preview', () => {
  const html = withHead(shell, { url: '/ruta/g47/', title: 'Ruta G47', description: 'Paradas', ogImage: '/og/ruta/g47.png' });
  expect(html).toContain('<title>Ruta G47</title>');
  expect(html).toContain('<link rel="canonical" href="https://mitrasto.app/ruta/g47/" />');
  expect(meta(html, 'name', 'description')).toBe('Paradas');
  expect(meta(html, 'property', 'og:url')).toBe('https://mitrasto.app/ruta/g47/');
  expect(meta(html, 'property', 'og:title')).toBe('Ruta G47');
  expect(meta(html, 'name', 'twitter:description')).toBe('Paradas');
  expect(meta(html, 'property', 'og:image')).toBe('https://mitrasto.app/og/ruta/g47.png');
  expect(meta(html, 'name', 'robots')).toBe('index, follow, max-image-preview:large');
});

test('a shared trip is not for search, and what its link says stays text', () => {
  const html = withHead(shell, {
    url: '/viaje?dl="><script>alert(1)</script>&x=\'',
    title: 'Cómo llegar a "><script>alert(1)</script>',
    description: "it's",
    noindex: true,
  });
  expect(meta(html, 'name', 'robots')).toBe('noindex, follow');
  expect(html).not.toContain('<script>alert(1)');
  expect(html).toContain('href="https://mitrasto.app/viaje?dl=&quot;&gt;&lt;script&gt;');
  expect(meta(html, 'name', 'description')).toBe('it&#39;s');
});

test('a $ in a title is text, not a replacement pattern', () => {
  const html = withHead(shell, { url: "/viaje?dl=$'", title: "Cómo llegar a $' $&", description: '$1', noindex: true });
  expect(html).toContain("<title>Cómo llegar a $&#39; $&amp;</title>");
  expect(meta(html, 'name', 'description')).toBe('$1');
});

test('a shell whose tag moved fails the build instead of every page keeping the home one', () => {
  const reformatted = shell.replace(/<meta name="description" content="([^"]*)"/, '<meta content="$1" name="description"');
  expect(() => withHead(reformatted, { url: '/ruta/g47/', title: 'Ruta G47', description: 'Paradas' })).toThrow('description');
});
