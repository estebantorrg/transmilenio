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
import { stopTagColor, TRONCAL_COLORS } from './services/route_colors.js';
import { carriesRutero, PANEL_CHARS, ruteroLayout, ruteroSvg } from '../../shared/rutero.js';
import { STATION_PLATFORMS, platformStation } from '../../shared/station_platforms.js';
import { buildSheetPlano } from '../../shared/plano.js';
import type { PlanGroup } from './services/station_plan.js';
import { isZonalService } from './services/route_type.js';
import { isTroncalStationCode } from './services/station_registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '..', '..', 'client', 'dist');

/** Canonical origin. Changing the domain means changing `seo/README.md`'s checklist too. */
const ORIGIN = 'https://transmilenio.onrender.com';


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
  /** The troncal this station sits on and its letter (`stationCorridor`),
   *  which is what colours this page and names its corridor. */
  corridor?: { nombre: string; letra?: string; sentidos?: { positive: string; negative: string } };
  /** The station drawn from its own plano, where the sheet has been read
   *  (`planoLayout`), and the furniture around it where that has been read
   *  too (`planoDetalle`). Both ride on the light catalog already — this
   *  page simply never drew them, which is why a search result opened on a
   *  station that disagreed with the app about how many vagones it has. */
  planoLayout?: unknown;
  planoDetalle?: unknown;
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

/**
 * Scoped styling for the prerendered panel. Inlined so it costs no extra
 * request — and because this body ships before any stylesheet of ours is
 * guaranteed to have loaded, which is the whole point of prerendering it.
 *
 * It is deliberately the *same page* the bundle draws (`client/style.css`, spec
 * §5.5.5/§5.5.6): an accent rail under the masthead, a hero whose plate carries
 * the route's own colour, a hairline ficha strip read across, and sections
 * separated by rules rather than a stack of identical cards. The values are
 * literals rather than the app's `:root` tokens because nothing guarantees those
 * exist yet; where the two must agree — the accent, the surfaces, the rutero
 * bezel — they are the same numbers on purpose.
 */
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
#seo-prerender{--accent:#D8102D;position:absolute;inset:0;z-index:200;overflow-y:auto;background:#0C0C0C;color:#fff;
font-family:Inter,system-ui,sans-serif;padding:0 0 64px;line-height:1.55}
/* The subject's colour bleeding into the top of the page, the same two-layer
   wash the bundle draws (client/style.css): a short stronger band so the dark
   corridors register at all, then a long soft tail. Attached "local" so it rides
   with the content instead of staying pinned while the page scrolls under it.
   (No backticks in this stylesheet: it lives in a TS template literal.) */
#seo-prerender{background-image:
linear-gradient(180deg,color-mix(in srgb,var(--accent) 36%,transparent),transparent 200px),
linear-gradient(180deg,color-mix(in srgb,var(--accent) 16%,transparent),transparent 470px);
background-repeat:no-repeat;background-attachment:local,local}
#seo-prerender .rail{height:3px;background:var(--accent)}
#seo-prerender .wrap{max-width:760px;margin:0 auto;padding:0 24px}
#seo-prerender a{color:inherit}
#seo-prerender .crumbs{padding:16px 0 0;font-size:.75rem;color:rgba(255,255,255,.38)}
#seo-prerender .crumbs a{color:rgba(255,255,255,.6);text-decoration:none}
#seo-prerender .crumbs a:hover{color:#fff;text-decoration:underline}
/* ── Hero ───────────────────────────────────────────────────────────────────
   The código at the size it is on the bus, in the route's own colour, beside the
   name — not a pill above a centred headline. The inner hairline keeps a black
   RF badge a shape against this page's own black. */
#seo-prerender .hero{display:flex;align-items:flex-start;gap:16px;padding:18px 0 4px}
#seo-prerender .plate{display:inline-flex;align-items:center;justify-content:center;min-width:74px;
padding:12px 14px;border-radius:8px;background:var(--accent);color:#fff;font-size:1.5rem;font-weight:800;
line-height:1;font-variant-numeric:tabular-nums;flex:none;
box-shadow:inset 0 0 0 1px rgba(255,255,255,.18),0 6px 18px rgba(0,0,0,.45)}
#seo-prerender h1{font-size:1.6rem;font-weight:700;line-height:1.15;letter-spacing:-.02em;margin:0}
#seo-prerender .kind{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0 0;
font-size:.8rem;color:rgba(255,255,255,.6)}
#seo-prerender .tag{padding:2px 9px;border:1px solid rgba(255,255,255,.14);border-radius:999px;
font-size:.7rem;font-weight:700;letter-spacing:.08em;color:#fff}
/* The corridor is marked with its colour, never set in it: half this palette is
   dark (Caracas navy, Carrera 7 purple) and would be unreadable on this page. */
