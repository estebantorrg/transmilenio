/**
 * The route page — one route, its own URL, the whole thing on screen
 * (spec §5.5.5).
 *
 * The sidebar panel is a companion to the map: it is 360 px wide, it describes
 * the *one* direction currently drawn, and it exists to be read next to the
 * trace. A route is bigger than that. It has up to ~80 paradas, horarios, and —
 * the thing no other surface here could show — a **rutero**: the LED sign the
 * bus actually carries, which is how a rider on the andén decides whether the
 * bus pulling in is theirs. This page is that: `/ruta/<code>/`, shareable,
 * indexable, and the same URL the prerender already emits (§5.5.4), so a search
 * result and an in-app navigation land on one address.
 *
 * The page is ordered the way a rider reads a route, not the way a database
 * lists one: the **sign first** (the object you match against the bus in front
 * of you), then the trip it makes, then its ficha técnica on one line, then the
 * things that change through the day — buses in vivo, horario — and the paradas
 * last, because that is the long list you scroll to. Everything coloured on it
 * is coloured by the route's *own* línea (`--page-accent`, `pageShell.ts`).
 *
 * The shell it opens over — masthead, inert map behind, Escape, Back/Forward —
 * is `ui/pageShell.ts`, shared with the estación page (§5.5.6).
 */

import type { RouteListItem } from '../types/transmilenio';
import { escapeHTML, safeColor } from '../utils/html';
import { getRouteAccentColor } from '../utils/routeColors';
import { carriesRutero, ruteroSvg } from '../../../shared/rutero.js';
import {
  formatSchedule,
  parseRoutePathname,
  renderLiveCard,
  renderServiceStatus,
  renderStopsTimeline,
  routePagePath,
  routeSystemLabel,
  routeTypeLabel,
  tidy,
} from './routeDetail';
import {
  crumbsHtml,
  factsHtml,
  isOverlayPageOpen,
  mastheadHtml,
  openOverlayPage,
  refreshOverlayPage,
  registerPageResolver,
  type OverlayPage,
} from './pageShell';
import { routesWithCode } from './sidebar';

const PAGE_ID = 'route-page';

interface RoutePageHandlers {
  /** Dismiss the page back to the map, with this route selected on it. */
  onShowOnMap: (route: RouteListItem) => void;
  /** Manual live refresh — the same handler the sidebar card uses. */
  onLiveRefresh: () => void;
}

let handlers: RoutePageHandlers | null = null;
let openRoute: RouteListItem | null = null;

export function initRoutePage(options: RoutePageHandlers): void {
  handlers = options;
  // Back/Forward and `/ruta/…` links anywhere in the app resolve through the
  // same helper the hash router uses, so a `/ruta/z8/` entry always points at
  // the direction the list would have picked.
  registerPageResolver((pathname) => {
    const code = parseRoutePathname(pathname);
    if (!code) return null;
    const route = routesWithCode(code)[0];
    return route ? descriptor(route) : null;
  });
}

export function isRoutePageOpen(): boolean {
  return isOverlayPageOpen(PAGE_ID);
}

/**
 * Re-renders the page when its route gains data after the fact — the full trace
 * and, for routes whose stops were empty in the list, the paradas themselves
 * arrive from `/troncal/route/:code` a moment after selection (`onRouteSelect`,
 * `main.ts`). Without this the page that a search result opens keeps showing
 * "Cargando paradas…" forever.
 */
export function refreshRoutePage(route: RouteListItem): void {
  if (openRoute?.id !== route.id) return;
  openRoute = route;
  refreshOverlayPage(descriptor(route));
}

/**
 * Whether this route's buses carry a rutero.
 *
 * `busType` is the catalog's `tipoServicio` verbatim (`buildCatalogRouteList`),
 * and every route in the list comes from the catalog — ArcGIS only enriches
 * one — so the shared predicate can be asked directly. Inventing a sign for a
 * fleet that has none would be exactly the guess priority 1 forbids.
 */
function hasRutero(route: RouteListItem): boolean {
  return carriesRutero(route.busType);
}

/**
 * The sign this route's bus carries over its windscreen, at the top of the page
 * because it is the thing a rider standing at the andén is trying to match.
 *
 * **One route, one sign.** The page used to gather every sibling filed under the
 * same código and draw a sign for each. That was wrong twice over: the catalog's
 * list items are not a clean partition by código, so a page could end up showing
 * another service's sign and another service's paradas beside its own; and even
 * where the siblings were genuinely the two sentidos, a page reached *from* one
 * direction is about that direction. The route on screen is the route the reader
 * chose, and nothing here infers a second one.
 */
