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

/** The map panel both card types share. */
const MAP = { x: 620, y: 58, w: 540, h: 514 };

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
 * backdrop.
 */
function makeProjector(focus: LonLat[], pad: number): Project | null {
  const pts = focus.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length === 0) return null;

  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  // A degenerate span (single point, or a station) still needs a sane window.
  const spanLon = Math.max((Math.max(...lons) - Math.min(...lons)) * pad, 0.02);
  const spanLat = Math.max((Math.max(...lats) - Math.min(...lats)) * pad, 0.02);
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

const mapClip = `<defs><clipPath id="mapclip"><rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}" rx="18"/></clipPath></defs>`;

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

/** Arrow drawn as geometry — the font subset has no U+2192 (see file header). */
function arrowSvg(x: number, y: number, w: number, color: string): string {
  return `<g stroke="${color}" stroke-width="3" fill="none">
    <path d="M${x} ${y} L${x + w - 8} ${y}"/>
    <path d="M${x + w - 13} ${y - 6} L${x + w} ${y} L${x + w - 13} ${y + 6}" stroke-linejoin="round"/>
  </g>`;
}

const header = () => `${markSvg(64, 56, 44)}
  <text x="124" y="87" font-family="Inter" font-size="24" fill="${DIM}">TransMilenio Explorer</text>`;

const footer = () =>
  `<text x="64" y="${HEIGHT - 44}" font-family="Inter" font-size="22" fill="#6B7280">transmilenio.onrender.com</text>`;

/** Panel fill, so the map reads as a surface rather than floating strokes. */
const mapPanel = () =>
  `<rect x="${MAP.x}" y="${MAP.y}" width="${MAP.w}" height="${MAP.h}" rx="18" fill="#10151D"/>`;

