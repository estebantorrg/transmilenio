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
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCatalogFromDisk, getCatalogLightGzip } from './services/tm_api.js';
import { prepareFont, readableOn, renderRouteCard, renderStationCard, type LonLat } from './seo_og.js';

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
#seo-prerender .chip{display:inline-block;min-width:52px;text-align:center;padding:2px 8px;border-radius:7px;font-size:.82rem;margin-right:8px}
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
}
interface PlatformDirection {
  /** Spanish cardinal for the way these services leave, when derivable. */
  sentido: string | null;
  services: PlatformService[];
}
interface PlatformVagon {
  /** The number printed on the platform sign, or null when it can't be trusted. */
  label: string | null;
  directions: PlatformDirection[];
}

const CARDINALS = [
  'norte', 'nororiente', 'oriente', 'suroriente',
  'sur', 'suroccidente', 'occidente', 'noroccidente',
];

/** Compass bearing from a to b, in degrees clockwise from north. */
function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  // Equirectangular is ample at city scale and avoids trig-heavy great circles.
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = b.lat - a.lat;
  return (Math.atan2(x, y) * 180) / Math.PI;
}

/**
 * Averages bearings as unit vectors — the mean of 350° and 10° is 0°, not 180°.
 *
 * Returns null unless the services in a vagón genuinely agree. Many stations
 * board both directions from the same vagón (21 Ángeles: two services leaving at
 * 156° and two at 300°), and a plain average of those is a confident, meaningless
 * answer. The test is on the **mean** resultant length, not the sum: summing grew
 * with the number of services, so a four-service vagón split two-and-two cleared
 * the bar and printed a direction that was simply wrong.
 */
function meanCardinal(bearings: number[]): string | null {
  if (bearings.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const deg of bearings) {
    sx += Math.sin((deg * Math.PI) / 180);
    sy += Math.cos((deg * Math.PI) / 180);
  }
  // 1.0 = perfect agreement, 0 = evenly opposed. Applied per direction group, so
  // it now only rejects genuinely incoherent sets.
  if (Math.hypot(sx, sy) / bearings.length < 0.6) return null;
  const mean = (Math.atan2(sx, sy) * 180) / Math.PI;
  return CARDINALS[Math.round(((mean + 360) % 360) / 45) % 8];
}

/**
 * Splits a vagón's services into the two directions it serves — what an official
 * plano draws as badges above and below the platform.
 *
 * An earlier version *averaged* a vagón's bearings into one label, found they
 * cancelled at most stations, and concluded vagones had no direction. That was
 * backwards: a TransMilenio vagón is usually an island platform serving **both**
 * ways, so the bearings are supposed to disagree. Split on them, don't average.
 *
 * Verified against the official planos for General Santander and Calle 40 Sur —
 * the catalog's wagon groups reproduce the printed vagones exactly.
 */
function splitDirections(entries: Array<{ svc: PlatformService; deg: number | null }>): PlatformDirection[] {
  const known = entries.filter((e) => e.deg !== null) as Array<{ svc: PlatformService; deg: number }>;
  const unknown = entries.filter((e) => e.deg === null).map((e) => e.svc);
  if (known.length === 0) return entries.length ? [{ sentido: null, services: entries.map((e) => e.svc) }] : [];

  // Principal axis of travel via doubled angles, so opposite headings reinforce
  // instead of cancelling; then split by which side of that axis each service runs.
  let sx = 0;
  let sy = 0;
  for (const e of known) {
    sx += Math.sin((2 * e.deg * Math.PI) / 180);
    sy += Math.cos((2 * e.deg * Math.PI) / 180);
  }
  const axis = Math.atan2(sx, sy) / 2;
  const ax = Math.sin(axis);
  const ay = Math.cos(axis);

  const groups: Array<Array<{ svc: PlatformService; deg: number }>> = [[], []];
  for (const e of known) {
    const dot = Math.sin((e.deg * Math.PI) / 180) * ax + Math.cos((e.deg * Math.PI) / 180) * ay;
    groups[dot >= 0 ? 0 : 1].push(e);
  }

  const directions = groups
    .filter((g) => g.length > 0)
    .map((g) => ({ sentido: meanCardinal(g.map((e) => e.deg)), services: g.map((e) => e.svc) }));
  // Services whose heading cannot be derived are listed plainly rather than
  // guessed into a direction.
  if (unknown.length) directions.push({ sentido: null, services: unknown });
  return directions;
}