#seo-prerender .kind::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--accent);
box-shadow:0 0 0 1px rgba(255,255,255,.18);flex:none}
#seo-prerender .sub{margin:7px 0 0;color:rgba(255,255,255,.6)}
#seo-prerender .chips{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0;padding:0;list-style:none}
#seo-prerender .chips li{padding:3px 10px;border:1px solid rgba(255,255,255,.14);border-radius:999px;
font-size:.7rem;font-weight:600;color:rgba(255,255,255,.6)}
#seo-prerender .chips li:first-child{color:#fff;border-color:var(--accent);font-variant-numeric:tabular-nums}
/* ── Ficha técnica ──────────────────────────────────────────────────────────
   The facts read across, divided by the container's own background showing
   through a 1px gap, so a row that wraps still divides cleanly. */
#seo-prerender .facts{display:flex;flex-wrap:wrap;gap:1px;margin:18px 0 0;background:rgba(255,255,255,.08);
border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden}
#seo-prerender .fact{flex:1 1 128px;padding:12px 16px;background:rgba(18,18,18,.78)}
#seo-prerender .fact dt{font-size:.7rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
color:rgba(255,255,255,.38)}
#seo-prerender .fact dd{margin:3px 0 0;font-size:1rem;font-weight:700;font-variant-numeric:tabular-nums}
/* ── Sections ───────────────────────────────────────────────────────────────
   A rule and a small uppercase label with the page's accent tick in front of
   it. Four identical rounded cards down a page read as a template. */
#seo-prerender .sec{margin-top:24px;padding-top:18px;border-top:1px solid rgba(255,255,255,.08)}
#seo-prerender h2{display:flex;align-items:center;gap:9px;font-size:.7rem;font-weight:700;
text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.6);margin:0 0 12px}
#seo-prerender h2::before{content:"";width:3px;height:13px;border-radius:2px;background:var(--accent);flex:none}
#seo-prerender .count{font-size:.7rem;font-weight:700;letter-spacing:0;color:rgba(255,255,255,.6);
background:rgba(255,255,255,.06);border-radius:99px;padding:2px 8px}
#seo-prerender .meta{color:rgba(255,255,255,.38);font-size:.85rem;margin:10px 0 0}
/* ── Stop list ──────────────────────────────────────────────────────────────
   Numbered down the margin with the route's colour as the spine: a line
   diagram, which is what an ordered list of paradas actually is. */
