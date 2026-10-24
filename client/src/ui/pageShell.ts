/**
 * The shell every full page in this app is built from — `/ruta/<code>/`
 * (spec §5.5.5) and `/estacion/<slug>-<codigo>/` (§5.5.6).
 *
 * Both pages are the same *object*: a real URL that renders over the live map,
 * keeps the shell behind it inert, leaves on Escape or on "Ver en el mapa", and
 * answers Back/Forward because the address bar is what drives it. That plumbing
 * was written once for the route page; a second copy of it inside the estación
 * page would be a second set of answers to "is a page open", "who holds the
 * focus", "does Back close or navigate" (spec §1.1 R2) — so it lives here and
 * each page supplies only what makes it that page: its path, its accent and its
 * body.
 *
 * The two rules that make the pages feel like one site:
 *
 * - **One masthead.** Emitted here, not by the page, so the brand lockup, the
 *   way out and the share action sit in the same place at the same size on both.
 * - **One accent variable.** `--page-accent` is set on the page root from the
 *   subject itself — a route's own colour, an estación's red — and everything
 *   that carries colour on the page (the rail under the masthead, the código
 *   plate, the timeline spine) reads it. A page never hard-codes a hue.
 */

import { escapeHTML } from '../utils/html';
import type { Resumen } from '../../../shared/resumen.js';

const CHROME_IDS = ['map', 'sidebar', 'sidebar-fab'];
/** A stable asset name CI publishes beside the versioned one (`android-apk.yml`). */
const APP_DOWNLOAD_URL = 'https://github.com/estebantorrg/transmilenio/releases/latest/download/mitrasto.apk';
const APP_DISMISSED_KEY = 'tm.appPromo.dismissed';

export interface OverlayPage {
  /** DOM id of the page element. Stable per kind of page, not per subject. */
  id: string;
  /** Extra class on the page root (`route-page`, `station-page`). */
  className: string;
  /** Canonical pathname this page lives at — its identity while open. */
  path: string;
  /** Colour the page is keyed to (`--page-accent`). Must already be safe CSS. */
  accent: string;
  render: () => string;
  /** Page-specific listeners. Re-run after every render, so it may not assume
   *  it is called once. */
  wire: (el: HTMLElement) => void;
  /** "Ver en el mapa" — hand the subject back to the map behind the page. */
  onLeave: () => void;
}

/** Resolves a pathname to the page that should be open at it, or null. */
type PageResolver = (pathname: string) => OverlayPage | null;

const resolvers: PageResolver[] = [];
let shareHandler: ((url: string) => void) | null = null;
let current: OverlayPage | null = null;
let lastFocus: HTMLElement | null = null;
let initialized = false;
const closeWaiters: Array<() => void> = [];

/**
 * Wired once at module scope from `main.ts`: the Back/Forward listener has to
 * exist before the first navigation, not after the catalog resolves.
 */
export function initPageShell(options: { onShare: (url: string) => void }): void {
  shareHandler = options.onShare;
  if (initialized) return;
  initialized = true;

  window.addEventListener('popstate', syncFromLocation);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current) {
      event.preventDefault();
      leaveOverlayPage();
    }
  });
  document.addEventListener('click', interceptPageLink);
}

export function registerPageResolver(resolver: PageResolver): void {
  resolvers.push(resolver);
}

function resolvePage(pathname: string): OverlayPage | null {
  for (const resolver of resolvers) {
    const page = resolver(pathname);
    if (page) return page;
  }
  return null;
}

export function isOverlayPageOpen(id?: string): boolean {
  if (!current) return false;
  return id ? current.id === id : true;
}

/**
 * Resolves once no page is open — at once when none is. For work that only
 * feeds the map behind a page, which a reader who came for the page and left
 * never sees.
 */
export function overlayPageClosed(): Promise<void> {
  return current ? new Promise((resolve) => closeWaiters.push(resolve)) : Promise.resolve();
}

/**
 * In-page links to another page of this site (`/ruta/…`, `/estacion/…`) are real
 * anchors — they middle-click, they copy, a crawler follows them — so the only
 * thing intercepted is the plain left click, which becomes a `pushState`
 * navigation between two views that are already on screen. Anything the browser
 * owns (a modified click, another origin, `target=_blank`) is left alone.
 */
function interceptPageLink(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;

  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return;

  // The masthead's brand and the "Inicio" crumb: the map is already behind the
  // page, so going home is closing it, not reloading the app.
  if (current && url.pathname === '/' && !url.hash) {
    event.preventDefault();
    dismissOverlayPage();
    return;
  }

  const page = resolvePage(url.pathname);
  if (!page) return;

  event.preventDefault();
  openOverlayPage(page);
}

function pageElement(page: OverlayPage): HTMLElement {
  let el = document.getElementById(page.id);
  if (!el) {
    el = document.createElement('main');
    el.id = page.id;
    el.tabIndex = -1;
    document.body.appendChild(el);
  }
  el.className = `overlay-page ${page.className}`;
  el.style.setProperty('--page-accent', page.accent);
  return el;
}

