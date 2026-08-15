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
import { prepareFont, readableOn, renderRouteCard, renderStationCard, type LonLat } from './seo_og.js';
import { stopTagColor } from './services/route_colors.js';
import { carriesRutero, PANEL_CHARS, ruteroLayout, ruteroSvg } from '../../shared/rutero.js';
import type { PlanGroup } from './services/station_plan.js';
import { isZonalService } from './services/route_type.js';

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
  /** Simplified trace (spec §5.1.4). Shape varies — see {@link toPaths}. */
  trazado?: unknown;
}

/**
 * Normalises a catalog `trazado` into a list of polylines.
 *
 * The light catalog stores a **flat** polyline (`[[lon, lat], …]`) while the full
 * catalog can carry multiple paths (`[[[lon, lat], …], …]`). Assuming the latter
 * silently produced empty cards — `.flat()` yielded bare numbers and every trace
 * was dropped — so both shapes are detected rather than assumed.
 */
function toPaths(trazado: unknown): Array<Array<[number, number]>> {
  if (!Array.isArray(trazado) || trazado.length === 0) return [];
  const first = trazado[0];
  if (Array.isArray(first) && typeof first[0] === 'number') {
    return [trazado as Array<[number, number]>];
  }
  return (trazado as Array<Array<[number, number]>>).filter((p) => Array.isArray(p) && p.length > 1);
}
interface LightWagonEntry {
  id?: string;
  codigo: string;
  nombre: string;
  color?: string;
  /** Carried through `buildCatalogLight` for troncal stations — the only way to
   *  tell a feeder from a padrón troncal filed under the same wagon key. */
  sistema?: string;
  tipoServicio?: string;
}
interface LightStation {
  id?: string;
  codigo: string;
  nombre: string;
  direccion?: string;
  coordenada: string;
  sistema?: string;
  tipoServicio?: string;
  /** Wagon key → the number printed on that platform's sign, where the plano
   *  plate count backs it (`printedVagonLabels`). Absent keys get no number. */
  vagonLabels?: Record<string, string>;
  /** Wagon key → its direction groups (`buildWagonPlan`). The app's station
   *  popup reads this same field, so both surfaces face a platform one way. */
  wagonPlan?: Record<string, PlanGroup[]>;
  wagons?: Record<string, LightWagonEntry[]>;
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

/**
 * A `<title>` under the ~65 characters Google renders before it truncates.
 *
 * The subject of these pages is a name the rider searched for, so the name is
 * the one part that may never be cut — which means the *suffix* has to give. It
 * is not decoration either: "qué rutas pasan y en qué vagón" is the phrasing of
 * the query the page answers, and a truncated title drops exactly that tail,
 * off the longest names — Estación El Tiempo - Cámara De Comercio De Bogotá ran
 * to 82 characters, so everything after the station name was lost. Long names
 * therefore get a shorter suffix rather than a cut one: 16 estación titles and
 * 1 ruta title were over the limit, and all of them fit with the short form.
 */
function pageTitle(subject: string, suffix: string, shortSuffix: string, max = 65): string {
  const full = `${subject}${suffix}`;
  return full.length <= max ? full : `${subject}${shortSuffix}`;
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

/** A route's stops as [lon, lat], for the card's beads and its fallback trace. */
function stopPoints(route: LightRoute): LonLat[] {
  return (route.stops ?? [])
    .map((s) => parseCoordinate(s.coordenada))
    .filter((c): c is { lat: number; lon: number } => c !== null)
    .map((c) => [c.lon, c.lat] as LonLat);
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
const routeCardUrl = (codigo: string) => `/og/ruta/${slugify(codigo)}.png`;
const stationCardUrl = (st: LightStation) => `/og/estacion/${slugify(st.nombre)}-${slugify(st.codigo)}.png`;

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
  page: { url: string; title: string; description: string; jsonLd: object[]; body: string; ogImage?: string }
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
  // Per-page social card. A WhatsApp forward is how these pages actually spread
  // (spec §5.5.4), and every page sharing one generic logo reads as spam.
  if (page.ogImage) {
    const card = `${ORIGIN}${page.ogImage}`;
    html = html.replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${card}" />`);
    html = html.replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${card}" />`);
    html = html.replace(
      /<meta property="og:image:alt" content="[^"]*"\s*\/?>/,
      `<meta property="og:image:alt" content="${escapeHtml(page.title)}" />`
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
/* Above the shell's sidebar (z-index 100) and its sheets (110): while this panel
   exists it IS the page, and the sidebar rendering over it hid half the diagram
   for exactly the no-JS / slow-boot visitor it is there to serve. Still below the
   loading overlay (9999) so a real boot error can surface over it. */
#seo-prerender{position:absolute;inset:0;z-index:200;overflow-y:auto;background:#0C0C0C;color:#fff;
font-family:Inter,system-ui,sans-serif;padding:32px 24px 64px;line-height:1.55}
#seo-prerender .wrap{max-width:760px;margin:0 auto}
#seo-prerender a{color:#38BDF8}
#seo-prerender h1{font-size:1.9rem;margin:0 0 6px}
#seo-prerender h2{font-size:1.15rem;margin:28px 0 10px}
#seo-prerender .sub{color:rgba(255,255,255,.6);margin:0 0 20px}
#seo-prerender ol,#seo-prerender ul{padding-left:1.25rem;margin:0}
#seo-prerender li{margin:4px 0}
#seo-prerender .meta{color:rgba(255,255,255,.45);font-size:.85rem}
#seo-prerender .platform{display:grid;gap:14px;margin:14px 0 4px}
#seo-prerender .vagon{border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px 16px;background:rgba(255,255,255,.03)}
#seo-prerender .vagon-head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
#seo-prerender .vagon-name{font-size:1.02rem}
#seo-prerender .sentido{color:#38BDF8;font-size:.82rem;letter-spacing:.02em;margin-bottom:6px}
#seo-prerender .dir{margin:10px 0 0;padding-left:10px;border-left:2px solid rgba(56,189,248,.35)}
#seo-prerender .svc{list-style:none;padding:0;display:grid;gap:6px}
#seo-prerender .svc li{margin:0}
/* ── Station plan view ──────────────────────────────────────────────────────
   A drawn plan of the platforms, from the same catalog data the list below it
   carries. Wide stations scroll inside this box rather than pushing the page
   sideways; the vagón strip is one continuous bar split by separators, which is
   how the printed planos read. */
/* Scroll shadows: a plano is wide by nature, and on a phone only two vagones fit.
   The cue that there is more has to be visible without JS, so it rides on the
   scroll container's own background — the "local" layers move with the content
   and uncover the "scroll" ones only while there is something off that edge.
   (No backticks in here: this stylesheet lives in a TS template literal.) */
#seo-prerender .plano{overflow-x:auto;margin:16px 0 6px;padding-bottom:6px;
background-image:linear-gradient(to right,#0C0C0C 40%,rgba(12,12,12,0)),
linear-gradient(to left,#0C0C0C 40%,rgba(12,12,12,0)),
radial-gradient(farthest-side at 0 50%,rgba(56,189,248,.32),rgba(56,189,248,0)),
radial-gradient(farthest-side at 100% 50%,rgba(56,189,248,.32),rgba(56,189,248,0));
background-position:left center,right center,left center,right center;
background-repeat:no-repeat;background-size:36px 100%,36px 100%,14px 100%,14px 100%;
background-attachment:local,local,scroll,scroll}
#seo-prerender .plano:focus-visible{outline:2px solid #38BDF8;outline-offset:3px}
/* Three shared rows — approach chips, the platform, departure chips — so every
   plate lands on ONE line and the vagones read as one segmented platform. Each
   vagón keeps its <section> (grouping a screen reader can announce) and borrows
   the parent's rows with subgrid; laying the columns out with flex instead let
   a vagón with fewer services float its plate above its neighbours', which read
   as a broken drawing rather than a station. */
#seo-prerender .plano-cols{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(200px,1fr);
grid-template-rows:auto auto auto;min-width:min-content}
#seo-prerender .vg{display:grid;grid-row:span 3;grid-template-rows:subgrid}
#seo-prerender .vg-side{padding:0 12px}
#seo-prerender .vg-side-a{display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:10px}
#seo-prerender .vg-side-b{padding-top:10px}
/* Without subgrid the three parts cannot share rows; keep the plates on a line
   by reserving the tallest column's approach area instead of letting them drift. */
@supports not (grid-template-rows:subgrid){
  #seo-prerender .plano-cols{align-items:stretch}
  #seo-prerender .vg{display:flex;flex-direction:column}
  #seo-prerender .vg-side-a{flex:1 0 auto}
}
/* The platform itself: one bar across the station, segmented per vagón. */
#seo-prerender .vg-plate{background:rgba(56,189,248,.14);border-top:2px solid rgba(56,189,248,.55);
border-bottom:2px solid rgba(56,189,248,.55);padding:11px 10px;text-align:center;
box-shadow:inset -2px 0 0 rgba(12,12,12,.9)}
#seo-prerender .vg:last-child .vg-plate{box-shadow:none}
#seo-prerender .vg-plate .vg-name{font-size:.95rem;letter-spacing:.01em}
#seo-prerender .vg-plate .vg-sub{display:block;font-size:.72rem;color:rgba(255,255,255,.45);margin-top:2px}
/* Direction marker: a CSS triangle, so no glyph outside the shipped subset can
   turn into tofu the way U+2192 does on the social cards. */
#seo-prerender .arw{display:inline-block;width:0;height:0;margin-right:6px;
border-left:5px solid transparent;border-right:5px solid transparent;vertical-align:middle}
#seo-prerender .arw-up{border-bottom:7px solid #38BDF8}
#seo-prerender .arw-down{border-top:7px solid #38BDF8}
#seo-prerender .vg-side .sentido{margin:0 0 6px}
#seo-prerender .vg-side .svc{gap:5px}
#seo-prerender .vg-side .svc li{font-size:.85rem;color:rgba(255,255,255,.8)}
#seo-prerender .plano-note{color:rgba(255,255,255,.45);font-size:.8rem;margin:2px 0 0}
@media (max-width:560px){#seo-prerender .vg{flex-basis:170px;min-width:170px}}
/* ── El rutero ──────────────────────────────────────────────────────────────
   The bus's own LED destination sign. The frame is its black bezel; the sign
   inside is a dot grid (shared/rutero.js), so it scales as one image and can
   never reflow into text. Duplicated from the app's stylesheet on purpose —
   this panel ships before any stylesheet of ours is guaranteed to have loaded,
   and the four rules are the frame, not the drawing. */
#seo-prerender .rutero{margin:0 0 18px}
#seo-prerender .rutero-frame{border-radius:8px;padding:5px;overflow:hidden;
background:linear-gradient(180deg,#23262b,#0d0f12);
box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 8px 22px rgba(0,0,0,.55)}
#seo-prerender .rutero-svg{display:block;width:100%;height:auto;border-radius:3px}
#seo-prerender .rutero figcaption{margin:0 0 7px;font-size:.72rem;letter-spacing:.06em;
text-transform:uppercase;color:rgba(255,255,255,.45)}
#seo-prerender .chip{display:inline-block;min-width:52px;text-align:center;padding:2px 8px;border-radius:7px;font-size:.82rem;margin-right:8px}
#seo-prerender nav{font-size:.85rem;margin-bottom:18px;color:rgba(255,255,255,.45)}
/* Injected by the client once the map is live (revealPrerenderedPanel in
   main.ts) — never present without JS, because without JS there is no map to
   switch to. Sticky so the way out is on screen wherever the reader has
   scrolled to. */
#seo-prerender .seo-dismiss{position:sticky;top:-32px;z-index:1;display:flex;justify-content:flex-end;
margin:-32px -24px 10px;padding:10px 24px;background:linear-gradient(#0C0C0C 70%,rgba(12,12,12,0))}
#seo-prerender .seo-dismiss button{font:inherit;font-size:.85rem;color:#0C0C0C;background:#38BDF8;
border:0;border-radius:999px;padding:7px 16px;cursor:pointer}
#seo-prerender .seo-dismiss button:hover{background:#7DD3FC}
#seo-prerender .seo-dismiss button:focus-visible{outline:2px solid #fff;outline-offset:2px}
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