function ruteroBlock(route: RouteListItem): string {
  const sign = ruteroSvg({
    code: route.code,
    destination: route.destination,
    uid: route.id.replace(/[^A-Za-z0-9]/g, ''),
    label: `Rutero de la ruta ${route.code} hacia ${tidy(route.destination)}`,
  });
  return `
    <figure class="rutero route-page-rutero">
      <div class="rutero-frame">${sign}</div>
      <figcaption class="rutero-caption">Rutero · hacia ${escapeHTML(tidy(route.destination))}</figcaption>
    </figure>
  `;
}

/**
 * Origen → destino as the line it is: two labelled ends with the route's own
 * colour running between them. The old page set this as a sentence with a drawn
 * arrow in the middle of it, which said the same words and showed nothing.
 */
function tripHtml(route: RouteListItem): string {
  const origin = tidy(route.origin);
  const destination = tidy(route.destination);
  if (!origin && !destination) return '';
  return `
    <div class="route-trip">
      <div class="route-trip-end">
        <span class="route-trip-label">Origen</span>
        <span class="route-trip-name">${escapeHTML(origin || '—')}</span>
      </div>
      <div class="route-trip-rail" aria-hidden="true"><span class="route-trip-head"></span></div>
      <div class="route-trip-end route-trip-end-to">
        <span class="route-trip-label">Destino</span>
        <span class="route-trip-name">${escapeHTML(destination || '—')}</span>
      </div>
    </div>
  `;
}

function render(route: RouteListItem): string {
  const scheduleHtml = formatSchedule(route);
  const rutero = hasRutero(route) ? ruteroBlock(route) : '';
  const stopCount = route.stops?.length ?? 0;

  const facts = factsHtml([
    { label: 'Paradas', value: stopCount ? String(stopCount) : null },
    { label: 'Longitud', value: route.length ? `${route.length.toFixed(1)} km` : null },
    { label: 'Servicio', value: routeTypeLabel(route) },
    { label: 'Operador', value: route.operator ? tidy(route.operator) : null },
  ]);

  return `
    ${mastheadHtml()}

    <div class="page-inner">
      ${crumbsHtml([
        { label: 'Inicio', href: '/' },
        { label: `Ruta ${route.code}` },
      ])}

      <header class="route-hero">
        <div class="route-hero-head">
          <span class="route-plate">${escapeHTML(route.code)}</span>
          <div class="route-hero-titles">
            <h1 class="route-hero-name">${escapeHTML(tidy(route.name) || route.code)}</h1>
            <p class="route-hero-kind">
              <span class="route-kind-tag">${escapeHTML(routeTypeLabel(route))}</span>
              <span>${escapeHTML(routeSystemLabel(route))}</span>
            </p>
          </div>
        </div>
        ${rutero}
        ${tripHtml(route)}
      </header>

      ${facts}

      <section class="page-section" aria-labelledby="live-h">
        <h2 class="page-section-title" id="live-h">En vivo</h2>
        ${renderLiveCard()}
      </section>

      ${scheduleHtml ? `
      <section class="page-section" aria-labelledby="horario-h">
        <h2 class="page-section-title" id="horario-h">Horario</h2>
        ${renderServiceStatus(route)}
        ${scheduleHtml}
      </section>` : ''}

      <section class="page-section page-section-stops" aria-labelledby="paradas-h">
        <h2 class="page-section-title" id="paradas-h">Paradas${stopCount ? ` <span class="page-count">${stopCount}</span>` : ''}</h2>
        ${renderStopsTimeline(route, { linkStations: true })}
      </section>
    </div>
  `;
}

/** This route as a page the shell can open, refresh and restore from a URL. */
function descriptor(route: RouteListItem): OverlayPage {
  return {
    id: PAGE_ID,
    className: 'route-page',
    path: routePagePath(route.code),
    accent: safeColor(getRouteAccentColor(route)),
    render: () => render(route),
    wire: (el) => wire(el, route),
    onLeave: () => {
      openRoute = null;
      handlers?.onShowOnMap(route);
    },
  };
}

export function openRoutePage(route: RouteListItem, options: { push?: boolean } = {}): void {
  openOverlayPage(descriptor(route), options);
}

function wire(el: HTMLElement, route: RouteListItem): void {
  // Tracked here, not in `openRoutePage`: the shell also opens this page
  // straight from a URL — an estación page's service chip, Back/Forward, a
  // search result — and `refreshRoutePage` has to know which route is on screen
  // whichever way it got there.
  openRoute = route;

  el.querySelector('.live-status-refresh')?.addEventListener('click', () => {
    document.querySelectorAll('.live-status-refresh').forEach((btn) => btn.classList.add('spinning'));
    handlers?.onLiveRefresh();
  });
}