#seo-prerender ol.stops{list-style:none;padding:0;margin:0;counter-reset:parada}
#seo-prerender ol.stops li{position:relative;counter-increment:parada;margin:0;padding:6px 0 6px 46px;
border-left:3px solid var(--accent);margin-left:22px}
#seo-prerender ol.stops li::before{content:counter(parada);position:absolute;left:-46px;top:6px;width:24px;
text-align:right;font-size:.75rem;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.38)}
#seo-prerender ol.stops li::after{content:"";position:absolute;left:-8px;top:12px;width:10px;height:10px;
border-radius:50%;border:2px solid var(--accent);background:#0C0C0C;box-sizing:border-box}
#seo-prerender ol.stops li:first-child,#seo-prerender ol.stops li:last-child{font-weight:600}
#seo-prerender ol.stops li:last-child{border-left-color:transparent}
#seo-prerender ol.stops a{text-decoration:underline;text-decoration-color:rgba(255,255,255,.24);
text-underline-offset:3px}
#seo-prerender ol.stops a:hover{text-decoration-color:currentColor}
#seo-prerender ul{padding-left:1.25rem;margin:0}
#seo-prerender .platform{display:grid;gap:14px;margin:14px 0 4px}
#seo-prerender .vagon{border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px;background:rgba(18,18,18,.78)}
#seo-prerender .sentido{color:rgba(255,255,255,.6);font-size:.72rem;letter-spacing:.04em;
text-transform:uppercase;margin-bottom:6px}
#seo-prerender .dir{margin:10px 0 0}
#seo-prerender .dir+.dir{padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}
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
#seo-prerender .plano{overflow-x:auto;margin:6px 0;padding-bottom:6px;
background-image:linear-gradient(to right,#0C0C0C 40%,rgba(12,12,12,0)),
linear-gradient(to left,#0C0C0C 40%,rgba(12,12,12,0)),
radial-gradient(farthest-side at 0 50%,rgba(255,255,255,.22),rgba(255,255,255,0)),
radial-gradient(farthest-side at 100% 50%,rgba(255,255,255,.22),rgba(255,255,255,0));
background-position:left center,right center,left center,right center;
background-repeat:no-repeat;background-size:36px 100%,36px 100%,14px 100%,14px 100%;
background-attachment:local,local,scroll,scroll}
#seo-prerender .plano:focus-visible{outline:2px solid rgba(255,255,255,.6);outline-offset:3px}
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
/* The platform itself: one bar across the station, segmented per vagón. Drawn in
   the app's own neutral (the popup plan uses the same values, client/style.css)
   so the static page and the interactive one are one diagram, not two. */
#seo-prerender .vg-plate{background:rgba(255,255,255,.07);border-top:2px solid rgba(255,255,255,.14);
border-bottom:2px solid rgba(255,255,255,.14);padding:11px 10px;text-align:center;
box-shadow:inset -2px 0 0 #0C0C0C}
#seo-prerender .vg:last-child .vg-plate{box-shadow:none}
#seo-prerender .vg-plate .vg-name{font-size:.95rem;font-weight:700;letter-spacing:.01em}
#seo-prerender .vg-plate .vg-sub{display:block;font-size:.72rem;color:rgba(255,255,255,.38);margin-top:2px}
/* Direction marker: a CSS triangle, so no glyph outside the shipped subset can
   turn into tofu the way U+2192 does on the social cards. */
#seo-prerender .arw{display:inline-block;width:0;height:0;margin-right:6px;
border-left:5px solid transparent;border-right:5px solid transparent;vertical-align:middle}
#seo-prerender .arw-up{border-bottom:7px solid var(--accent)}
#seo-prerender .arw-down{border-top:7px solid var(--accent)}
#seo-prerender .vg-side .sentido{margin:0 0 6px}
#seo-prerender .vg-side .svc{gap:5px}
#seo-prerender .vg-side .svc li{font-size:.85rem;color:rgba(255,255,255,.8)}
#seo-prerender .plano-note{color:rgba(255,255,255,.45);font-size:.8rem;margin:2px 0 0}
/* The shared plan (shared/plano.js). Its markup is the app markup, so its
   styling has to match — but scoped here and inlined, because this page is
   read before any stylesheet the app ships. Written flat rather than with the
   app scale variable: there is no zoom control on a page nobody has booted. */
#seo-prerender .popup-plano{overflow-x:auto;padding-bottom:4px}
#seo-prerender .popup-plano-inner{width:max-content;min-width:100%}
#seo-prerender .pvg-row{display:flex;margin-left:calc(var(--pvg-offset,0) * 136px)}
#seo-prerender .popup-plano-cols{display:flex;align-items:stretch}
#seo-prerender .pvg{display:flex;flex-direction:column;min-width:136px;flex:1 0 auto}
#seo-prerender .pvg-side{display:flex;flex-direction:column;justify-content:center;gap:4px;padding:5px 6px;min-height:26px}
#seo-prerender .pvg-deck{display:flex;flex-direction:column;justify-content:center;gap:3px;background:rgba(255,255,255,.06);border-radius:2px;padding:5px 8px}
#seo-prerender .pvg-doors{display:block;height:4px;background:repeating-linear-gradient(to right,rgba(255,255,255,.30) 0,rgba(255,255,255,.30) 7px,transparent 7px,transparent 13px)}
#seo-prerender .pvg-plate{text-align:center;padding:2px 0}
#seo-prerender .pvg-name{font-size:.82rem;font-weight:700}
#seo-prerender .pvg-sub{font-size:.68rem;color:rgba(255,255,255,.42);margin-left:5px}
#seo-prerender .pvg-sub::after{content:" servicios"}
#seo-prerender .pvg-sub[data-n="1"]::after{content:" servicio"}
#seo-prerender .pvg-gap{display:flex;align-items:center;justify-content:center;width:22px}
#seo-prerender .pvg-gap-mark{width:7px;height:7px;border-radius:50%;border:1px solid rgba(255,255,255,.35)}
#seo-prerender .pvg-axis{display:flex;align-items:center;gap:5px;padding:2px 0;font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.55)}
#seo-prerender .pvg-divider{display:flex;align-items:center;justify-content:center;height:13px;margin:3px 0;font-size:.62rem;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.45)}
#seo-prerender .pvg-divider-cano{background:linear-gradient(180deg,#4FC3F7,#29A8DC 55%,#1B87B8);color:#fff;font-weight:700}
#seo-prerender .popup-route-tags{display:flex;flex-wrap:wrap;gap:4px;justify-content:center}
#seo-prerender .route-tag{display:inline-block;padding:2px 6px;border-radius:3px;font-size:.72rem;font-weight:700;color:#fff;text-decoration:none}
/* The full station: COLUMNS, so a vestibule spans both platforms while the
   thing between them does not. */
