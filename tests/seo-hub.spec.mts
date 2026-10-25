import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { hubHtml, withHub } from '../server/src/seo_hub.ts';

/**
 * The home page links every ruta and estación page (`server/src/seo_hub.ts`,
 * spec §5.5.4) — before, it linked none, and the pages sat in Search Console as
 * "discovered, not indexed". The prerender fills the region in the built shell
 * on the home page and empties it on every other page.
 */

const shell = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const hub = hubHtml([{ url: '/ruta/g47/', label: 'G47 · Portal Sur' }], [{ url: '/estacion/calle-146-tm0025/', label: 'Calle 146' }]);

test.describe('the home page hub', () => {
  test('the shell carries the region the prerender fills', () => {
    expect(shell).toContain('<!--seo-hub--><!--/seo-hub-->');
  });

  test('is real links, in a list a rider can open', () => {
    expect(hub).toContain('<details class="seo-hub"><summary>Todas las rutas y estaciones</summary>');
    expect(hub).toContain('<a href="/ruta/g47/">G47 · Portal Sur</a>');
    expect(hub).toContain('<a href="/estacion/calle-146-tm0025/">Calle 146</a>');
  });

  test('fills the home page once, and leaves every other page without it', () => {
    const home = withHub(shell, hub);
    expect(home.match(/class="seo-hub"/g)).toHaveLength(1);
    // A second prerender over an already-built home page replaces, not appends.
    expect(withHub(home, hub).match(/class="seo-hub"/g)).toHaveLength(1);
    expect(withHub(home)).not.toContain('seo-hub"');
  });

  test('a name is text, never markup or a replacement pattern', () => {
    const odd = hubHtml([{ url: '/ruta/x/', label: `$& <b>"x"</b>` }], []);
    expect(odd).toContain('$&amp; &lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    expect(withHub(shell, odd)).toContain('$&amp; &lt;b&gt;');
  });
});
