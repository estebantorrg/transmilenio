/**
 * The route page — one route, its own URL, the whole thing on screen
 * (spec §5.5.5).
 *
 * The sidebar panel is a companion to the map: it is 360 px wide, it describes
 * the *one* direction currently drawn, and it exists to be read next to the
 * trace. A route is bigger than that. It has two sentidos, up to ~80 paradas,
 * horarios, and — the thing no other surface here could show — a **rutero**: the
 * LED sign the bus actually carries, which is how a rider on the andén decides
 * whether the bus pulling in is theirs. This page is that: `/ruta/<code>/`,
 * shareable, indexable, and the same URL the prerender already emits (§5.5.4),
 * so a search result and an in-app navigation land on one address.
 *
 * It renders *over* the map rather than replacing the shell, so the map behind
 * it keeps the route highlighted and "Ver en el mapa" is instant — no reboot, no
 * refetch. While it is up, the shell is `inert` and `aria-hidden`: a full page
 * that a screen reader can wander out of, into the tab strip of the thing it is
 * covering, is not a page.
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
import { routesWithCode } from './sidebar';

interface RoutePageHandlers {
  /** Dismiss the page back to the map, with this route selected on it. */
  onShowOnMap: (route: RouteListItem) => void;
  /** Copy/share the page's own URL. */
  onShare: (route: RouteListItem, url: string) => void;
  /** Manual live refresh — the same handler the sidebar card uses. */
  onLiveRefresh: () => void;
}

let handlers: RoutePageHandlers | null = null;
let openRoute: RouteListItem | null = null;
let lastFocus: HTMLElement | null = null;

export function initRoutePage(options: RoutePageHandlers): void {
  handlers = options;
  window.addEventListener('popstate', syncFromLocation);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openRoute) {
      event.preventDefault();
      leaveToMap();
    }
  });
}

