/**
 * Route presentation shared by the two surfaces that describe a route: the
 * sidebar detail panel (`ui/sidebar.ts`) and the dedicated route page
 * (`ui/routePage.ts`, spec §5.5.5).
 *
 * These lived inside the sidebar until the route page existed. Copying them
 * would have meant two answers to "is this route running right now" and two
 * schedule tables drifting apart (spec §1.1 R2) — the horarios in particular are
 * parsed windows the planner also enforces (§5.6.2), so a second renderer is a
 * second chance to disagree with the itineraries.
 */

import type { RouteListItem } from '../types/transmilenio';
import { escapeHTML } from '../utils/html';
import { bogotaNow, describeServiceSpans, serviceStatus } from '../services/schedule';
import { isAlimentadorRoute } from '../utils/routeColors';

/** A station code of this shape is a troncal estación with a prerendered page. */
const TRONCAL_STATION = /^TM\d+$/i;

/**
 * Catalog names carry upstream double spaces ("Portal 20  de Julio"). Collapse
 * runs of whitespace for display only — the same `tidy` the prerender applies,
 * so a page and its crawlable twin spell a destination the same way.
 */
export function tidy(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Diacritic-free, lowercase, hyphenated. Mirrors `slugify` in the prerender. */
export function slugifyRoute(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The prerendered estación page for a stop, or null when the stop is a zonal
 * paradero (those are deliberately not emitted — spec §5.5.4).
 */
export function stationPageHref(stop: { nombre: string; codigo: string }): string | null {
  if (!TRONCAL_STATION.test(String(stop.codigo || ''))) return null;
  return `/estacion/${slugifyRoute(stop.nombre)}-${slugifyRoute(stop.codigo)}/`;
}

/** The route's own page (spec §5.5.5) — the same URL the prerender emits. */
export function routePagePath(code: string): string {
  return `/ruta/${encodeURIComponent(slugifyRoute(code))}/`;
}

/**
 * The código named by a `/ruta/<code>/` pathname, or null.
 *
 * Prerendered route pages are served at a real path because crawlers drop
 * fragments (spec §5.5.4), and the route page keeps that URL when the bundle
 * takes over — so this is the one parser for both the SEO entry point and the
 * in-app navigation.
 */
export function parseRoutePathname(pathname: string = location.pathname): string | null {
  const match = pathname.match(/^\/ruta\/([^/]+)\/?$/);
  if (!match) return null;
  const code = decodeURIComponent(match[1]).trim();
  return code || null;
}

/** Short uppercase family label shown under the route name (TRONCAL / ZONAL / …).
 *  Alimentador is tested first for the same reason `subType` resolves it first
 *  (`buildCatalogRouteList`): a feeder that reaches a portal is not a padrón. */
export function routeTypeLabel(route: RouteListItem): string {
  if (isAlimentadorRoute(route) || route.subType === 'alimentador') return 'ALIMENTADOR';
  if (route.subType === 'dual') return 'PADRÓN';
  return route.type === 'troncal' ? 'TRONCAL' : 'ZONAL';
}

/**
 * Long-form name for the "Sistema" row.
 *
 * Alimentadores are typed `zonal` (they feed the portals and serve paraderos),
 * but they are TransMilenio's own buses — calling them "SITP Zonal" names the
 * wrong operator to a rider deciding which door to wait at.
 */
export function routeSystemLabel(route: RouteListItem): string {
  if (isAlimentadorRoute(route) || route.subType === 'alimentador') return 'TransMilenio Alimentador';
  if (route.subType === 'dual') return 'TransMilenio Dual';
  return route.type === 'troncal' ? 'TransMilenio Troncal' : 'SITP Zonal';
}

/**
 * Schedule table for a route. Parsed windows (§5.6.2) are the source of truth —
 * the same data the planner enforces — so the panel can never disagree with the
 * itineraries. The legacy string parsing below stays only for routes whose hours
 * could not be parsed at all.
 */
export function formatSchedule(route: RouteListItem): string {
  const spans = route.serviceSpans;
  if (spans && spans.length > 0) {
    const rows = describeServiceSpans(spans)
      .map(
        (row) => `<tr>
      <td class="schedule-day">${escapeHTML(row.days)}</td>
      <td class="schedule-time">${escapeHTML(row.hours)}</td>
    </tr>`
      )
      .join('');
    return `<table class="schedule-table"><tbody>${rows}</tbody></table>`;
  }
  return formatScheduleText(route.schedule);
}

/** "Now" chip: is this route running at this moment, and until/from when. */
export function renderServiceStatus(route: RouteListItem): string {
  const status = serviceStatus(route.serviceSpans, bogotaNow());
  if (status.state === 'unknown') return '';
  return `
    <div class="detail-service ${status.state}">
      <span class="detail-service-dot"></span>
      <span class="detail-service-label">${escapeHTML(status.label)}</span>
      ${status.detail ? `<span class="detail-service-detail">${escapeHTML(status.detail)}</span>` : ''}
    </div>
  `;
}

export function formatScheduleText(scheduleRaw: string | undefined): string {
  if (!scheduleRaw) return '';

  // Format string by splitting on "/" or "|"
  const parts = scheduleRaw.split(/[/|]/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  let html = '<table class="schedule-table"><tbody>';

  parts.forEach(part => {
    // Basic heuristic: separate text (day) and time (e.g. 05:00-22:00)
    const match = part.match(/^(.*?)\s+((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}.*))$/i);
    let day = part;
    let time = '';

    if (match) {
      day = match[1].trim();
      time = match[2].trim();
    } else {
      // Also try to capture things like "Lunes a Viernes 4:00 am - 11:00 pm"
      const parts2 = part.split(/(\d{1,2}:\d{2}.*)/i);
      if (parts2.length > 1) {
        day = parts2[0].trim();
        time = parts2[1].trim();
      }
    }

    // Normalize common abbreviations
    const normalizedDay = day
      .replace(/^L-V$/i, 'Lunes a Viernes')
      .replace(/^S$/i, 'Sábados')
      .replace(/^D-F$/i, 'Dom. y Festivos')
      .replace(/^D-F-A$/i, 'Dom. y Festivos')
      .replace(/^L-S$/i, 'Lunes a Sábado')
      .replace(/^L-D$/i, 'Lunes a Domingo');

    html += `<tr>
      <td class="schedule-day">${escapeHTML(normalizedDay)}</td>
      <td class="schedule-time">${escapeHTML(time)}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  return html;
}

/**
 * The live-tracking card, in its pre-first-fix state.
 *
 * Class-addressed, never id-addressed: the sidebar panel and the route page can
 * be mounted at the same time, and `updateLiveBusStatus` paints *every* card on
 * the page from one fix so the two can never disagree.
 */
export function renderLiveCard(): string {
  return `
    <div class="live-tracking-status loading">
      <div class="live-card-main">
        <span class="live-status-dot pulse loading"></span>
        <div class="live-status-textcol">
          <span class="live-status-text">Conectando con buses en vivo…</span>
          <span class="live-status-sub"></span>
        </div>
      </div>
      <div class="live-card-side">
        <span class="live-status-chip loading">Buscando…</span>
        <button class="live-status-refresh" type="button" aria-label="Actualizar ahora" title="Actualizar ahora">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
      </div>
    </div>
  `;
}

/**
 * The ordered stop list as a timeline.
 *
 * `linkStations` turns every troncal estación into a link to its own prerendered
 * page (spec §5.5.4). The sidebar leaves it off — there a stop row opens the
 * station popup on the map beside it, and a navigation would throw that away.
 */
export function renderStopsTimeline(
  route: RouteListItem,
  options: { linkStations?: boolean } = {}
): string {
  const stops = route.stops;
  if (!stops || stops.length === 0) {
    return '<div class="stops-empty">Cargando paradas…</div>';
  }

  let html = '<div class="stops-timeline">';
  stops.forEach((stop, i) => {
    const isFirst = i === 0;
    const isLast = i === stops.length - 1;
    const dotClass = isFirst ? 'origin' : isLast ? 'destination' : 'intermediate';
    const label = isFirst ? 'Origen' : isLast ? 'Destino' : '';
    const href = options.linkStations ? stationPageHref(stop) : null;
    const name = escapeHTML(stop.nombre);

    html += `
      <div class="timeline-stop ${dotClass}" data-index="${i}">
        <div class="timeline-dot-col">
          <div class="timeline-dot ${dotClass}"></div>
          ${!isLast ? '<div class="timeline-line"></div>' : ''}
        </div>
        <div class="timeline-stop-info">
          <div class="timeline-stop-name">${href ? `<a href="${href}">${name}</a>` : name}</div>
          ${label ? `<div class="timeline-stop-label">${label}</div>` : ''}
          ${stop.direccion ? `<div class="timeline-stop-code">${escapeHTML(stop.direccion)}</div>` : (stop.codigo ? `<div class="timeline-stop-code"># ${escapeHTML(stop.codigo)}</div>` : '')}
        </div>
      </div>
    `;
  });
  html += '</div>';
  return html;
}