  const title = pageTitle(`Ruta ${codigo} ${name}`, ' — paradas, recorrido y horarios', ' — paradas y horarios');
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

  // El rutero — the LED sign the bus carries — drawn from the same dot-matrix
  // font the app uses (`shared/rutero.js`, spec §5.5.5). It is the first thing
  // on the page because it is the thing a rider standing at the andén is trying
  // to match, and it is *content*, not decoration: the destination is spelled
  // exactly as the panel spells it, which is often not how the catalog does.
  //
  // Gated per variant, never on `variants[0]`: a código can exist in both
  // networks at once — `7` is a ruta fácil *and* a zonal service — and which of
  // them lands first in the catalog is not a fact about the fleet.
  const signVariants = variants.filter((variant) => carriesRutero(variant.tipoServicio));
  // One panel width for every sign on the page: a rutero is fixed hardware, the
  // same number of LEDs whichever way the bus points, so per-direction sizing
  // drew the two sentidos of ruta 1 at visibly different scales.
  const panelChars = signVariants.reduce(
    (max, variant) =>
      Math.max(max, ruteroLayout(codigo, tidy(variant.destination) || tidy(variant.nombre)).columns),
    PANEL_CHARS
  );
  const ruteros = signVariants
        .map(
          (variant, i) => `<figure class="rutero">
<figcaption>Hacia ${escapeHtml(tidy(variant.destination) || '?')}</figcaption>
<div class="rutero-frame">${ruteroSvg({
            code: codigo,
            destination: tidy(variant.destination) || tidy(variant.nombre),
            panelChars,
            uid: `${slugify(codigo)}-${i}`,
            label: `Rutero de la ruta ${codigo} hacia ${tidy(variant.destination)}`,
          })}</div>
</figure>`
        )
        .join('\n');