export function isRoutePageOpen(): boolean {
  return openRoute !== null;
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
  const el = document.getElementById('route-page');
  if (!el) return;
  const scroll = el.scrollTop;
  el.innerHTML = render(route);
  el.scrollTop = scroll;
  wire(el, route);
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
 * The sign this route's bus carries over its windscreen.
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
    <figure class="rutero">
      <figcaption class="rutero-caption">Hacia ${escapeHTML(tidy(route.destination))}</figcaption>
      <div class="rutero-frame">${sign}</div>
    </figure>
  `;
}

/** A stat tile, or nothing when the route has no value for it. */
function statTile(label: string, value: string | null): string {
  if (!value) return '';
  return `
    <div class="route-stat">
      <span class="route-stat-value">${escapeHTML(value)}</span>
      <span class="route-stat-label">${escapeHTML(label)}</span>
    </div>
  `;
}

function render(route: RouteListItem): string {
  const badgeColor = safeColor(getRouteAccentColor(route));
  const scheduleHtml = formatSchedule(route);
  const ruteros = hasRutero(route) ? ruteroBlock(route) : '';
  const stopCount = route.stops?.length ?? 0;

  const stats =
    statTile('Paradas', stopCount ? String(stopCount) : null) +
    statTile('Longitud', route.length ? `${route.length.toFixed(1)} km` : null) +
    statTile('Servicio', routeTypeLabel(route)) +
    statTile('Operador', route.operator ? tidy(route.operator) : null);

  return `
    <div class="route-page-inner" style="--route-accent:${badgeColor};">
      <div class="route-page-bar">
        <button class="route-page-back" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
          <span>Ver en el mapa</span>
        </button>
        <nav class="route-page-crumbs" aria-label="Ruta de navegación">
          <a href="/">Inicio</a> <span aria-hidden="true">›</span> <span>Ruta ${escapeHTML(route.code)}</span>
        </nav>
        <button class="route-page-share" type="button" aria-label="Copiar enlace a esta página" title="Copiar enlace a esta página">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <span>Copiar enlace</span>
        </button>
      </div>

      <header class="route-page-hero">
        <div class="route-page-badge">${escapeHTML(route.code)}</div>
        <h1 class="route-page-h1">${escapeHTML(tidy(route.name) || route.code)}</h1>
        <p class="route-page-kind">${escapeHTML(routeSystemLabel(route))}</p>
        <p class="route-page-trip">
          <span>${escapeHTML(tidy(route.origin))}</span>
          <span class="route-page-arrow" aria-hidden="true"></span>
          <span>${escapeHTML(tidy(route.destination))}</span>
        </p>
      </header>

      ${ruteros ? `
      <section class="route-page-card route-page-rutero-card" aria-labelledby="rutero-h">
        <h2 class="route-page-h2" id="rutero-h">Rutero</h2>
        <p class="route-page-meta">Tal como se ve en el bus: el letrero LED sobre el parabrisas.</p>
        ${ruteros}
      </section>` : ''}

      ${stats ? `<div class="route-stats">${stats}</div>` : ''}

      <section class="route-page-card" aria-labelledby="live-h">
        <h2 class="route-page-h2" id="live-h">En vivo</h2>
        ${renderLiveCard()}
      </section>

      ${scheduleHtml ? `
      <section class="route-page-card" aria-labelledby="horario-h">
        <h2 class="route-page-h2" id="horario-h">Horario</h2>
        ${renderServiceStatus(route)}
        ${scheduleHtml}
      </section>` : ''}

      <section class="route-page-card" aria-labelledby="paradas-h">
        <h2 class="route-page-h2" id="paradas-h">Paradas${stopCount ? ` <span class="route-page-count">${stopCount}</span>` : ''}</h2>
        ${renderStopsTimeline(route, { linkStations: true })}
      </section>
    </div>
  `;
}

function shell(): HTMLElement {
  let el = document.getElementById('route-page');
  if (!el) {
    el = document.createElement('main');
    el.id = 'route-page';
    el.className = 'route-page';
    el.tabIndex = -1;
    document.body.appendChild(el);
  }
  return el;
}

/** The map, the sidebar and the FAB — everything the page covers. */
function shellChrome(): HTMLElement[] {
  return ['map', 'sidebar', 'sidebar-fab']
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);
}

/**
 * Shows the page for a route.
 *
 * `push` is false only when the URL already names this route — a visitor who
 * arrived on `/ruta/g47/` from a search result, where pushing would put a
 * duplicate entry between them and the Back button that should leave the site.
 */
export function openRoutePage(route: RouteListItem, options: { push?: boolean } = {}): void {
  const el = shell();
  const wasClosed = openRoute === null;
  if (wasClosed && document.activeElement instanceof HTMLElement) {
    lastFocus = document.activeElement;
  }
  openRoute = route;

  const path = routePagePath(route.code);
  if (options.push !== false && location.pathname !== path) {
    history.pushState({ routePage: route.code }, '', path + location.search);
  }

  // The prerendered body (spec §5.5.4) said the same things without the rutero,
  // the live card or the links; once the bundle is here it is strictly the worse
  // copy of this page, so it hands over rather than stacking behind it.
  document.getElementById('seo-prerender')?.remove();

  el.innerHTML = render(route);
  el.scrollTop = 0;
  document.body.classList.add('route-page-open');
  for (const node of shellChrome()) {
    node.toggleAttribute('inert', true);
    node.setAttribute('aria-hidden', 'true');
  }

  wire(el, route);
  if (wasClosed) el.focus();
}

function wire(el: HTMLElement, route: RouteListItem): void {
  el.querySelector('.route-page-back')?.addEventListener('click', () => leaveToMap());
  el.querySelector('.route-page-share')?.addEventListener('click', () => {
    handlers?.onShare(route, `${location.origin}${routePagePath(route.code)}`);
  });
  el.querySelector('.live-status-refresh')?.addEventListener('click', () => {
    document.querySelectorAll('.live-status-refresh').forEach((btn) => btn.classList.add('spinning'));
    handlers?.onLiveRefresh();
  });
}

/**
 * Closes the page and hands the route back to the map.
 *
 * The URL drops to `/` first: `pushRouteHash` (sidebar) deliberately leaves a
 * `/ruta/<code>/` path alone when it already names the selected route, so
 * without this the address bar would keep advertising a page that is no longer
 * on screen — and Back would re-open it out of nowhere.
 */
function leaveToMap(): void {
  const route = openRoute;
  closeRoutePage();
  if (location.pathname !== '/') history.replaceState(null, '', '/' + location.search);
  if (route) handlers?.onShowOnMap(route);
}

export function closeRoutePage(): void {
  if (!openRoute) return;
  openRoute = null;
  document.getElementById('route-page')?.remove();
  document.body.classList.remove('route-page-open');
  for (const node of shellChrome()) {
    node.toggleAttribute('inert', false);
    node.removeAttribute('aria-hidden');
  }
  lastFocus?.focus();
  lastFocus = null;
}

/**
 * Back/Forward: the page is a URL, so the browser's history has to drive it.
 * Resolving the código through the same helper the hash router uses keeps a
 * `/ruta/z8/` entry pointing at the direction the list would have picked.
 */
function syncFromLocation(): void {
  const code = parseRoutePathname();
  if (!code) {
    closeRoutePage();
    return;
  }
  const target = routesWithCode(code)[0];
  if (!target) {
    closeRoutePage();
    return;
  }
  if (openRoute?.id !== target.id) openRoutePage(target, { push: false });
}