#seo-prerender .pdt-grid{display:flex;align-items:stretch}
#seo-prerender .pdt-col{display:flex;flex-direction:column;flex:0 0 auto}
#seo-prerender .pdt-band{display:flex;align-items:center;justify-content:center}
#seo-prerender .pdt-band-a,#seo-prerender .pdt-band-b{flex:1 1 0}
#seo-prerender .pdt-band-solo{flex:1 1 0;width:100%}
#seo-prerender .pdt-vestibulo-solo{flex-direction:row;align-items:stretch}
#seo-prerender .pdt-vestibulo-der.pdt-vestibulo-solo{flex-direction:row-reverse}
#seo-prerender .pdt-vestibulo-stack{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}
#seo-prerender .pdt-canal-solo{justify-content:center}
#seo-prerender .pdt-grid-solo .pdt-vestibulo .pdt-band-mid{height:30px}
#seo-prerender .pdt-band-mid{height:19px;gap:6px}
#seo-prerender .pdt-vestibulo{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:3px;padding:4px 8px;gap:4px}
#seo-prerender .pdt-vestibulo .pdt-band{justify-content:flex-end;gap:5px}
#seo-prerender .pdt-vestibulo .pdt-salida{margin-right:auto}
#seo-prerender .pdt-vestibulo-parte{background:transparent;border:0;padding:0;gap:0}
#seo-prerender .pdt-vestibulo-parte .pdt-band-a,#seo-prerender .pdt-vestibulo-parte .pdt-band-b{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);padding:4px 8px}
#seo-prerender .pdt-vestibulo-parte .pdt-band-a{border-bottom:0;border-radius:3px 3px 0 0}
#seo-prerender .pdt-vestibulo-parte .pdt-band-b{border-top:0;border-radius:0 0 3px 3px}
#seo-prerender .pdt-vestibulo-der .pdt-band{flex-direction:row-reverse}
#seo-prerender .pdt-vestibulo-der .pdt-salida{margin-right:0;margin-left:auto}
#seo-prerender .pdt-vestibulo-der .pdt-canal{margin-left:0;margin-right:3px;padding-left:0;padding-right:5px;border-left:0;border-right:1px solid rgba(255,255,255,.08)}
#seo-prerender .pdt-canal{display:inline-flex;flex-direction:column;align-items:center;gap:3px;margin-left:3px;padding-left:5px;border-left:1px solid rgba(255,255,255,.08)}
#seo-prerender .pdt-iconos{display:inline-flex;align-items:center;gap:4px}
#seo-prerender .pdt-icono{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:2px;box-shadow:0 0 0 1px rgba(255,255,255,.16)}
#seo-prerender .pdt-icono svg{width:20px;height:20px}
#seo-prerender .pdt-salida{display:inline-flex;flex-direction:column;border-radius:2px;overflow:hidden;font-size:.62rem;line-height:1.2;white-space:nowrap}
#seo-prerender .pdt-salida-top{display:flex;align-items:center;gap:3px;padding:2px 5px;background:#F5C518;color:#1A1A1A}
#seo-prerender .pdt-salida-der .pdt-salida-top{flex-direction:row-reverse}
#seo-prerender .pdt-salida-arrow{width:0;height:0;border-top:3px solid transparent;border-bottom:3px solid transparent;border-right:4px solid currentColor}
#seo-prerender .pdt-salida-der .pdt-salida-arrow{border-right:0;border-left:4px solid currentColor}
#seo-prerender .pdt-salida-tag{font-weight:700;text-transform:uppercase;letter-spacing:.04em}
#seo-prerender .pdt-salida-calle{padding:2px 5px;background:#101114;color:#fff;font-weight:700;text-align:center}
#seo-prerender .pdt-paso,#seo-prerender .pdt-acceso{width:30px}
#seo-prerender .pdt-paso .pdt-band-a,#seo-prerender .pdt-acceso .pdt-band-a{align-items:flex-end;padding-bottom:7px}
#seo-prerender .pdt-paso .pdt-band-b,#seo-prerender .pdt-acceso .pdt-band-b{align-items:flex-start;padding-top:7px}
#seo-prerender .pdt-canal-v{display:flex;flex-direction:column;align-items:center;gap:3px;padding:5px 0;width:100%;background:rgba(255,255,255,.07);border-radius:2px}
#seo-prerender .pdt-marca{width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;opacity:.85}
#seo-prerender .pdt-marca-der{border-left:6px solid #fff}
#seo-prerender .pdt-marca-izq{border-right:6px solid #fff}
#seo-prerender .pdt-figura{display:inline-flex;width:15px;height:15px}
#seo-prerender .pdt-figura svg{width:100%;height:100%}
#seo-prerender .pdt-puente{align-items:center;justify-content:space-between;gap:4px;width:30px;padding:4px 0;border:1px dashed rgba(255,255,255,.14);border-radius:2px;background:rgba(255,255,255,.03);color:rgba(255,255,255,.5)}
#seo-prerender .pdt-puente-sube,#seo-prerender .pdt-puente-baja{flex:0 0 auto;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent}
#seo-prerender .pdt-puente-sube{border-bottom:8px solid currentColor}
#seo-prerender .pdt-puente-baja{border-top:8px solid currentColor}
#seo-prerender .pdt-puente-txt{writing-mode:vertical-rl;transform:rotate(180deg);font-size:.58rem;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
#seo-prerender .pdt-divider{font-size:.62rem;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
#seo-prerender .pdt-divider-cano{background:linear-gradient(180deg,#4FC3F7,#29A8DC 55%,#1B87B8);color:#fff;font-weight:700}
#seo-prerender .pdt-divider-tren{background:linear-gradient(#4D5059,#4D5059) top/100% 1.5px no-repeat,linear-gradient(#4D5059,#4D5059) bottom/100% 1.5px no-repeat,repeating-linear-gradient(to right,rgba(255,255,255,.14) 0,rgba(255,255,255,.14) 2px,transparent 2px,transparent 7px)}
#seo-prerender .pdt-divider-ciclorruta,#seo-prerender .pdt-divider-separador,#seo-prerender .pdt-divider-busway,#seo-prerender .pdt-divider-tunel{background:repeating-linear-gradient(to right,rgba(255,255,255,.14) 0,rgba(255,255,255,.14) 9px,transparent 9px,transparent 18px) center/100% 2px no-repeat}
#seo-prerender .pdt-divider .pdt-divider-name{padding:0 6px;background:#0C0C0C}
#seo-prerender .pdt-divider-cano .pdt-divider-name{background:transparent}
#seo-prerender .pdt-convenciones{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,.08)}
#seo-prerender .pdt-conv-tag{font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:rgba(255,255,255,.45)}
#seo-prerender .pdt-conv{display:inline-flex;align-items:center;gap:5px}
#seo-prerender .pdt-conv-txt{font-size:.72rem;color:rgba(255,255,255,.7)}
@media (max-width:560px){#seo-prerender .vg{flex-basis:170px;min-width:170px}}
/* ── El rutero ──────────────────────────────────────────────────────────────
   The bus's own LED destination sign. The frame is its black bezel; the sign
   inside is a dot grid (shared/rutero.js), so it scales as one image and can
   never reflow into text. Duplicated from the app's stylesheet on purpose —
   this panel ships before any stylesheet of ours is guaranteed to have loaded,
   and the four rules are the frame, not the drawing. */
#seo-prerender .rutero{margin:22px 0 0}
#seo-prerender .rutero-frame{border-radius:10px;padding:6px;overflow:hidden;
background:linear-gradient(180deg,#23262b,#0d0f12);
box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 10px 26px rgba(0,0,0,.55)}
#seo-prerender .rutero-svg{display:block;width:100%;height:auto;border-radius:3px}
#seo-prerender .rutero figcaption{margin:9px 0 0;font-size:.72rem;letter-spacing:.06em;
text-transform:uppercase;color:rgba(255,255,255,.38)}
#seo-prerender .chip{display:inline-block;min-width:52px;text-align:center;padding:2px 8px;border-radius:7px;
font-size:.82rem;font-weight:700;margin-right:8px}
@media (max-width:560px){
  #seo-prerender .wrap{padding:0 14px}
  #seo-prerender .hero{gap:12px}
  #seo-prerender .plate{min-width:62px;padding:10px 12px;font-size:1.25rem}
  #seo-prerender h1{font-size:1.3rem}
}
/* Injected by the client once the map is live (revealPrerenderedPanel in
   main.ts) — never present without JS, because without JS there is no map to
   switch to. Sticky so the way out is on screen wherever the reader has
   scrolled to; it sits in the masthead's place, over the same glass. */