function setChromeInert(inert: boolean): void {
  for (const id of CHROME_IDS) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.toggleAttribute('inert', inert);
    if (inert) node.setAttribute('aria-hidden', 'true');
    else node.removeAttribute('aria-hidden');
  }
}

/**
 * Shows a page.
 *
 * `push` is false only when the URL already names it — a visitor who arrived on
 * `/ruta/g47/` from a search result, where pushing would wedge a duplicate entry
 * in front of the Back that should leave the site.
 */
export function openOverlayPage(page: OverlayPage, options: { push?: boolean } = {}): void {
  const wasClosed = current === null;
  if (wasClosed && document.activeElement instanceof HTMLElement) {
    lastFocus = document.activeElement;
  }
  // Switching kinds (a parada link on a route page) retires the other element:
  // two overlay pages stacked would both claim the viewport and the focus.
  if (current && current.id !== page.id) document.getElementById(current.id)?.remove();
  current = page;

  if (options.push !== false && location.pathname !== page.path) {
    history.pushState({ overlayPage: page.path }, '', page.path + location.search);
  }

  // The prerendered body (spec §5.5.4) says the same things without the live
  // data, the diagrams or the links; once the bundle is here it is strictly the
  // worse copy of this page, so it hands over rather than stacking behind.
  document.getElementById('seo-prerender')?.remove();

  const el = pageElement(page);
  el.innerHTML = page.render();
  el.scrollTop = 0;
  document.body.classList.add('overlay-page-open');
  setChromeInert(true);

  wireShell(el, page);
  page.wire(el);
  if (wasClosed) el.focus();
}

/**
 * Re-renders the open page in place, keeping the reader where they were.
 *
 * Both pages gain data after the fact — a route's paradas arrive from
 * `/troncal/route/:code` a moment after selection, an estación's demand from its
 * own endpoint — and without this the page a search result opens keeps showing
 * the placeholder forever.
 */
export function refreshOverlayPage(page: OverlayPage): void {
  if (current?.id !== page.id || current.path !== page.path) return;
  current = page;
  const el = document.getElementById(page.id);
  if (!el) return;
  const scroll = el.scrollTop;
  el.innerHTML = page.render();
  el.scrollTop = scroll;
  wireShell(el, page);
  page.wire(el);
}

function wireShell(el: HTMLElement, page: OverlayPage): void {
  el.querySelector('.page-back')?.addEventListener('click', () => leaveOverlayPage());
  el.querySelector('.page-share')?.addEventListener('click', () => {
    shareHandler?.(`${location.origin}${page.path}`);
  });
  el.querySelector('.page-app-close')?.addEventListener('click', () => {
    try {
      localStorage.setItem(APP_DISMISSED_KEY, '1');
    } catch {
      // Blocked storage: the card simply comes back on the next render.
    }
    el.querySelector('.page-app')?.remove();
  });
}

/**
 * Closes the page and hands its subject back to the map.
 *
 * The URL drops to `/` first: the sidebar's `pushRouteHash` deliberately leaves
 * a page path alone when it already names the selected subject, so without this
 * the address bar would keep advertising a page that is no longer on screen —
 * and Back would re-open it out of nowhere.
 */
export function leaveOverlayPage(): void {
  const page = current;
  dismissOverlayPage();
  page?.onLeave();
}

/**
 * Closes the page and returns the address bar to the app, *without* handing the
 * subject back to the map. This is the exit for a reader who is going somewhere
 * else entirely — seeding the planner from an estación, say — where re-opening
 * the station's popup on the way out would fight the panel they just asked for.
 */
export function dismissOverlayPage(): void {
  closeOverlayPage();
  if (location.pathname !== '/') history.replaceState(null, '', '/' + location.search);
}

export function closeOverlayPage(): void {
  if (!current) return;
  const id = current.id;
  current = null;
  document.getElementById(id)?.remove();
  document.body.classList.remove('overlay-page-open');
  setChromeInert(false);
  lastFocus?.focus();
  lastFocus = null;
  closeWaiters.splice(0).forEach((resolve) => resolve());
}

/** Back/Forward: the page is a URL, so the browser's history has to drive it. */
function syncFromLocation(): void {
  const page = resolvePage(location.pathname);
  if (!page) {
    closeOverlayPage();
    return;
  }
  if (current?.id !== page.id || current.path !== page.path) {
    openOverlayPage(page, { push: false });
  }
}

/**
 * The site's own header, not a toolbar a page invented: the sidebar's brand
 * lockup over the same glass and hairline, with the way out on the left and the
 * share action on the right. Sticky, because the way out of a 60-parada page has
 * to be on screen wherever the reader has got to.
 *
 * "Ver en el mapa" only on a page whose subject is on the map (a route, an
 * estación); elsewhere the brand is the way home and the cell stays empty so
 * the brand keeps the centre.
 */