/** Vagón plates counted on each official plano (`data/plano_vagones.json`). */
const PLANO_VAGONES: Record<string, number> = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, 'data', 'plano_vagones.json'), 'utf-8')).counts ?? {};
  } catch {
    // Missing dataset must not break the build — it only costs vagón numbering.
    console.warn('[seo] plano_vagones.json unreadable; vagón numbers will be omitted.');
    return {};
  }
})();

/**
 * The number printed on the platform sign, or null when it can't be trusted.
 *
 * The catalog keys wagons `A`, `B`, `C` (128 of 139 stations) while signage reads
 * "Vagón 1/2/3", and A→1, B→2, C→3 was verified against the official planos for
 * Sevillana, León XIII, Bosa, General Santander, Calle 40 Sur, San Mateo and —
 * on four vagones each — Granja-Carrera 77 and Suba-TV 91.
 *
 * It is NOT universal. It fails exactly where the catalog groups platforms
 * differently from the signage: Calle 161 (catalog 2 wagons, plano prints 4, so
 * catalog `A` mixes printed vagones 1 and 3) and Av. Jiménez (catalog 5, plano
 * prints 3). Both are caught by comparing the catalog's wagon count with the
 * plate count on the plano — a predicate that agreed with ground truth on 9 of
 * the 10 stations checked, and whose one miss errs toward silence.
 *
 * Sending a rider to "Vagón 1" when the sign says 3 is a real wrong answer, so
 * where the counts disagree the platform is rendered without a number at all.
 */
function vagonLabel(key: string, stationCode: string, wagonCount: number): string | null {
  const k = key.trim().toUpperCase();
  if (!/^[A-Z]$/.test(k)) return key; // `T3` and numerics are already as-printed
  const plates = PLANO_VAGONES[stationCode.toUpperCase()];
  if (!plates || plates !== wagonCount) return null;
  return String(k.charCodeAt(0) - 64);
}

function buildPlatform(
  station: LightStation,
  variantById: Map<string, LightRoute>,
  routeIndex: Map<string, string>
): { vagones: PlatformVagon[]; feeders: PlatformService[] } {
  const here = parseCoordinate(station.coordenada);
  const code = String(station.codigo).toUpperCase();
  const vagones: PlatformVagon[] = [];
  let feeders: PlatformService[] = [];

  const entries = Object.entries(station.wagons ?? {}).sort(([a], [b]) =>
    a.localeCompare(b, 'es', { numeric: true })
  );
  // Platform count as the catalog sees it — compared against the plano's plate
  // count to decide whether the printed vagón number can be trusted.
  const wagonCount = entries.filter(([w, routes]) => w !== '0' && routes.length > 0).length;

  for (const [wagon, routes] of entries) {
    // Each service keeps its OWN heading, so the vagón can be split by direction
    // rather than averaged into one — see splitDirections().
    const scored: Array<{ svc: PlatformService; deg: number | null }> = [];

    for (const route of routes) {
      const codigo = tidy(route.codigo);
      if (!codigo) continue;
      const variant = variantById.get(String((route as any).id));
      const svc: PlatformService = {
        codigo,
        destino: tidy(route.nombre),
        color: route.color,
        href: routeIndex.get(codigo.toUpperCase()),
      };

      let deg: number | null = null;
      const stops = variant?.stops ?? [];
      const at = here && stops.length ? stops.findIndex((s) => String(s.codigo).toUpperCase() === code) : -1;
      if (here && at >= 0) {
        // Next stop gives the heading; at the last stop, reuse the leg into it.
        const from = at < stops.length - 1 ? parseCoordinate(stops[at].coordenada) : parseCoordinate(stops[at - 1]?.coordenada ?? '');
        const to = at < stops.length - 1 ? parseCoordinate(stops[at + 1].coordenada) : here;
        if (from && to) deg = bearing(from, to);
      }
      scored.push({ svc, deg });
    }

    // Wagon "0" is the alimentador/zonal pool, not a numbered troncal platform.
    if (wagon === '0') feeders = scored.map((s) => s.svc);
    else if (scored.length) {
      vagones.push({ label: vagonLabel(wagon, code, wagonCount), directions: splitDirections(scored) });
    }
  }

  return { vagones, feeders };
}

