/**
 * Social cards for the prerendered pages (spec §5.5.4).
 *
 * Colombia shares links in WhatsApp groups, not on Twitter, so the link preview
 * is a real distribution surface: every forward of a route page renders this
 * image to a chat full of people with the same commute. A single generic logo
 * card — which is what the site shipped before — is indistinguishable from spam,
 * so each route draws its own `trazado` over the city network and each estación
 * shows where it sits and what stops there.
 *
 * The backdrop is the **troncal network itself**, not a basemap: fetching map
 * tiles for 352 cards would mean 352× the external requests, tile-provider
 * attribution, and a build that breaks when someone else's CDN does. The network
 * is already in the catalog, costs nothing, and reads as a transit diagram.
 *
 * Build-time only. Nothing here is imported by `index.ts`, so the native resvg
 * binary never costs the 512 MB instance any runtime memory (§5.1.3).
 *
 * FONT: the site's Inter is a **woff2**, which fontdb cannot read, and the Linux
 * build image is not guaranteed to carry any system font — text would silently
 * render as nothing. So the woff2 is decompressed back to the TTF it already is
 * and handed to resvg explicitly. Two consequences that constrain every layout
 * below:
 *   1. It is a *variable* font; fontdb collapses it to one weight. Hierarchy has
 *      to come from SIZE and COLOUR, never from `font-weight`.
 *   2. The subset is latin-only — `→` (U+2192) renders as tofu. Any arrow is
 *      drawn as a path, and no glyph outside the subset may be used.
 */

import { Resvg } from '@resvg/resvg-js';
import wawoff from 'wawoff2';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WIDTH = 1200;
const HEIGHT = 630;
const FIELD = '#0C0C0C';
const RED = '#D8102D';
const BLUE = '#38BDF8';
const DIM = '#9AA1AC';
/** Bright enough to survive a WhatsApp thumbnail (previews render ~300px wide,
 *  where a subtler grey disappears), dim enough not to compete with the route. */
const BACKDROP = '#27323F';

/** Map first: the map is the card's top 450 px, edge to edge, and the identity
 *  sits in the band below it in sizes that survive a ~300 px chat preview. */
const MAP = { x: 0, y: 0, w: WIDTH, h: 450 };
const BAND_Y = MAP.h;
const MAP_FILL = '#10151D';
/** Edge for lines and pills: black is a route colour (the 4, rutas fáciles), and
 *  a black casing or band would swallow it. */
const OUTLINE = '#3A414D';

/** Inter's average advance is ~0.52em; resvg gives us no measuring API, so
 *  wrapping and chip widths are estimated. Deliberately generous. */
const AVG_ADVANCE = 0.52;

export type LonLat = [number, number];

export interface OgRoute {
  codigo: string;
  nombre: string;
  color?: string;
  origin?: string;
  destination?: string;
  stopCount: number;
  horarios?: string;
  /** Trace polylines as [lon, lat]; falls back to the stop line. */
  paths: LonLat[][];
  /** Stop positions, drawn as beads along the trace. */
  stops: LonLat[];
  /** Dimmed city network drawn behind. */
  backdrop: LonLat[][];
}

export interface OgStation {
  nombre: string;
  direccion?: string;
  serviceCount: number;
  /** Troncal platforms in order. `label` is null when the printed vagón number
   *  can't be trusted (see `vagonLabel` in prerender_seo.ts). */
  vagones: Array<{ label: string | null; sentido: string | null; codigos: Array<{ codigo: string; color?: string }> }>;
  /** Troncal services the catalog files under wagon "0", i.e. with no platform
   *  letter at all — listed apart from the vagones so they take no number, and
   *  apart from the feeders so they aren't called alimentadores (spec §5.5.4). */
  unassigned: Array<{ codigo: string; color?: string }>;
  /** Alimentadores / zonales, which board outside the numbered vagones. */
  feeders: Array<{ codigo: string; color?: string }>;
  /** Where the pin goes. */
  point: LonLat | null;
  /** The troncal services' traces, in their colours: what stops here, drawn
   *  through the pin rather than a lone dot on the grey spine. */
  lines: Array<{ color?: string; paths: LonLat[][] }>;
  backdrop: LonLat[][];
}

// ─── Text helpers ─────────────────────────────────────────
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const textWidth = (text: string, size: number) => text.length * size * AVG_ADVANCE;

