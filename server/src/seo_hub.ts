import { escapeHtml } from '../../shared/plano.js';

/**
 * The home page's links to every ruta and estación page (spec §5.5.4).
 *
 * The home page is the site's strongest URL and it linked to none of the 364
 * pages — not in its HTML, not once rendered (the sidebar's route rows are
 * click targets, not links) — so they were reachable only from the sitemap and
 * from each other, and sat in Search Console as "discovered, not indexed". The
 * prerender writes this list into the home page's sidebar footer, between the
 * `<!--seo-hub-->` markers in `client/index.html`: a real, visible list a rider
 * can open, not text hidden for crawlers.
 */

export interface HubLink {
  url: string;
  label: string;
}

const REGION = /<!--seo-hub-->[\s\S]*?<!--\/seo-hub-->/;

/** The list itself: rutas by código, estaciones by name. */
export function hubHtml(routes: HubLink[], stations: HubLink[]): string {
  const list = (items: HubLink[]) =>
    `<ul>${items.map((item) => `<li><a href="${escapeHtml(item.url)}">${escapeHtml(item.label)}</a></li>`).join('')}</ul>`;
  return (
    `<details class="seo-hub"><summary>Todas las rutas y estaciones</summary>` +
    `<nav aria-label="Todas las rutas y estaciones"><h2>Rutas</h2>${list(routes)}<h2>Estaciones</h2>${list(stations)}</nav>` +
    `</details>`
  );
}

/**
 * The shell with its hub region set to `html`: the list on the home page, empty
 * on every other page (a page about one route needs no 364 links). Rewrites the
 * region rather than the bare marker, so a shell that already carries a list —
 * a second prerender over the same build — gets the new one, not two.
 */
export function withHub(shell: string, html = ''): string {
  if (!REGION.test(shell)) throw new Error('client/index.html has no <!--seo-hub--><!--/seo-hub--> region.');
  // A function, not a string: a `$` in a name must not be read as a pattern.
  return shell.replace(REGION, () => `<!--seo-hub-->${html}<!--/seo-hub-->`);
}