#seo-prerender .seo-dismiss{position:sticky;top:0;z-index:1;display:flex;justify-content:flex-end;
margin:0 -24px;padding:10px 24px;background:rgba(12,12,12,.92);
backdrop-filter:blur(24px) saturate(1.2);-webkit-backdrop-filter:blur(24px) saturate(1.2)}
#seo-prerender .seo-dismiss button{font:inherit;font-size:.8rem;font-weight:600;color:#fff;
background:#202329;border:1px solid #4D5059;border-radius:12px;padding:8px 13px;cursor:pointer}
#seo-prerender .seo-dismiss button:hover{border-color:#D8102D;background:rgba(216,16,45,.14)}
#seo-prerender .seo-dismiss button:focus-visible{outline:2px solid #7DD3FC;outline-offset:2px}
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
  return `<nav class="crumbs" aria-label="Ruta de navegación">${trail
    .map((item, i) =>
      i === trail.length - 1
        ? `<span>${escapeHtml(item.name)}</span>`
        : `<a href="${item.url}">${escapeHtml(item.name)}</a> <span aria-hidden="true">›</span>`
    )
    .join(' ')}</nav>`;
}

/** The ficha técnica strip both page kinds carry (spec §5.5.5, §5.5.6). */
function factsHtml(items: Array<{ label: string; value: string | null | undefined }>): string {
  const cells = items
    .filter((item) => item.value)
    .map(
      (item) =>
        `  <div class="fact"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(String(item.value))}</dd></div>`
    )
    .join('\n');
  return cells ? `<dl class="facts">\n${cells}\n</dl>` : '';
}

