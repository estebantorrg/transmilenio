/**
 * Emits crawlable static HTML for the troncal network (spec §5.5.4).
 *
 * The app is a single page with hash deep links (`#/r/<code>`), and crawlers drop
 * fragments — so until now the whole site was one indexable URL competing for one
 * generic query. Every route and station the app already knows about is a page a
 * rider searches for by name ("ruta G47", "qué rutas pasan por Portal Suba"), so
 * each one is written out as real HTML with real text in the body:
 *
 *   /ruta/<code>/                  ← one page per troncal código, BOTH directions
 *   /estacion/<slug>-<codigo>/     ← one page per troncal estación, routes by vagón
 *
 * Content comes from the same light catalog the API serves (`getCatalogLightGzip`,
 * spec §5.1.4), so the pages can never describe a network the app doesn't render.
 * The output is written *into* `client/dist` after `vite build`, which means it
 * inherits the built shell's fingerprinted asset tags and is served by the
 * existing `express.static(clientDist)` mount with no extra route (spec §5.5.4).
 *
 * Zonal routes (684) and paraderos (7 387) are deliberately NOT emitted yet: at
 * this domain's authority, thousands of near-identical thin pages read as a
 * doorway pattern and risk demoting the site rather than merely being ignored.
 * They follow once Search Console shows this batch indexing (spec §5.5.4).
 *
 * Run via `npm run build` (wired after the client build) or standalone with
 * `npm --prefix server run seo:prerender`.
 */

import zlib from 'node:zlib';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCatalogFromDisk, getCatalogLightGzip } from './services/tm_api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '..', '..', 'client', 'dist');

/** Canonical origin. Changing the domain means changing `seo/README.md`'s checklist too. */
const ORIGIN = 'https://transmilenio.onrender.com';

/** A station code of this shape is a troncal estación — the same test `buildCatalogLight` uses. */
const TRONCAL_STATION = /^TM\d+$/i;

// ─── Types (the light catalog is untyped JSON by the time it reaches us) ───
interface LightStop {
  nombre: string;
  codigo: string;
  coordenada: string;
  posicion: number;
}
interface LightRoute {
  id: string;
  codigo: string;
  nombre: string;
  color?: string;
  sistema?: string;
  tipoServicio?: string;
  horarios?: { data?: Array<{ convencion?: string; hora_inicio?: string; hora_fin?: string }> };
  origin?: string;
  destination?: string;
  stops?: LightStop[];
}
interface LightStation {
  id?: string;
  codigo: string;
  nombre: string;
  direccion?: string;
  coordenada: string;
  sistema?: string;
  tipoServicio?: string;
  wagons?: Record<string, Array<{ codigo: string; nombre: string; color?: string }>>;
}

// ─── Text helpers ─────────────────────────────────────────
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Catalog names carry upstream double spaces ("Portal 20  de Julio") that would
 *  otherwise land in a <title>. Collapse runs of whitespace for display only. */
function tidy(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Diacritic-free, lowercase, hyphenated. Mirrors `slugifyRoute` in the client. */
function slugify(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Meta descriptions are truncated by search engines past ~160 chars; do it ourselves so we control where. */
function clamp(text: string, max = 158): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, clean.lastIndexOf(' ', max - 1)).replace(/[,.;:]$/, '') + '…';
}