export function mastheadHtml(options: { mapSubject?: boolean } = {}): string {
  const back =
    options.mapSubject === false
      ? '<span></span>'
      : `<button class="page-back" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
          <span>Ver en el mapa</span>
        </button>`;
  return `
    <header class="page-bar">
      <div class="page-bar-inner">
        ${back}
        <a class="page-brand" href="/" aria-label="Inicio — MiTrasto">
          <img class="page-logo" src="/icon-192.png" alt="" width="34" height="34" />
          <span class="page-brand-text">
            <span class="page-brand-title"><img class="wordmark" src="/wordmark.svg" alt="" width="72" height="14" /></span>
            <span class="page-brand-sub">Rutas de Bogotá</span>
          </span>
        </a>
        <button class="page-share" type="button" aria-label="Copiar enlace a esta página" title="Copiar enlace a esta página">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <span>Copiar enlace</span>
        </button>
      </div>
      <!-- The subject's own colour, full bleed: a route's línea, an estación's
           red. It is the one thing that tells two pages of the same shape apart
           at a glance, so it sits where the eye lands first. -->
      <div class="page-rail" aria-hidden="true"></div>
    </header>
  `;
}

/**
 * The ficha técnica strip both pages carry — a route's paradas/longitud/
 * operador, an estación's ridership — as one hairline-divided row rather than as
 * a grid of identical boxes.
 *
 * It is one strip on purpose: these are the facts you read *across*, and four
 * separate cards gave each of them the visual weight of a section. Cells with no
 * value are dropped rather than rendered empty, since the two pages carry
 * different subsets (a route has no ridership, an estación off the ridership
 * dataset has no counts).
 */
export function factsHtml(items: Array<{ label: string; value: string | null | undefined }>): string {
  const cells = items
    .filter((item) => item.value)
    .map(
      (item) => `
      <div class="page-fact">
        <dt class="page-fact-label">${escapeHTML(item.label)}</dt>
        <dd class="page-fact-value">${escapeHTML(String(item.value))}</dd>
      </div>`
    )
    .join('');
  return cells ? `<dl class="page-facts">${cells}</dl>` : '';
}

/**
 * The Android app, offered inside a page's live section — where the website is
 * weakest: its live data goes through our server and public proxies, while the
 * app asks from the rider's own phone. Android only (there is no iOS app, and a
 * desktop cannot install an APK), inline and closable for good — never an
 * interstitial: these readers come from search, and a page whose content is
 * covered on a phone ranks lower.
 *
 * Installed outside Play, the APK meets Play Protect's "Se recomienda analizar
 * la app" dialog. A warning the rider was told about reads as a step, one sprung
 * on them reads as a virus — so the card names it, in Google's own es-419 words,
 * and says which button to tap.
 */
export function appPromoHtml(): string {
  if (!/Android/i.test(navigator.userAgent)) return '';
  try {
    if (localStorage.getItem(APP_DISMISSED_KEY)) return '';
  } catch {
    // Unreadable storage: offer it; closing it is what that would remember.
  }
  return `
    <aside class="page-app" aria-labelledby="page-app-h">
      <img class="page-app-icon" src="/icon-192.png" alt="" width="44" height="44" />
      <div class="page-app-text">
        <h3 class="page-app-title" id="page-app-h">Más rápido en la app</h3>
        <p class="page-app-body">Con MiTrasto para Android ves los buses en vivo directo desde tu celular, consultas el saldo de tu tarjeta acercándola al teléfono y te guía mientras viajas.</p>
        <a class="page-app-get" href="${APP_DOWNLOAD_URL}">Descargar para Android</a>
        <p class="page-app-hint">Gratis y de código abierto. Como no viene de Play Store, Android te pedirá dos confirmaciones:</p>
        <ol class="page-app-steps">
          <li>Permitir que tu navegador instale apps.</li>
          <li>Si aparece «Se recomienda analizar la app», toca <strong>Analizar app</strong>: Google la revisa y te deja instalarla.</li>
        </ol>
      </div>
      <button class="page-app-close" type="button" aria-label="No volver a mostrar" title="No volver a mostrar">×</button>
    </aside>`;
}

/** The search questions a page answers (`shared/resumen.js`), a section each —
 *  the same ones the prerendered body carries (spec §5.5.4). */
export function resumenesHtml(resumenes: Array<Resumen | null>): string {
  return resumenes
    .filter((r): r is Resumen => r !== null)
    .map((r, i) => `
      <section class="page-section" aria-labelledby="resumen-h-${i}">
        <h2 class="page-section-title" id="resumen-h-${i}">${escapeHTML(r.pregunta)}</h2>
        <p class="page-note">${escapeHTML(r.respuesta)}</p>
      </section>`)
    .join('');
}

/** `Inicio › Ruta G47` — the last item is the page itself and is never a link.
 *  Labels are catalog text and are escaped here (spec §3.3), so callers pass
 *  them raw; hrefs are built from the slugified path helpers. */
export function crumbsHtml(trail: Array<{ label: string; href?: string }>): string {
  const items = trail
    .map((item, i) => {
      const last = i === trail.length - 1;
      const label = escapeHTML(item.label);
      const node = item.href && !last ? `<a href="${item.href}">${label}</a>` : `<span>${label}</span>`;
      return last ? node : `${node} <span class="page-crumb-sep" aria-hidden="true">›</span>`;
    })
    .join(' ');
  return `<nav class="page-crumbs" aria-label="Ruta de navegación">${items}</nav>`;
}
