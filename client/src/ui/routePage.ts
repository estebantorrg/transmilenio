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
import { carriesRutero, PANEL_CHARS, ruteroLayout, ruteroSvg } from '../../../shared/rutero.js';
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
 * Both sentidos of a código, the selected one first so it reads as "this bus".
 *
 * Siblings are narrowed to the same network: a código can exist in both at once
 * — `7` is a ruta fácil *and* a zonal service — and listing the zonal one's
 * paradas under a troncal page would describe a bus that never runs that way.
 */
function directionsOf(route: RouteListItem): RouteListItem[] {
  const siblings = routesWithCode(route.code).filter(
    (r) => r.id !== route.id && r.type === route.type
  );
  return [route, ...siblings];
}

/**
 * One panel width for every sign on the page.
 *
 * A real rutero is a fixed piece of hardware — the same number of LEDs whichever
 * way the bus is pointing. Letting each direction size its own panel drew ruta 1
 * with a tall "UNIVERSIDADES CITYU" above a visibly smaller "PORTAL EL DORADO
 * C.C NUESTRO BOGOTA", which reads as two different buses.
 */
function sharedPanelChars(variants: RouteListItem[]): number {
  return variants.reduce(
    (max, v) => Math.max(max, ruteroLayout(v.code, v.destination).columns),
    PANEL_CHARS
  );
}

function ruteroBlock(route: RouteListItem, index: number, panelChars: number): string {
  const sign = ruteroSvg({
    code: route.code,
    destination: route.destination,
    panelChars,
    uid: `${route.id.replace(/[^A-Za-z0-9]/g, '')}-${index}`,
    label: `Rutero de la ruta ${route.code} hacia ${route.destination}`,
  });
  return `
    <figure class="rutero">
      <div class="rutero-frame">${sign}</div>
      <figcaption class="rutero-caption">
        <span class="rutero-sentido">Sentido ${escapeHTML(tidy(route.origin))} → ${escapeHTML(tidy(route.destination))}</span>
      </figcaption>
    </figure>
  `;
}

function directionSection(route: RouteListItem, index: number): string {
  const count = route.stops?.length ?? 0;
  return `
    <section class="route-page-section" aria-labelledby="dir-${index}">
      <h2 class="route-page-h2" id="dir-${index}">${escapeHTML(tidy(route.origin))} → ${escapeHTML(tidy(route.destination))}</h2>
      <p class="route-page-meta">${count} ${count === 1 ? 'parada' : 'paradas'}</p>
      ${renderStopsTimeline(route, { linkStations: true })}
    </section>
  `;
}

function render(route: RouteListItem): string {
  const badgeColor = safeColor(getRouteAccentColor(route));
  const directions = directionsOf(route);
  const scheduleHtml = formatSchedule(route);
  const signs = directions.filter(hasRutero);
  const panelChars = sharedPanelChars(signs);
  const ruteros = signs.map((variant, i) => ruteroBlock(variant, i, panelChars)).join('');

  return `
    <div class="route-page-inner">
      <div class="route-page-bar">
        <button class="route-page-back" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
          <span>Ver en el mapa</span>
        </button>
        <button class="route-page-share" type="button" aria-label="Copiar enlace a esta página" title="Copiar enlace a esta página">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <span>Copiar enlace</span>
        </button>
      </div>

      <nav class="route-page-crumbs" aria-label="Ruta de navegación">
        <a href="/">Inicio</a> › <span>Ruta ${escapeHTML(route.code)}</span>
      </nav>

      <header class="route-page-header">
        <div class="route-page-badge" style="background:${badgeColor};">${escapeHTML(route.code)}</div>
        <div class="route-page-titles">
          <h1 class="route-page-h1">${escapeHTML(tidy(route.name) || route.code)}</h1>
          <p class="route-page-kind">${escapeHTML(routeSystemLabel(route))}${route.subType === 'dual' ? ` · ${escapeHTML(routeTypeLabel(route))}` : ''}</p>
        </div>
      </header>

      ${ruteros ? `
      <section class="route-page-section route-page-rutero-section" aria-labelledby="rutero-h">
        <h2 class="route-page-h2" id="rutero-h">Rutero</h2>
        <p class="route-page-meta">Tal como se ve en el bus: el letrero LED sobre el parabrisas, un sentido por letrero.</p>
        ${ruteros}
      </section>` : ''}

      <section class="route-page-section" aria-labelledby="live-h">
        <h2 class="route-page-h2" id="live-h">En vivo</h2>
        ${renderLiveCard()}
      </section>

      <section class="route-page-section" aria-labelledby="detalles-h">
        <h2 class="route-page-h2" id="detalles-h">Detalles</h2>
        ${route.busType ? `<div class="detail-row"><span class="detail-row-label">Tipo de bus</span><span class="detail-row-value">${escapeHTML(route.busType)}</span></div>` : ''}
        ${route.operator ? `<div class="detail-row"><span class="detail-row-label">Operador</span><span class="detail-row-value">${escapeHTML(route.operator)}</span></div>` : ''}
        ${route.length ? `<div class="detail-row"><span class="detail-row-label">Longitud</span><span class="detail-row-value">${route.length.toFixed(1)} km</span></div>` : ''}
        <div class="detail-row"><span class="detail-row-label">Sistema</span><span class="detail-row-value">${escapeHTML(routeSystemLabel(route))}</span></div>
        <div class="detail-row"><span class="detail-row-label">Sentidos</span><span class="detail-row-value">${directions.length}</span></div>
      </section>

      ${scheduleHtml ? `
      <section class="route-page-section" aria-labelledby="horario-h">
        <h2 class="route-page-h2" id="horario-h">Horario</h2>
        ${renderServiceStatus(route)}
        ${scheduleHtml}
      </section>` : ''}

      ${directions.map((variant, i) => directionSection(variant, i)).join('')}
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