function parseCoordinate(value: string): { lat: number; lon: number } | null {
  const [lat, lon] = String(value || '').split(',').map((n) => Number(n.trim()));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function horariosText(route: LightRoute): string {
  const rows = route.horarios?.data ?? [];
  return rows
    .filter((r) => r?.hora_inicio && r?.hora_fin)
    .map((r) => `${r.convencion ?? ''} ${r.hora_inicio}–${r.hora_fin}`.trim())
    .join(' · ');
}

// ─── URL builders ─────────────────────────────────────────
const routeUrl = (codigo: string) => `/ruta/${slugify(codigo)}/`;
const stationUrl = (st: LightStation) => `/estacion/${slugify(st.nombre)}-${slugify(st.codigo)}/`;

// ─── Page shell ───────────────────────────────────────────
/**
 * Rewrites the built shell's head for one page and injects the crawlable body.
 *
 * The base shell points `canonical`/`og:url` at "/" so the SPA's hash deep links
 * all consolidate there. A prerendered page MUST override that with a
 * self-referencing canonical, or Google discovers every page here and indexes
 * none of them.
 */
function renderPage(
  shell: string,
  page: { url: string; title: string; description: string; jsonLd: object[]; body: string }
): string {
  const absolute = `${ORIGIN}${page.url}`;
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);

  let html = shell;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  html = html.replace(
    /<meta name="description" content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${description}" />`
  );
  html = html.replace(
    /<link rel="canonical" href="[^"]*"\s*\/?>/,
    `<link rel="canonical" href="${absolute}" />`
  );
  html = html.replace(
    /<meta property="og:url" content="[^"]*"\s*\/?>/,
    `<meta property="og:url" content="${absolute}" />`
  );
  for (const [attr, key] of [['property', 'og:title'], ['name', 'twitter:title']] as const) {
    html = html.replace(
      new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\s*/?>`),
      `<meta ${attr}="${key}" content="${title}" />`
    );
  }
  for (const [attr, key] of [['property', 'og:description'], ['name', 'twitter:description']] as const) {
    html = html.replace(
      new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\s*/?>`),
      `<meta ${attr}="${key}" content="${description}" />`
    );
  }
  // Replace the shell's site-wide WebApplication block with this page's graph.
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${JSON.stringify(page.jsonLd)}</script>`
  );

  // The prerendered body is the page until the bundle boots; `hideLoading()`
  // removes it once the map is live (client/src/main.ts). The body class is what
  // suppresses the boot overlay above it (PRERENDER_STYLE).
  html = html.replace('<body>', '<body class="seo-static">');
  return html.replace('</body>', `${page.body}\n</body>`);
}

/** Scoped styling for the prerendered panel. Inlined so it costs no extra request. */
const PRERENDER_STYLE = `<style>
/* Content-first: the shell's boot overlay is markup, not something JS adds, so a
   visitor landing here from a search result would otherwise stare at a progress
   bar while the stops sat underneath it. showBootRetry() in client/src/main.ts
   drops the body class if boot fails, which brings the overlay — the only error
   surface there is — straight back. */
body.seo-static #loading-overlay{display:none}
#seo-prerender{position:absolute;inset:0;z-index:1;overflow-y:auto;background:#0C0C0C;color:#fff;
font-family:Inter,system-ui,sans-serif;padding:32px 24px 64px;line-height:1.55}
#seo-prerender .wrap{max-width:760px;margin:0 auto}
#seo-prerender a{color:#38BDF8}
#seo-prerender h1{font-size:1.9rem;margin:0 0 6px}
#seo-prerender h2{font-size:1.15rem;margin:28px 0 10px}
#seo-prerender .sub{color:rgba(255,255,255,.6);margin:0 0 20px}
#seo-prerender ol,#seo-prerender ul{padding-left:1.25rem;margin:0}
#seo-prerender li{margin:4px 0}
#seo-prerender .meta{color:rgba(255,255,255,.45);font-size:.85rem}
#seo-prerender nav{font-size:.85rem;margin-bottom:18px;color:rgba(255,255,255,.45)}
</style>`;

function breadcrumb(trail: Array<{ name: string; url: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${ORIGIN}${item.url}`,
    })),
  };
}

function breadcrumbHtml(trail: Array<{ name: string; url: string }>): string {
  return `<nav aria-label="Ruta de navegación">${trail
    .map((item, i) =>
      i === trail.length - 1
        ? escapeHtml(item.name)
        : `<a href="${item.url}">${escapeHtml(item.name)}</a> ›`
    )
    .join(' ')}</nav>`;
}