/** Greedy wrap to at most `maxLines`, ellipsising the overflow. */
function wrap(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (textWidth(last, size) > maxWidth || words.join(' ') !== lines.join(' ')) {
      let trimmed = last;
      while (trimmed && textWidth(`${trimmed}…`, size) > maxWidth) trimmed = trimmed.slice(0, -1);
      lines[maxLines - 1] = `${trimmed.trimEnd()}…`;
    }
  }
  return lines;
}

/** White on dark brand colours, near-black on light ones. Exported so the HTML
 *  chips on the station pages apply the exact same rule as the cards — this is
 *  subtle enough to get wrong twice if it lives in two places. */
export function readableOn(hex: string | undefined): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!match) return '#FFFFFF';
  const n = parseInt(match[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // 0.179 is where contrast against white and against black is equal. A higher
  // threshold looks safe but isn't: the catalog is full of mid-bright route
  // colours (#38BDF8, #E1A2AC) that sit just under it and got unreadable white
  // text on a pale badge.
  return luminance > 0.179 ? '#0C0C0C' : '#FFFFFF';
}

function safeColor(hex: string | undefined): string {
  return /^#[0-9a-f]{6}$/i.test(String(hex ?? '').trim()) ? String(hex).trim() : RED;
}

// ─── Projection ───────────────────────────────────────────
type Project = (p: LonLat) => [number, number];

/**
 * Fits `focus` into the map panel, preserving aspect and flipping latitude.
 * `pad` (>1) zooms out so the surrounding network shows around the subject —
 * a route drawn edge-to-edge has no context, which is the whole point of the
 * backdrop. `minSpan` (degrees) is the smallest window: an estación is one
 * point, and it is shown as the neighbourhood around it, centred.
 */
function makeProjector(focus: LonLat[], pad: number, minSpan = 0.02): Project | null {
  const pts = focus.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length === 0) return null;

  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const spanLon = Math.max((Math.max(...lons) - Math.min(...lons)) * pad, minSpan);
  const spanLat = Math.max((Math.max(...lats) - Math.min(...lats)) * pad, minSpan);
  const scale = Math.min(MAP.w / spanLon, MAP.h / spanLat);

  return ([lon, lat]: LonLat) => [
    MAP.x + MAP.w / 2 + (lon - midLon) * scale,
    // Latitude grows north, SVG y grows south.
    MAP.y + MAP.h / 2 - (lat - midLat) * scale,
  ];
}

const poly = (points: LonLat[], project: Project) =>
  points.map(project).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** The dimmed city network, clipped to the panel. */
function backdropSvg(paths: LonLat[][], project: Project): string {
  const lines = paths
    .filter((p) => p.length > 1)
    .map((p) => `<polyline points="${poly(p, project)}"/>`)
    .join('');
  return `<g clip-path="url(#mapclip)" fill="none" stroke="${BACKDROP}" stroke-width="3" stroke-linecap="round">${lines}</g>`;
}

const mapClip = `<defs><clipPath id="mapclip"><rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}"/></clipPath></defs>`;

// ─── Shared chrome ────────────────────────────────────────
function markSvg(x: number, y: number, size: number): string {
  const s = size / 64;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <defs><clipPath id="ogm"><rect width="64" height="64" rx="14"/></clipPath></defs>
    <g clip-path="url(#ogm)">
      <rect width="64" height="64" fill="#101318"/>
      <g stroke-width="12"><path d="M32 -6 L32 70" stroke="${RED}"/><path d="M-6 32 L70 32" stroke="${BLUE}"/></g>
    </g>
    <circle cx="32" cy="32" r="8.5" fill="#FFFFFF"/>
  </g>`;
}

/** The mark and the name, as the same outlines the pages show, on a dark pill in
 *  the map's top-left corner — over the map, so the band keeps its whole width
 *  for the subject. */
const brand = () => {
  if (!wordmark) throw new Error('prepareWordmark() must run before rendering cards.');
  const height = 24;
  const width = (wordmark.w * height) / wordmark.h;
  return `<rect x="28" y="26" width="${(84 + width).toFixed(0)}" height="60" rx="30" fill="${FIELD}" opacity="0.88"/>
  ${markSvg(36, 34, 44)}
  <path transform="translate(90 ${34 + (44 - height) / 2}) scale(${height / wordmark.h})" fill="#FFFFFF" d="${wordmark.d}"/>`;
};

/** A pill: the badges round fully, at every size, on the card and the band. */
function pill(x: number, y: number, h: number, label: string, fill: string, size: number): { svg: string; w: number } {
  const w = Math.max(h * 1.6, textWidth(label, size) + h * 0.8);
  return {
    w,
    svg:
      `<rect x="${x.toFixed(0)}" y="${y}" width="${w.toFixed(0)}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${OUTLINE}" stroke-width="2"/>` +
      `<text x="${(x + w / 2).toFixed(0)}" y="${(y + h / 2 + size * 0.36).toFixed(0)}" font-family="Inter" font-size="${size}" fill="${readableOn(fill)}" text-anchor="middle">${esc(label)}</text>`,
  };
}

const mapBase = (backdrop: LonLat[][], project: Project) =>
  `<rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}" fill="${MAP_FILL}"/>${backdropSvg(backdrop, project)}`;

