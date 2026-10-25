import { readdirSync } from 'node:fs';
import path from 'node:path';
import { codigosActuales } from '../../shared/renumeraciones.js';
import { slugify } from '../../shared/slug.js';

/**
 * Where a ruta or estación page now lives, for an address the static mounts did
 * not serve (spec §5.5.4) — answered with a 301 so the old address hands its
 * standing in search to the new one.
 *
 * Without it, such an address got the app shell with a 200 and the shell's
 * canonical (`/`): Google read it as a copy of the home page and dropped it. That
 * was every renamed estación (TM0006 Marly → Calle 53 – UMB keeps its código and
 * changes its slug), every uppercase link (`/ruta/G47/`), and every slug that was
 * never right (`/estacion/calle-100-tm0025/` is Calle 146).
 *
 * The truth is what the prerender wrote, not a recomputed name: the folders under
 * `client/dist/ruta` and `client/dist/estacion` are exactly the pages that exist,
 * platform halves and choosers included.
 */
export interface PrerenderedPages {
  /** Route slugs with a page (`g47`). */
  routes: Set<string>;
  /** Estación código (lowercase, the slug's last segment) → its page's slug. */
  stationByCode: Map<string, string>;
}

/** Read once at startup; an absent build (a dev server) just redirects nothing. */
export function readPrerenderedPages(clientDist: string): PrerenderedPages {
  const list = (dir: string): string[] => {
    try {
      return readdirSync(path.join(clientDist, dir));
    } catch {
      return [];
    }
  };
  return {
    routes: new Set(list('ruta')),
    stationByCode: new Map(list('estacion').map((slug) => [slug.slice(slug.lastIndexOf('-') + 1), slug])),
  };
}

/** The current address of the page `pathname` names, or null when it names none
 *  (or already is it). */
export function movedPagePath(pathname: string, pages: PrerenderedPages): string | null {
  let target: string | null = null;

  const ruta = /^\/ruta\/([^/]+)\/?$/.exec(pathname);
  if (ruta) {
    const slug = slugify(ruta[1]);
    if (pages.routes.has(slug)) target = `/ruta/${slug}/`;
    else {
      // A retired código opens its replacement — only when there is exactly one
      // with a page: `39` became both H439 and F439, and picking one would be a guess.
      const now = codigosActuales(ruta[1]).map(slugify).filter((s) => pages.routes.has(s));
      if (now.length === 1) target = `/ruta/${now[0]}/`;
    }
  }

  // The código is whatever follows the last hyphen, as `isKnownPage` reads it.
  const estacion = /^\/estacion\/(?:.+-)?([^/-]+)\/?$/.exec(pathname);
  if (estacion) {
    const slug = pages.stationByCode.get(slugify(estacion[1]));
    if (slug) target = `/estacion/${slug}/`;
  }

  return target && target !== pathname ? target : null;
}