// ─── Route pages ──────────────────────────────────────────
function renderRoute(codigo: string, variants: LightRoute[], stationByCode: Map<string, LightStation>) {
  const primary = variants[0];
  const url = routeUrl(codigo);
  const name = tidy(primary.nombre) || codigo;
  const origin = tidy(primary.origin);
  const destination = tidy(primary.destination);
  const stopCount = Math.max(...variants.map((v) => v.stops?.length ?? 0));
  const horarios = horariosText(primary);

  const title = `Ruta ${codigo} ${name} — paradas, recorrido y horarios`;
  const description = clamp(
    `Recorrido completo de la ruta ${codigo} (${name}) de TransMilenio en Bogotá: ` +
      `${stopCount} paradas${origin && destination ? ` entre ${origin} y ${destination}` : ''}.` +
      (horarios ? ` Horarios ${horarios}.` : '')
  );

  const trail = [
    { name: 'Inicio', url: '/' },
    { name: `Ruta ${codigo}`, url },
  ];

  const directions = variants
    .map((variant) => {
      const stops = variant.stops ?? [];
      const schedule = horariosText(variant);
      const items = stops
        .map((stop) => {
          const station = stationByCode.get(String(stop.codigo).toUpperCase());
          const label = escapeHtml(tidy(stop.nombre));
          const distance = formatDistance(stop.posicion);
          const linked = station ? `<a href="${stationUrl(station)}">${label}</a>` : label;
          return `<li>${linked}${distance ? ` <span class="meta">${distance}</span>` : ''}</li>`;
        })
        .join('\n');

      return `<h2>${escapeHtml(tidy(variant.origin) || '?')} &rarr; ${escapeHtml(tidy(variant.destination) || '?')}</h2>
${schedule ? `<p class="meta">Horarios: ${escapeHtml(schedule)}</p>` : ''}
<p class="meta">${stops.length} paradas</p>
<ol>
${items}
</ol>`;
    })
    .join('\n');

  const body = `${PRERENDER_STYLE}
<main id="seo-prerender"><div class="wrap">
${breadcrumbHtml(trail)}
<h1>Ruta ${escapeHtml(codigo)} · ${escapeHtml(name)}</h1>
<p class="sub">Servicio troncal de TransMilenio en Bogotá. Recorrido, paradas y horarios en ambos sentidos.</p>
${directions}
</div></main>`;

  const jsonLd: object[] = [
    breadcrumb(trail),
    {
      '@context': 'https://schema.org',
      '@type': 'BusTrip',
      name: `Ruta ${codigo} — ${name}`,
      url: `${ORIGIN}${url}`,
      provider: { '@type': 'Organization', name: 'TransMilenio' },
      ...(origin ? { departureBusStop: { '@type': 'BusStop', name: origin } } : {}),
      ...(destination ? { arrivalBusStop: { '@type': 'BusStop', name: destination } } : {}),
    },
  ];

  return { url, title, description, jsonLd, body };
}

// ─── Estación pages ───────────────────────────────────────
function renderStation(station: LightStation, routeIndex: Map<string, string>) {
  const url = stationUrl(station);
  const nombre = tidy(station.nombre);
  const direccion = tidy(station.direccion);
  const coord = parseCoordinate(station.coordenada);
  const wagons = Object.entries(station.wagons ?? {}).sort(([a], [b]) => a.localeCompare(b, 'es', { numeric: true }));
  const serviceCount = wagons.reduce((total, [, routes]) => total + routes.length, 0);

  const title = `Estación ${nombre} — qué rutas pasan y en qué vagón`;
  const description = clamp(
    `Rutas que paran en la estación ${nombre} de TransMilenio` +
      `${direccion ? ` (${direccion})` : ''}, Bogotá: ` +
      `${serviceCount} servicios agrupados por vagón, con recorrido y horarios.`
  );

  const trail = [
    { name: 'Inicio', url: '/' },
    { name: `Estación ${nombre}`, url },
  ];

  const wagonSections = wagons
    .map(([wagon, routes]) => {
      const items = routes
        .map((route) => {
          const code = String(route.codigo || '').trim();
          const target = routeIndex.get(code.toUpperCase());
          const label = `${escapeHtml(code)} &mdash; ${escapeHtml(tidy(route.nombre))}`;
          return `<li>${target ? `<a href="${target}">${label}</a>` : label}</li>`;
        })
        .join('\n');
      return `<h2>Vagón ${escapeHtml(wagon)}</h2>\n<ul>\n${items}\n</ul>`;
    })
    .join('\n');

  const body = `${PRERENDER_STYLE}
<main id="seo-prerender"><div class="wrap">
${breadcrumbHtml(trail)}
<h1>Estación ${escapeHtml(nombre)}</h1>
<p class="sub">${escapeHtml(direccion || 'Bogotá, Colombia')} · ${serviceCount} servicios de TransMilenio</p>
${wagonSections || '<p>Sin servicios registrados.</p>'}
</div></main>`;

  const jsonLd: object[] = [
    breadcrumb(trail),
    {
      '@context': 'https://schema.org',
      '@type': 'BusStop',
      name: nombre,
      url: `${ORIGIN}${url}`,
      ...(direccion
        ? {
            address: {
              '@type': 'PostalAddress',
              streetAddress: direccion,
              addressLocality: 'Bogotá',
              addressCountry: 'CO',
            },
          }
        : {}),
      ...(coord ? { geo: { '@type': 'GeoCoordinates', latitude: coord.lat, longitude: coord.lon } } : {}),
    },
  ];

  return { url, title, description, jsonLd, body };
}