/** Long-form system name, matching the app's `routeSystemLabel`. */
function systemLabel(route: LightRoute): string {
  const tipo = String(route.tipoServicio ?? '').toUpperCase();
  if (tipo === 'ALIMENTADOR') return 'TransMilenio Alimentador';
  if (tipo === 'PADRON') return 'TransMilenio Dual';
  return route.sistema === 'TransMilenio' ? 'TransMilenio Troncal' : 'SITP Zonal';
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

  // One section per sentido, each headed by the trip it makes and numbered down
  // the margin: an ordered list of paradas IS a line diagram, and drawing it as
  // one is the difference between a page about a route and a page listing rows.
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

      return `<section class="sec">
<h2>Hacia ${escapeHtml(tidy(variant.destination) || '?')}${stops.length ? ` <span class="count">${stops.length}</span>` : ''}</h2>
<p class="sub">Desde ${escapeHtml(tidy(variant.origin) || '?')}${schedule ? ` · ${escapeHtml(schedule)}` : ''}</p>
<ol class="stops">
${items}
</ol>
</section>`;
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
<div class="rutero-frame">${ruteroSvg({
            code: codigo,
            destination: tidy(variant.destination) || tidy(variant.nombre),
            panelChars,
            uid: `${slugify(codigo)}-${i}`,
            label: `Rutero de la ruta ${codigo} hacia ${tidy(variant.destination)}`,
          })}</div>
<figcaption>Rutero · hacia ${escapeHtml(tidy(variant.destination) || '?')}</figcaption>
</figure>`
        )
        .join('\n');

  // The route's own colour carries the page (spec §5.5.5): the plate, the rail
  // under the masthead, the spine of every stop list. Resolved through the same
  // palette the app and the social cards use, so one código is never two colours
  // across the three surfaces (`stopTagColor`, §5.4.3).
  const accent = stopTagColor(codigo, primary.color, isZonalService(primary.sistema, primary.tipoServicio));

  const facts = factsHtml([
    { label: 'Paradas', value: stopCount ? String(stopCount) : null },
    { label: 'Sentidos', value: variants.length > 1 ? String(variants.length) : null },
    { label: 'Servicio', value: tidy(primary.tipoServicio) || null },
    { label: 'Horario', value: horarios.split(' · ')[0] || null },
  ]);

  const body = `${PRERENDER_STYLE}
<main id="seo-prerender" style="--accent:${accent}"><div class="rail"></div><div class="wrap">
${breadcrumbHtml(trail)}
<header class="hero">
  <span class="plate">${escapeHtml(codigo)}</span>
  <div>
    <h1>${escapeHtml(name)}</h1>
    <p class="kind"><span class="tag">${escapeHtml(tidy(primary.tipoServicio) || 'TRONCAL')}</span><span>${escapeHtml(systemLabel(primary))}</span></p>
  </div>
</header>
${ruteros}
${ruteros ? `<p class="meta">El letrero LED sobre el parabrisas del bus, un sentido por letrero: con él se reconoce en el andén qué bus es cuál.</p>` : ''}
${facts}
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

  // ONE drawing, shared with the browser (`shared/plano.js`). This page used
  // to build its own from the catalog alone, so Guatoque shipped as
  // "Plataforma 1 / Plataforma 2" and "2 vagones" while the app, once booted,
  // drew the four vagones its sheet actually prints. Same URL, two answers,
  // and the wrong one was the one a search result showed first.
  //
  // Chips are real anchors here: `routeHref` is what keeps this page linked
  // to the routes that serve it, which is half of the cross-linking that
  // stops these pages being orphaned. The browser passes none and keeps its
  // click handler.
  const sheet = buildSheetPlano({
    wagons: (station.wagons ?? {}) as Record<string, any[]>,
    layout: station.planoLayout,
    detalle: station.planoDetalle,
    wagonPlan: station.wagonPlan as never,
    sentidos: station.corridor?.sentidos,
    tagColor: (r) => stopTagColor(r.codigo, r.color, isZonalService(r.sistema, r.tipoServicio)),
    isZonal: (r) => isZonalService(r.sistema, r.tipoServicio),
    routeHref: (r) => routeIndex.get(String(r.codigo).trim().toUpperCase()) ?? null,
  });

  // Distinct vagón numbers the sheet draws, not drawn boxes: Av. Chile prints
  // the same three vagones once per carriageway and has three, not six.
  const drawnVagones = new Set<string>();
  for (const row of ((station.planoLayout as { rows?: Array<{ vagones?: Array<{ vagon?: string }> }> } | undefined)?.rows ?? [])) {
    for (const v of row.vagones ?? []) if (v.vagon) drawnVagones.add(String(v.vagon));
  }
  const vagonCount = sheet && drawnVagones.size ? drawnVagones.size : platform.vagones.length;

  const platformSection = sheet
    ? `<section class="sec">
<h2>Plano de la estación</h2>
<p class="sub">${sheet.detallado
        ? 'Dibujado a partir del plano de ubicación oficial: los vagones, los servicios de cada lado, y los accesos, taquillas, torniquetes y salidas que el plano señala.'
        : 'Servicios troncales por vagón, separados por sentido, como los dibuja el plano de ubicación oficial de la estación.'}</p>
${sheet.html}
<p class="plano-note meta">No representa distancias ni la posición real de los andenes en la calle.</p>
</section>`
    : platform.vagones.length
    ? `<section class="sec">
<h2>Plano de la estación</h2>
<p class="sub">Servicios troncales por vagón, separados por sentido. Un vagón suele atender los dos sentidos: el rumbo indicado es el de salida hacia la siguiente parada.</p>
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
<p class="plano-note meta">Esquema propio, derivado del catálogo oficial: el orden de los vagones y los servicios de cada sentido son los que el catálogo registra. No representa distancias, accesos ni la posición real de los andenes en la calle.</p>
</section>`
    : '';

  // Troncal services the catalog files under wagon "0". Their own block, with no
  // number of any kind: the catalog names no platform for them, and the plano is
  // the only thing that can (spec §5.5.4).
  const unassignedSection = platform.unassigned.length
    ? `<section class="sec">
<h2>${platform.vagones.length ? 'Otros servicios troncales' : 'Servicios troncales'} <span class="count">${countServices(platform.unassigned)}</span></h2>
<p class="sub">El catálogo no asigna vagón a estos servicios; confirma la plataforma en la señalización de la estación.</p>
<div class="platform">
  <div class="vagon">
${platform.unassigned.map(directionHtml).join('\n')}
  </div>
</div>
</section>`
    : '';

  const feederSection = platform.feeders.length
    ? `<section class="sec">
<h2>Alimentadores y servicios zonales <span class="count">${platform.feeders.length}</span></h2>
<div class="platform">
  <div class="vagon">
    <ul class="svc">
${platform.feeders.map((s) => `      ${serviceRow(s)}`).join('\n')}
    </ul>
  </div>
</div>
</section>`
    : '';

  const wagonSections = `${platformSection}\n${unassignedSection}\n${feederSection}`.trim();

  // The page is keyed to the **troncal the station sits on** — Autonorte green,
  // Caracas blue, Carrera 7 purple (§5.4.3) — which is the colour a rider
  // already reads off the corridor's signage and off every código serving it.
  // The corridor is an answered fact shipped on the catalog (`stationCorridor`,
  // §5.5.6); without one the page falls back to the red the station layer is
  // drawn in rather than picking a corridor for it.
  const accent = TRONCAL_COLORS[String(station.corridor?.letra ?? '').toUpperCase()] ?? '#D8102D';

  const chips = [
    station.codigo,
    platform.vagones.length
      // The count the DRAWING shows, where a sheet was read. The catalog files
      // Guatoque under two wagons and its plano prints four vagones, so this
      // chip read "2 vagones" directly above a drawing of four — the same
      // contradiction the app page had, on the page a stranger sees first.
      ? `${vagonCount} ${vagonCount === 1 ? 'vagón' : 'vagones'}`
      : '',
    `${serviceCount} servicios`,
  ].filter(Boolean);

  const body = `${PRERENDER_STYLE}
<main id="seo-prerender" style="--accent:${accent}"><div class="rail"></div><div class="wrap">
${breadcrumbHtml(trail)}
<header class="hero">
  <div>
    <p class="kind"><span class="tag">ESTACIÓN</span><span>${escapeHtml(station.corridor?.nombre ? `Troncal ${station.corridor.nombre}` : 'TransMilenio Troncal')}</span></p>
    <h1>${escapeHtml(nombre)}</h1>
    <p class="sub">${escapeHtml(direccion || 'Bogotá, Colombia')}</p>
    <ul class="chips">${chips.map((chip) => `<li>${escapeHtml(chip)}</li>`).join('')}</ul>
  </div>
</header>
${wagonSections || '<section class="sec"><p class="meta">El catálogo oficial no asigna vagones a esta estación.</p></section>'}
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
    (st) => isTroncalStationCode(st.codigo) && Object.keys(st.wagons ?? {}).length > 0
  );
  // One page per PLATFORM for the two stations the catalog files as a single
  // stop. Avenida Jiménez and Ricaurte are each a trunk platform and a Calle 13
  // platform, on different troncals, joined by a tunnel and sharing no service
  // — so a rider standing on one of them was reading a page that described the
  // other as well. The merged page stays: it is the whole interchange, and it
  // is what every existing link points at.
  for (const platform of STATION_PLATFORMS) {
    const parent = stations.find((st) => st.codigo.toUpperCase() === platform.parent);
    if (!parent) {
      console.warn(`[seo] platform ${platform.codigo}: parent ${platform.parent} not in catalog; page skipped.`);
      continue;
    }
    const derived = platformStation(platform, parent) as LightStation | null;
    if (derived) stations.push(derived);
  }

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