  const body = `${PRERENDER_STYLE}
<main id="seo-prerender"><div class="wrap">
${breadcrumbHtml(trail)}
<h1>Ruta ${escapeHtml(codigo)} · ${escapeHtml(name)}</h1>
<p class="sub">Servicio troncal de TransMilenio en Bogotá. Recorrido, paradas y horarios en ambos sentidos.</p>
${ruteros ? `<h2>Rutero</h2>
<p class="meta">Tal como se ve en el bus: el letrero LED sobre el parabrisas, un sentido por letrero.</p>
${ruteros}` : ''}
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

  return { url, title, description, jsonLd, body, ogImage: routeCardUrl(codigo) };
}

// ─── Platform model ───────────────────────────────────────
/**
 * What an official "plano de ubicación" actually encodes: which services board
 * from which vagón, and **which way each vagón faces**. The first half is in the
 * catalog already (`station.wagons`); the second is not, but it is derivable —
 * a service's direction of travel *at this station* is the bearing from here to
 * its next stop, so averaging that across a vagón's services orients the vagón.
 *
 * Derived rather than scraped on purpose: the published planos are raster JPGs
 * stamped "versión noviembre de 2024", while this recomputes from whatever the
 * catalog last synced (spec §4.3) — the diagram cannot go stale on its own.
 */
interface PlatformService {
  codigo: string;
  destino: string;
  color?: string;
  href?: string;
  /** Drives the chip colour: the ruta fácil / corridor rules are network-aware. */
  zonal?: boolean;
}
interface PlatformDirection {
  /** Spanish cardinal for the way these services leave, when derivable. */
  sentido: string | null;
  /**
   * These services END at this station. They are filed on the platform and do
   * arrive at it, but a rider cannot board them toward anywhere — so they are
   * never given a cardinal. Falling back to the bearing of the leg *into* the
   * station (what a route's last stop otherwise gets) printed "sentido sur" at
   * Portal Usme over a list of services whose destination *is* Portal Usme:
   * southbound service advertised at the point where southbound service ends.
   * 177 of 1 755 wagon-filed services across 33 of the 139 stations, nearly all
   * of them at portals.
   */
  arrival?: boolean;
  services: PlatformService[];
}
interface PlatformVagon {
  /** The number printed on the platform sign, or null when it can't be trusted. */
  label: string | null;
  directions: PlatformDirection[];
}

/**
 * The platform plan the light catalog ships for this station (`buildWagonPlan`,
 * spec §5.5.4): wagon key → its direction groups, each carrying the route
 * variant ids that board it. Read, never re-derived — the app's station popup
 * reads the same field, and a platform the two surfaces face different ways is
 * worse than one neither labels. The bearings, the axis split and the terminus
 * rule all live in `services/station_plan.ts`.
 */
function buildPlatform(
  station: LightStation,
  routeIndex: Map<string, string>
): { vagones: PlatformVagon[]; unassigned: PlatformDirection[]; feeders: PlatformService[] } {
  const vagones: PlatformVagon[] = [];
  let unassigned: PlatformDirection[] = [];
  const feeders: PlatformService[] = [];

  const entries = Object.entries(station.wagons ?? {}).sort(([a], [b]) =>
    a.localeCompare(b, 'es', { numeric: true })
  );
  // The printed vagón number, resolved against the plano plate counts in
  // `printedVagonLabels` and shipped on the station (spec §5.5.4).
  const labels = station.vagonLabels ?? {};
  const plan = station.wagonPlan ?? {};

  for (const [wagon, routes] of entries) {
    const byId = new Map<string, LightWagonEntry>();
    for (const route of routes) if (route?.id) byId.set(String(route.id), route);

    const toService = (id: string): PlatformService | null => {
      const route = byId.get(id);
      const codigo = tidy(route?.codigo);
      if (!route || !codigo) return null;
      return {
        codigo,
        destino: tidy(route.nombre),
        color: route.color,
        href: routeIndex.get(codigo.toUpperCase()),
        zonal: isZonalService(route.sistema, route.tipoServicio),
      };
    };

    const groups = (plan[wagon] ?? []).map((g) => ({
      sentido: g.sentido,
      arrival: g.arrival,
      services: g.ids.map(toService).filter((s): s is PlatformService => s !== null),
    }));

    // Wagon "0" is the pool the catalog files without a platform letter — and it
    // is NOT purely alimentadores: it holds P85/M85 at Centro Memoria, L81/D81
    // along Avenida 68, 61 troncal services across 22 stations. Sending all of
    // them to the feeder list told a rider a troncal padrón was an alimentador,
    // so the split is on `tipoServicio`, never on the wagon key (spec §5.5.4).
    if (wagon === '0') {
      const troncal: PlatformDirection[] = [];
      for (const g of groups) {
        for (const svc of g.services) if (svc.zonal) feeders.push(svc);
        const kept = g.services.filter((s) => !s.zonal);
        if (kept.length) troncal.push({ sentido: g.sentido, arrival: g.arrival, services: kept });
      }
      // Kept out of `vagones` so it takes no vagón number and no "Plataforma N"
      // ordinal: the catalog gives these no letter, and the plate comparison
      // behind `printedVagonLabels` counts lettered platforms only.
      if (troncal.length) unassigned = troncal;
    } else {
      const directions = groups.filter((g) => g.services.length > 0);
      if (directions.length) vagones.push({ label: labels[wagon] ?? null, directions });
    }
  }

  return { vagones, unassigned, feeders };
}

// ─── Estación pages ───────────────────────────────────────
function renderStation(
  station: LightStation,
  routeIndex: Map<string, string>
) {
  const url = stationUrl(station);
  const nombre = tidy(station.nombre);
  const direccion = tidy(station.direccion);
  const coord = parseCoordinate(station.coordenada);
  const platform = buildPlatform(station, routeIndex);
  const countServices = (directions: PlatformDirection[]): number =>
    directions.reduce((n, d) => n + d.services.length, 0);
  const serviceCount =
    platform.vagones.reduce((n, v) => n + countServices(v.directions), 0) +
    countServices(platform.unassigned) +
    platform.feeders.length;

  const title = pageTitle(`Estación ${nombre}`, ' — qué rutas pasan y en qué vagón', ' — rutas y vagones');
  const description = clamp(
    `Rutas que paran en la estación ${nombre} de TransMilenio` +
      `${direccion ? ` (${direccion})` : ''}, Bogotá: ` +
      `${serviceCount} servicios agrupados por vagón, con recorrido y horarios.`
  );

  const trail = [
    { name: 'Inicio', url: '/' },
    { name: `Estación ${nombre}`, url },
  ];

  const serviceRow = (svc: PlatformService): string => {
    // The app's palette, not the catalog's — see `stopTagColor`. Drawing the raw
    // catalog colour here let one código appear in two colours on one page.
    const fill = stopTagColor(svc.codigo, svc.color, svc.zonal === true);
    const chip = `<span class="chip" style="background:${fill};color:${readableOn(fill)}">${escapeHtml(svc.codigo)}</span>`;
    const label = escapeHtml(svc.destino);
    return `<li>${chip}${svc.href ? `<a href="${svc.href}">${label}</a>` : label}</li>`;
  };

  const directionHtml = (d: PlatformDirection): string => `    <div class="dir">
      ${d.arrival ? '<div class="sentido">fin de recorrido</div>' : d.sentido ? `<div class="sentido">sentido ${escapeHtml(d.sentido)}</div>` : ''}
      <ul class="svc">
${d.services.map((s) => `        ${serviceRow(s)}`).join('\n')}
      </ul>
    </div>`;

  // A drawn plan of the platforms rather than a list of them: "which side do I
  // stand on" is a spatial question, and the printed planos answer it spatially.
  // Everything drawn is catalog-derived — the vagón order, the split by sentido
  // and the services on each side. Nothing about the real geometry (distances,
  // entrances, which physical side of the street a vagón sits on) is known here,
  // so nothing about it is drawn, and the note under the plan says so.
  const sideHtml = (d: PlatformDirection, side: 'a' | 'b'): string => {
    const label = d.arrival
      ? 'fin de recorrido'
      : d.sentido
        ? `<span class="arw arw-${side === 'a' ? 'up' : 'down'}"></span>sentido ${escapeHtml(d.sentido)}`
        : 'sentido sin determinar';
    return `      <p class="sentido">${label}</p>
      <ul class="svc">
${d.services.map((s) => `        ${serviceRow(s)}`).join('\n')}
      </ul>`;
  };

  const platformSection = platform.vagones.length
    ? `<h2>Plano de la estación</h2>
<p class="meta">Servicios troncales por vagón, separados por sentido. Un vagón suele atender los dos sentidos: el rumbo indicado es el de salida hacia la siguiente parada.</p>
<div class="plano" role="group" aria-label="Plano de la estación" tabindex="0">
  <div class="plano-cols">
${platform.vagones
  .map((v, i) => {
    // No number when the catalog's platform grouping doesn't line up with the
    // signage — "Plataforma" is vague but true, whereas a wrong vagón number
    // sends a rider to the wrong side of the station.
    const name = v.label ? `Vagón ${escapeHtml(v.label)}` : `Plataforma ${i + 1}`;
    const count = v.directions.reduce((n, d) => n + d.services.length, 0);
    const [first, ...rest] = v.directions;
    return `    <section class="vg" aria-label="${escapeHtml(name)}">
    <div class="vg-side vg-side-a">
${first ? sideHtml(first, 'a') : ''}
    </div>
    <div class="vg-plate"><span class="vg-name">${name}</span><span class="vg-sub">${count} servicio${count === 1 ? '' : 's'}</span></div>
    <div class="vg-side vg-side-b">
${rest.map((d) => sideHtml(d, 'b')).join('\n')}
    </div>
    </section>`;
  })
  .join('\n')}
  </div>
</div>
<p class="plano-note">Esquema propio, derivado del catálogo oficial: el orden de los vagones y los servicios de cada sentido son los que el catálogo registra. No representa distancias, accesos ni la posición real de los andenes en la calle.</p>`
    : '';

  // Troncal services the catalog files under wagon "0". Their own block, with no
  // number of any kind: the catalog names no platform for them, and the plano is
  // the only thing that can (spec §5.5.4).
  const unassignedSection = platform.unassigned.length
    ? `<h2>${platform.vagones.length ? 'Otros servicios troncales' : 'Servicios troncales'}</h2>
<p class="meta">El catálogo no asigna vagón a estos servicios; confirma la plataforma en la señalización de la estación.</p>
<div class="platform">
  <div class="vagon">
${platform.unassigned.map(directionHtml).join('\n')}
  </div>
</div>`
    : '';

  const feederSection = platform.feeders.length
    ? `<h2>Alimentadores y servicios zonales</h2>
<ul class="svc">
${platform.feeders.map((s) => `  ${serviceRow(s)}`).join('\n')}
</ul>`
    : '';

  const wagonSections = `${platformSection}\n${unassignedSection}\n${feederSection}`.trim();

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

  // `platform` rides along so the social card renders the same model the page
  // does, computed once.
  return { url, title, description, jsonLd, body, ogImage: stationCardUrl(station), platform };
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
  await rm(path.join(CLIENT_DIST, 'og'), { recursive: true, force: true });
  await mkdir(path.join(CLIENT_DIST, 'og', 'ruta'), { recursive: true });
  await mkdir(path.join(CLIENT_DIST, 'og', 'estacion'), { recursive: true });

  // The site's Inter is a woff2 and the build image may carry no system font at
  // all — see `seo_og.ts` for why this has to happen before any card renders.
  await prepareFont(path.resolve(__dirname, '..', '..', 'client', 'public', 'fonts', 'inter-latin-var.woff2'));

  // The card backdrop is the troncal spine, not a basemap (see `seo_og.ts`).
  // Only `TRONCAL` services — including the 100+ alimentadores would draw a
  // hairball instead of a recognisable city — and every other point is dropped,
  // which is invisible at 540px wide but roughly halves the SVG each card parses.
  const backdrop: LonLat[][] = [];
  for (const [, variants] of routeCodes) {
    if (variants[0].tipoServicio !== 'TRONCAL') continue;
    for (const line of toPaths(variants[0].trazado)) {
      const thinned = line.filter((_, i) => i % 2 === 0);
      if (thinned.length > 1) backdrop.push(thinned);
    }
  }
  console.log(`[seo] backdrop     — ${backdrop.length} troncal traces`);

  const routeUrls: string[] = [];
  for (const [codigo, variants] of routeCodes) {
    const page = renderRoute(codigo, variants, stationByCode);
    const dir = path.join(CLIENT_DIST, page.url.replace(/^\/|\/$/g, ''));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), renderPage(shell, page));
    routeUrls.push(page.url);

    const primary = variants[0];
    await writeFile(
      path.join(CLIENT_DIST, routeCardUrl(codigo).replace(/^\//, '')),
      renderRouteCard({
        codigo,
        nombre: tidy(primary.nombre) || codigo,
        color: primary.color,
        origin: tidy(primary.origin),
        destination: tidy(primary.destination),
        stopCount: Math.max(...variants.map((v) => v.stops?.length ?? 0)),
        // One convention only — the card has room for "L-S 4:30 AM–11:00 PM",
        // not for that plus a truncated "D-F…" tail.
        horarios: horariosText(primary).split(' · ')[0],
        // Prefer the real trace; a route without one still gets its stop line.
        paths: toPaths(primary.trazado).length ? toPaths(primary.trazado) : [stopPoints(primary)],
        stops: stopPoints(primary),
        backdrop,
      })
    );
  }

  const stationUrls: string[] = [];
  for (const station of stations) {
    const page = renderStation(station, routeIndex);
    const dir = path.join(CLIENT_DIST, page.url.replace(/^\/|\/$/g, ''));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), renderPage(shell, page));
    stationUrls.push(page.url);

    const { vagones, unassigned, feeders } = page.platform;
    // Same palette as the page and the app (stopTagColor), so a card and the
    // page it previews cannot paint one código two different colours.
    const cardChip = (s: { codigo: string; color?: string; zonal?: boolean }) => ({
      codigo: s.codigo,
      color: stopTagColor(s.codigo, s.color, s.zonal === true),
    });
    const unassignedServices = unassigned.flatMap((d) => d.services);
    await writeFile(
      path.join(CLIENT_DIST, stationCardUrl(station).replace(/^\//, '')),
      renderStationCard({
        nombre: tidy(station.nombre),
        direccion: tidy(station.direccion),
        serviceCount:
          vagones.reduce((n, v) => n + v.directions.reduce((m, d) => m + d.services.length, 0), 0) +
          unassignedServices.length +
          feeders.length,
        vagones: vagones.map((v) => ({
          label: v.label,
          // A vagón usually serves both directions, so the card shows none rather
          // than picking one; the page carries the full per-direction split.
          sentido: v.directions.length === 1 ? v.directions[0].sentido : null,
          codigos: v.directions.flatMap((d) => d.services).map(cardChip),
        })),
        unassigned: unassignedServices.map(cardChip),
        feeders: feeders.map(cardChip),
        point: (() => {
          const c = parseCoordinate(station.coordenada);
          return c ? ([c.lon, c.lat] as LonLat) : null;
        })(),
        backdrop,
      })
    );
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
  console.log(`[seo] /og/*.png    — ${routeUrls.length + stationUrls.length} social cards`);
  console.log(`[seo] sitemap.xml  — index + 3 urlsets (${routeUrls.length + stationUrls.length + 1} URLs)`);
}

main().catch((error) => {
  console.error('[seo] prerender failed:', error);
  process.exit(1);
});