// ─── Route card ───────────────────────────────────────────
function routeCardSvg(route: OgRoute): string {
  const color = safeColor(route.color);
  const badgeW = Math.max(96, textWidth(route.codigo, 40) + 44);
  const textMax = 500;

  const focus = route.paths.flat().concat(route.stops);
  const project = makeProjector(focus, 1.45);

  let mapSvg = '';
  if (project) {
    const trace = route.paths
      .filter((p) => p.length > 1)
      .map((p) => `<polyline points="${poly(p, project)}"/>`)
      .join('');
    // Stops as beads: dark core ring keeps them legible where the trace doubles
    // back on itself.
    const beads = route.stops
      .map(project)
      .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="#FFFFFF" stroke="${FIELD}" stroke-width="1.5"/>`)
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
      .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="#FFFFFF" stroke="${color}" stroke-width="3"/>`)
      .join('');

    mapSvg = `${mapPanel()}
      ${backdropSvg(route.backdrop, project)}
      <g clip-path="url(#mapclip)">
        <g fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${trace}</g>
        ${beads}${ends}
      </g>`;
  }

  const nameLines = wrap(route.nombre, 50, textMax, 2);
  const nameSvg = nameLines
    .map((line, i) => `<text x="64" y="${296 + i * 60}" font-family="Inter" font-size="50" fill="#FFFFFF">${esc(line)}</text>`)
    .join('');
  const afterName = 296 + nameLines.length * 60;

  const origin = wrap(route.origin || '', 25, textMax, 1)[0] ?? '';
  const destination = wrap(route.destination || '', 25, textMax - 46, 1)[0] ?? '';
  const endpoints = origin && destination
    ? `<text x="64" y="${afterName + 4}" font-family="Inter" font-size="25" fill="${DIM}">${esc(origin)}</text>
       ${arrowSvg(64, afterName + 38, 34, DIM)}
       <text x="110" y="${afterName + 46}" font-family="Inter" font-size="25" fill="${DIM}">${esc(destination)}</text>`
    : '';

  const meta = [`${route.stopCount} paradas`, route.horarios].filter(Boolean).join('  ·  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${FIELD}"/>
  ${mapClip}
  ${mapSvg}
  ${header()}
  <rect x="64" y="158" width="${badgeW.toFixed(0)}" height="64" rx="14" fill="${color}"/>
  <text x="${(64 + badgeW / 2).toFixed(0)}" y="203" font-family="Inter" font-size="40" fill="${readableOn(color)}" text-anchor="middle">${esc(route.codigo)}</text>
  ${nameSvg}
  ${endpoints}
  <text x="64" y="${HEIGHT - 96}" font-family="Inter" font-size="24" fill="${BLUE}">${esc(wrap(meta, 24, textMax, 1)[0] ?? '')}</text>
  ${footer()}
</svg>`;
}

// ─── Estación card ────────────────────────────────────────
function stationCardSvg(station: OgStation): string {
  const textMax = 500;

  // Focus on the station but keep the whole network in frame, so the pin reads
  // as "here, in Bogotá" rather than as an unplaceable dot.
  const project = makeProjector(station.backdrop.flat(), 1.05);

  let mapSvg = '';
  if (project) {
    let pin = '';
    if (station.point) {
      const [x, y] = project(station.point);
      pin = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="22" fill="${BLUE}" opacity="0.22"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="${BLUE}" stroke="#FFFFFF" stroke-width="3.5"/>`;
    }
    mapSvg = `${mapPanel()}${backdropSvg(station.backdrop, project)}<g clip-path="url(#mapclip)">${pin}</g>`;
  }

  const nameLines = wrap(station.nombre, 50, textMax, 2);
  const nameSvg = nameLines
    .map((line, i) => `<text x="64" y="${232 + i * 58}" font-family="Inter" font-size="50" fill="#FFFFFF">${esc(line)}</text>`)
    .join('');
  const afterName = 232 + nameLines.length * 58;

  const address = wrap(station.direccion || 'Bogotá, Colombia', 25, textMax, 1)[0] ?? '';

  // Grouped by vagón rather than one undifferentiated grid: "which platform do I
  // stand on" is the question the station page exists to answer, and a flat pile
  // of codes doesn't answer it.
  const chips: string[] = [];
  let cy = afterName + 44;
  const BOTTOM = HEIGHT - 96;
  let omitted = 0;

  const chipRow = (
    items: Array<{ codigo: string; color?: string }>,
    startX: number,
    y: number
  ): { svg: string; endY: number; overflow: number } => {
    let x = startX;
    let row = y;
    let drawn = 0;
    const out: string[] = [];
    for (const item of items) {
      const w = Math.max(58, textWidth(item.codigo, 21) + 24);
      if (x + w > 64 + textMax) {
        x = startX;
        row += 46;
        if (row > BOTTOM) break;
      }
      const fill = safeColor(item.color);
      out.push(
        `<rect x="${x.toFixed(0)}" y="${row}" width="${w.toFixed(0)}" height="36" rx="9" fill="${fill}"/>` +
        `<text x="${(x + w / 2).toFixed(0)}" y="${row + 25}" font-family="Inter" font-size="21" fill="${readableOn(fill)}" text-anchor="middle">${esc(item.codigo)}</text>`
      );
      x += w + 9;
      drawn++;
    }
    return { svg: out.join(''), endY: row, overflow: items.length - drawn };
  };

  station.vagones.forEach((vagon, i) => {
    if (cy > BOTTOM) {
      omitted += vagon.codigos.length;
      return;
    }
    const name = vagon.label ? `Vagón ${vagon.label}` : `Plataforma ${i + 1}`;
    const heading = vagon.sentido ? `${name} · sentido ${vagon.sentido}` : name;
    chips.push(`<text x="64" y="${cy}" font-family="Inter" font-size="21" fill="${BLUE}">${esc(heading)}</text>`);
    const row = chipRow(vagon.codigos, 64, cy + 10);
    chips.push(row.svg);
    omitted += row.overflow;
    cy = row.endY + 62;
  });

  if (station.unassigned.length) {
    if (cy > BOTTOM) {
      omitted += station.unassigned.length;
    } else {
      chips.push(`<text x="64" y="${cy}" font-family="Inter" font-size="21" fill="${BLUE}">Otros servicios troncales</text>`);
      const row = chipRow(station.unassigned, 64, cy + 10);
      chips.push(row.svg);
      omitted += row.overflow;
      cy = row.endY + 62;
    }
  }

  if (station.feeders.length) {
    if (cy > BOTTOM) {
      omitted += station.feeders.length;
    } else {
      chips.push(`<text x="64" y="${cy}" font-family="Inter" font-size="21" fill="${DIM}">Alimentadores y zonales</text>`);
      const row = chipRow(station.feeders, 64, cy + 10);
      chips.push(row.svg);
      omitted += row.overflow;
      cy = row.endY + 62;
    }
  }

  // Never drop services silently — the header promises a count, so say what the
  // card could not fit rather than quietly contradicting it.
  if (omitted > 0 && cy <= HEIGHT - 70) {
    chips.push(`<text x="64" y="${cy}" font-family="Inter" font-size="20" fill="${DIM}">+${omitted} servicios más</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${FIELD}"/>
  ${mapClip}
  ${mapSvg}
  ${header()}
  <text x="64" y="172" font-family="Inter" font-size="26" fill="${BLUE}">Estación</text>
  ${nameSvg}
  <text x="64" y="${afterName + 6}" font-family="Inter" font-size="25" fill="${DIM}">${esc(address)}  ·  ${station.serviceCount} servicios</text>
  ${chips.join('')}
  ${footer()}
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