// ─── Route card ───────────────────────────────────────────
export function routeCardSvg(route: OgRoute): string {
  const color = safeColor(route.color);

  // Fitted to the route itself, with room around it for the network to say
  // where in the city it runs.
  const focus = route.paths.flat().concat(route.stops);
  const project = makeProjector(focus, 1.3);

  let mapSvg = `<rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}" fill="${MAP_FILL}"/>`;
  if (project) {
    const trace = route.paths
      .filter((p) => p.length > 1)
      .map((p) => `<polyline points="${poly(p, project)}"/>`)
      .join('');
    // Stops as beads: dark core ring keeps them legible where the trace doubles
    // back on itself.
    const beads = route.stops
      .map(project)
      .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#FFFFFF" stroke="${FIELD}" stroke-width="2"/>`)
      .join('');
    // Terminals mark the origin and destination **stops** — the two places the
    // card's text names — not the ends of the drawn trace. Capping the trace
    // instead looks tidier on a straight route but collapses on the many loop
    // alimentadores whose trazado starts and ends at the same coordinate
    // (6-1: first === last exactly), stacking both rings on one pixel. A ring
    // sitting slightly inside the line is correct: the bus drives past its last
    // stop to the loop.
    const ends = [route.stops[0], route.stops[route.stops.length - 1]]
      .filter((p): p is LonLat => Array.isArray(p))
      .map(project)
      .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="#FFFFFF" stroke="${color}" stroke-width="6"/>`)
      .join('');

    // A casing under the line keeps every route colour readable on the map.
    mapSvg = `${mapBase(route.backdrop, project)}
      <g clip-path="url(#mapclip)">
        <g fill="none" stroke="${OUTLINE}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">${trace}</g>
        <g fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">${trace}</g>
        ${beads}${ends}
      </g>`;
  }

  const plate = pill(56, BAND_Y + 34, 112, route.codigo, color, 64);
  const textX = 56 + plate.w + 32;
  const textMax = WIDTH - textX - 56;
  const name = wrap(route.nombre, 62, textMax, 1)[0] ?? '';
  const sub = [route.origin ? `desde ${route.origin}` : null, `${route.stopCount} paradas`, route.horarios]
    .filter(Boolean)
    .join('  ·  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${FIELD}"/>
  ${mapClip}
  ${mapSvg}
  ${brand()}
  ${plate.svg}
  <text x="${textX.toFixed(0)}" y="${BAND_Y + 92}" font-family="Inter" font-size="62" fill="#FFFFFF">${esc(name)}</text>
  <text x="${textX.toFixed(0)}" y="${BAND_Y + 140}" font-family="Inter" font-size="28" fill="${DIM}">${esc(wrap(sub, 28, textMax, 1)[0] ?? '')}</text>
</svg>`;
}

// ─── Estación card ────────────────────────────────────────

/** The estación's pin: the same teardrop the website and the app draw, tip on
 *  the spot (`createMarkerIcon`, client/src/map.ts). */
function pinSvg(x: number, y: number): string {
  const r = 26;
  const cy = y - r * 1.55;
  return `<path d="M${(x - r * 0.81).toFixed(1)} ${(cy + r * 0.59).toFixed(1)} A${r} ${r} 0 1 1 ${(x + r * 0.81).toFixed(1)} ${(cy + r * 0.59).toFixed(1)} L${x.toFixed(1)} ${y.toFixed(1)} Z" fill="${RED}" stroke="${FIELD}" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.45).toFixed(1)}" fill="#FFFFFF"/>`;
}

/** Window around an estación: ~15 km of network across, ~5.5 km top to bottom.
 *  The backdrop is troncales only, so a tighter window was one line on an empty
 *  field around most estaciones. */
const STATION_SPAN = 0.05;

export function stationCardSvg(station: OgStation): string {
  // Centred on the estación — the map answers "where is it" — and wide enough
  // that the corridors around it say which part of the city. Without a point,
  // the whole network.
  const project = station.point
    ? makeProjector([station.point], 1, STATION_SPAN)
    : makeProjector(station.backdrop.flat(), 1.05);

  let mapSvg = `<rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}" fill="${MAP_FILL}"/>`;
  if (project) {
    const pin = station.point ? pinSvg(...project(station.point)) : '';
    const lines = station.lines.map((line) => ({
      color: safeColor(line.color),
      svg: line.paths.filter((p) => p.length > 1).map((p) => `<polyline points="${poly(p, project)}"/>`).join(''),
    }));
    // Reversed, so the first-listed service (vagón 1) is the one on top where
    // several share a corridor.
    const coloured = [...lines]
      .reverse()
      .map((l) => `<g stroke="${l.color}">${l.svg}</g>`)
      .join('');
    mapSvg = `${mapBase(station.backdrop, project)}
      <g clip-path="url(#mapclip)" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <g stroke="${OUTLINE}" stroke-width="13">${lines.map((l) => l.svg).join('')}</g>
        <g stroke-width="8">${coloured}</g>
        ${pin}
      </g>`;
  }

  const eyebrow = ['Estación', station.direccion].filter(Boolean).join('  ·  ');
  const name = wrap(station.nombre, 58, WIDTH - 112, 1)[0] ?? '';

  // One row of services, in platform order (the page has them vagón by vagón);
  // what does not fit becomes a "+N" pill rather than being dropped silently.
  const seen = new Set<string>();
  const services = [...station.vagones.flatMap((v) => v.codigos), ...station.unassigned, ...station.feeders].filter(
    (s) => !seen.has(s.codigo) && seen.add(s.codigo)
  );
  const H = 48;
  const SIZE = 28;
  const RIGHT = WIDTH - 56;
  const chips: string[] = [];
  let x = 56;
  let shown = 0;
  for (const service of services) {
    const rest = services.length - shown - 1;
    const next = pill(x, BAND_Y + 118, H, service.codigo, safeColor(service.color), SIZE);
    const room = rest > 0 ? pill(0, 0, H, `+${rest}`, '#2A303A', SIZE).w + 10 : 0;
    if (x + next.w + room > RIGHT) break;
    chips.push(next.svg);
    x += next.w + 10;
    shown++;
  }
  if (shown < services.length) chips.push(pill(x, BAND_Y + 118, H, `+${services.length - shown}`, '#2A303A', SIZE).svg);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${FIELD}"/>
  ${mapClip}
  ${mapSvg}
  ${brand()}
  <text x="56" y="${BAND_Y + 40}" font-family="Inter" font-size="26" fill="${BLUE}">${esc(wrap(eyebrow, 26, WIDTH - 112, 1)[0] ?? '')}</text>
  <text x="56" y="${BAND_Y + 100}" font-family="Inter" font-size="58" fill="#FFFFFF">${esc(name)}</text>
  ${chips.join('')}
</svg>`;
}

// ─── Rendering ────────────────────────────────────────────
let fontFile: string | null = null;

/** Decompresses the site's woff2 into a TTF resvg can load. Idempotent. */
export async function prepareFont(publicFontPath: string): Promise<void> {
  const woff2 = await readFile(publicFontPath);
  const ttf = Buffer.from(await wawoff.decompress(woff2));
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-og-'));
  fontFile = path.join(dir, 'inter.ttf');
  await writeFile(fontFile, ttf);
}

let wordmark: { w: number; h: number; d: string } | null = null;

/** Reads the name's outlines from the file the pages show (`/wordmark.svg`),
 *  so a card and the page it previews never carry two different logos. */
export async function prepareWordmark(publicSvgPath: string): Promise<void> {
  const svg = await readFile(publicSvgPath, 'utf8');
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const d = / d="([^"]+)"/.exec(svg);
  if (!box || !d) throw new Error(`${publicSvgPath} has no viewBox or path to draw.`);
  wordmark = { w: Number(box[1]), h: Number(box[2]), d: d[1] };
}

function rasterize(svg: string): Buffer {
  if (!fontFile) throw new Error('prepareFont() must run before rendering cards.');
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: 'Inter' },
  })
    .render()
    .asPng();
}

export const renderRouteCard = (route: OgRoute): Buffer => rasterize(routeCardSvg(route));
export const renderStationCard = (station: OgStation): Buffer => rasterize(stationCardSvg(station));