// ─── Sitemaps ─────────────────────────────────────────────
function sitemapUrlset(urls: string[], lastmod: string): string {
  const entries = urls
    .map((url) => `  <url>\n    <loc>${ORIGIN}${url}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function sitemapIndex(names: string[], lastmod: string): string {
  const entries = names
    .map((name) => `  <sitemap>\n    <loc>${ORIGIN}/${name}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </sitemap>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}

// ─── Main ─────────────────────────────────────────────────
async function main(): Promise<void> {
  const shellPath = path.join(CLIENT_DIST, 'index.html');
  const shell = await readFile(shellPath, 'utf-8').catch(() => {
    throw new Error(`Built shell not found at ${shellPath} — run the client build first.`);
  });

  await loadCatalogFromDisk();
  const { gzip, count } = await getCatalogLightGzip();
  if (count === 0) {
    throw new Error('Master catalog is empty — run `npm run sync` (server) and pull Git LFS first.');
  }
  const catalog = JSON.parse(zlib.gunzipSync(gzip).toString('utf-8')).data as {
    stations: Record<string, LightStation>;
    routes: Record<string, LightRoute[]>;
  };

  // Troncal only (spec §5.5.4 phase 1).
  const stations = Object.values(catalog.stations).filter(
    (st) => TRONCAL_STATION.test(st.codigo) && Object.keys(st.wagons ?? {}).length > 0
  );
  const routeCodes = Object.entries(catalog.routes).filter(([, variants]) =>
    variants.some((v) => v.sistema === 'TransMilenio')
  );

  // Cross-link indexes: a route page links its stops, a station page links its
  // routes. Without both directions the pages are discovered but orphaned.
  const stationByCode = new Map(stations.map((st) => [st.codigo.toUpperCase(), st]));
  const routeIndex = new Map(routeCodes.map(([codigo]) => [codigo.toUpperCase(), routeUrl(codigo)]));

  await rm(path.join(CLIENT_DIST, 'ruta'), { recursive: true, force: true });
  await rm(path.join(CLIENT_DIST, 'estacion'), { recursive: true, force: true });

  const routeUrls: string[] = [];
  for (const [codigo, variants] of routeCodes) {
    const page = renderRoute(codigo, variants, stationByCode);
    const dir = path.join(CLIENT_DIST, page.url.replace(/^\/|\/$/g, ''));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), renderPage(shell, page));
    routeUrls.push(page.url);
  }

  const stationUrls: string[] = [];
  for (const station of stations) {
    const page = renderStation(station, routeIndex);
    const dir = path.join(CLIENT_DIST, page.url.replace(/^\/|\/$/g, ''));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), renderPage(shell, page));
    stationUrls.push(page.url);
  }

  // Split by type so Search Console reports an indexed-ratio per type — the only
  // signal that says whether phase 2 (zonal, paraderos) is safe to ship.
  // Written into the build output, not `seo/` — that folder is hand-maintained
  // source (spec §5.5.4), and the client-dist mount is first in the static chain
  // so these still answer at the site root.
  const lastmod = new Date().toISOString().slice(0, 10);
  await writeFile(path.join(CLIENT_DIST, 'sitemap-rutas.xml'), sitemapUrlset(routeUrls, lastmod));
  await writeFile(path.join(CLIENT_DIST, 'sitemap-estaciones.xml'), sitemapUrlset(stationUrls, lastmod));
  await writeFile(path.join(CLIENT_DIST, 'sitemap-paginas.xml'), sitemapUrlset(['/'], lastmod));
  await writeFile(
    path.join(CLIENT_DIST, 'sitemap.xml'),
    sitemapIndex(['sitemap-paginas.xml', 'sitemap-rutas.xml', 'sitemap-estaciones.xml'], lastmod)
  );

  console.log(`[seo] /ruta/*      — ${routeUrls.length} pages`);
  console.log(`[seo] /estacion/*  — ${stationUrls.length} pages`);
  console.log(`[seo] sitemap.xml  — index + 3 urlsets (${routeUrls.length + stationUrls.length + 1} URLs)`);
}

main().catch((error) => {
  console.error('[seo] prerender failed:', error);
  process.exit(1);
});