// ─── Estación pages ───────────────────────────────────────
function renderStation(
  station: LightStation,
  routeIndex: Map<string, string>,
  variantById: Map<string, LightRoute>
) {
  const url = stationUrl(station);
  const nombre = tidy(station.nombre);
  const direccion = tidy(station.direccion);
  const coord = parseCoordinate(station.coordenada);
  const platform = buildPlatform(station, variantById, routeIndex);
  const serviceCount =
    platform.vagones.reduce((n, v) => n + v.directions.reduce((m, d) => m + d.services.length, 0), 0) +
    platform.feeders.length;

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

  const serviceRow = (svc: PlatformService): string => {
    const fill = /^#[0-9a-f]{6}$/i.test(String(svc.color ?? '')) ? String(svc.color) : '#D8102D';
    const chip = `<span class="chip" style="background:${fill};color:${readableOn(fill)}">${escapeHtml(svc.codigo)}</span>`;
    const label = escapeHtml(svc.destino);
    return `<li>${chip}${svc.href ? `<a href="${svc.href}">${label}</a>` : label}</li>`;
  };

  const platformSection = platform.vagones.length
    ? `<h2>Plano de la estación</h2>
<p class="meta">Servicios troncales por vagón, separados por sentido. Un vagón suele atender los dos sentidos: el rumbo indicado es el de salida hacia la siguiente parada.</p>
<div class="platform">
${platform.vagones
  .map(
    // No number when the catalog's platform grouping doesn't line up with the
    // signage — "Plataforma" is vague but true, whereas a wrong vagón number
    // sends a rider to the wrong side of the station.
    (v, i) => `  <div class="vagon">
    <div class="vagon-head"><span class="vagon-name">${
      v.label ? `Vagón ${escapeHtml(v.label)}` : `Plataforma ${i + 1}`
    }</span></div>
${v.directions
  .map(
    (d) => `    <div class="dir">
      ${d.sentido ? `<div class="sentido">sentido ${escapeHtml(d.sentido)}</div>` : ''}
      <ul class="svc">
${d.services.map((s) => `        ${serviceRow(s)}`).join('\n')}
      </ul>
    </div>`
  )
  .join('\n')}
  </div>`
  )
  .join('\n')}
</div>`
    : '';

  const feederSection = platform.feeders.length
    ? `<h2>Alimentadores y servicios zonales</h2>
<ul class="svc">
${platform.feeders.map((s) => `  ${serviceRow(s)}`).join('\n')}
</ul>`
    : '';

  const wagonSections = `${platformSection}\n${feederSection}`.trim();

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
  // A station's wagon entries carry the route *variant* id, which is what pins
  // down the direction — the same código runs both ways through a station.
  const variantById = new Map<string, LightRoute>();
  for (const variants of Object.values(catalog.routes)) {
    for (const variant of variants) variantById.set(String(variant.id), variant);
  }

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
    const page = renderStation(station, routeIndex, variantById);
    const dir = path.join(CLIENT_DIST, page.url.replace(/^\/|\/$/g, ''));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), renderPage(shell, page));
    stationUrls.push(page.url);

    const { vagones, feeders } = page.platform;
    await writeFile(
      path.join(CLIENT_DIST, stationCardUrl(station).replace(/^\//, '')),
      renderStationCard({
        nombre: tidy(station.nombre),
        direccion: tidy(station.direccion),
        serviceCount:
          vagones.reduce((n, v) => n + v.directions.reduce((m, d) => m + d.services.length, 0), 0) + feeders.length,
        vagones: vagones.map((v) => ({
          label: v.label,
          // A vagón usually serves both directions, so the card shows none rather
          // than picking one; the page carries the full per-direction split.
          sentido: v.directions.length === 1 ? v.directions[0].sentido : null,
          codigos: v.directions.flatMap((d) => d.services).map((s) => ({ codigo: s.codigo, color: s.color })),
        })),
        feeders: feeders.map((s) => ({ codigo: s.codigo, color: s.color })),
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
