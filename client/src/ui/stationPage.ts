/**
 * The estación page — one station, its own URL, the whole thing on screen
 * (spec §5.5.6).
 *
 * The map popup is a card *over* the station: 340 px wide, floating on the thing
 * the reader is looking at, gone on the next click. It has to abbreviate — the
 * plan scrolls sideways inside it, the service list is a wall of chips, and
 * there is no room at all for the two facts that describe a station beyond its
 * routes: what is arriving right now, and how many people actually use it. This
 * page is the station with room for all of that, at `/estacion/<slug>-<codigo>/`
 * — the same URL the prerender publishes (§5.5.4), so a search result, a shared
 * link and the popup's own button all land on one address.
 *
 * What it draws is catalog-first and identical to the prerendered twin
 * (`getStationPageData`, `layers/stations.ts`): the same wagons, the same
 * platform plan, the same plate numbers. The live board and the ridership strip
 * are the two things only the running app can add, and both degrade to a quiet
 * line rather than to an empty section.
 *
 * The shell it opens over — masthead, inert map behind, Escape, Back/Forward —
 * is `ui/pageShell.ts`, shared with the route page (§5.5.5).
 */

import { api, type StationDemand } from '../services/api';
import { arrivalsSectionHtml, renderStopArrivals } from '../layers/arrivals';
import { closeActivePopup } from '../layers/popup';
import { buildStationWagonView, getStationPageData, type StationPageData } from '../layers/stations';
import { escapeHTML, safeColor } from '../utils/html';
import { TRONCAL_COLORS } from '../utils/routeColors';
import {
  crumbsHtml,
  factsHtml,
  isOverlayPageOpen,
  mastheadHtml,
  openOverlayPage,
  registerPageResolver,
  type OverlayPage,
} from './pageShell';
import { parseStationPathname, stationPagePath, tidy } from './routeDetail';

const PAGE_ID = 'station-page';

/**
 * The page is keyed to the **troncal the station sits on** — Autonorte green,
 * Caracas blue, Carrera 7 purple (`TRONCAL_COLORS`, §5.4.3) — the way a route
 * page is keyed to its own línea. That is the fact a rider already reads off the
 * corridor's own signage and off every route code that serves it, so two
 * estaciones on different troncales cannot look like the same page.
 *
 * The corridor is an answered fact shipped on the catalog (`stationCorridor`,
 * §5.5.6). Where there is none — a station the official maps don't cover, or
 * TransMiCable, which is not a troncal — the page falls back to the red the
 * station layer is drawn in rather than picking a corridor for it.
 */
function stationAccent(station: StationPageData): string {
  return safeColor(TRONCAL_COLORS[station.corridorLetter.toUpperCase()] ?? '', 'var(--tm-red)');
}

const nf = new Intl.NumberFormat('es-CO');

interface StationPageHandlers {
  /** Dismiss the page back to the map, with this station's popup open on it. */
  onShowOnMap: (station: StationPageData) => void;
  /** Seed the journey planner from this station and return to the map. */
  onPlan: (role: 'origin' | 'destination', station: StationPageData) => void;
  /** Open a route's own page (spec §5.5.5) from a service chip. */
  onOpenRoute: (code: string) => void;
}

let handlers: StationPageHandlers | null = null;
let openCode: string | null = null;

/**
 * The ridership dataset, fetched at most once per session and shared with
 * whatever else asks. It is ~139 rows; refetching it per page open would put a
 * request on the 0.1-CPU instance for data that changes once a day (spec §5.8).
 */
let demandPromise: Promise<StationDemand[]> | null = null;

function loadDemand(): Promise<StationDemand[]> {
  demandPromise ??= api
    .getStationDemand()
    .then((res) => (res.success && res.stations ? res.stations : []))
    .catch(() => []);
  return demandPromise;
}

/**
 * This station's row in the ridership dataset, matched on the **node id**.
 *
 * That is the only identifier the open Salidas dataset shares with this app —
 * its `codigo` is the operator's own numbering (`05000`), not the catalog's
 * `TM…`, and the station names differ between the two sources ("Portal Norte –
 * Unicervantes"). No node, no match: an approximate name match here would put
 * another station's ridership under this one's name (spec §1).
 */
function demandFor(station: StationPageData, rows: StationDemand[]): StationDemand | null {
  const nodes = new Set(station.nodes.map((n) => Number(n)).filter(Number.isFinite));
  if (nodes.size === 0) return null;
  return rows.find((row) => row.nodo !== null && nodes.has(Number(row.nodo))) ?? null;
}

/**
 * The ridership block, filled in place once the dataset lands.
 *
 * In place rather than by re-rendering the page: a full re-render would reset
 * the live arrivals slot to its placeholder and send a second request for a
 * board the reader is already looking at. A station the dataset doesn't cover
 * loses the section entirely — an empty "Demanda" heading is a claim that the
 * station has no ridership, which is not what a missing row means.
 */
function fillDemand(el: HTMLElement, station: StationPageData, rows: StationDemand[]): void {
  const section = el.querySelector<HTMLElement>('.station-demand');
  if (!section) return;
  const row = demandFor(station, rows);
  if (!row) {
    section.remove();
    return;
  }
  section.innerHTML = `
    <h2 class="page-section-title" id="demanda-h">Demanda <span class="page-count">#${row.rank}</span></h2>
    ${factsHtml([
      { label: 'Validaciones/día', value: nf.format(row.total) },
      { label: 'Entradas', value: nf.format(row.entradas) },
      { label: 'Salidas', value: nf.format(row.salidas) },
    ])}
    <p class="page-note">Promedio de días hábiles, del dataset abierto de Salidas de TRANSMILENIO S.A. El puesto es sobre las 139 estaciones troncales.</p>
  `;
}

/** The chips under the station name: what this station *is*, in one line. */
function heroChips(station: StationPageData, serviceCount: number): string {
  const chips: string[] = [station.code];
  if (station.platformCount) {
    chips.push(`${station.platformCount} ${station.platformCount === 1 ? 'vagón' : 'vagones'}`);
  }
  if (serviceCount) chips.push(`${serviceCount} servicios`);
  if (station.wifi) chips.push('WiFi');
  if (station.bikeCapacity) chips.push(`Biciparqueadero (${station.bikeCapacity})`);
  return `<ul class="station-chips">${chips
    .map((chip) => `<li class="station-chip">${escapeHTML(chip)}</li>`)
    .join('')}</ul>`;
}

function render(station: StationPageData): string {
  const view = buildStationWagonView(station.wagons, station.vagonLabels, station.wagonPlan);
  const name = tidy(station.name);

  const planoSection = view.plano
    ? `
      <section class="page-section" aria-labelledby="plano-h">
        <h2 class="page-section-title" id="plano-h">Plano de la estación</h2>
        <p class="page-note">Servicios troncales por vagón, separados por sentido. Un vagón suele atender los dos sentidos: el rumbo indicado es el de salida hacia la siguiente parada.</p>
        <div class="station-plano">${view.plano}</div>
        <p class="page-note">Esquema propio, derivado del catálogo oficial: el orden de los vagones y los servicios de cada sentido son los que el catálogo registra. No representa distancias, accesos ni la posición real de los andenes en la calle.</p>
      </section>`
    : '';

  // Counted on what this section actually holds, not on the station: where the
  // plan is drawn above, everything but the unassigned pool is already in it.
  const servicesSection = view.sections
    ? `
      <section class="page-section" aria-labelledby="servicios-h">
        <h2 class="page-section-title" id="servicios-h">Servicios${
          view.sectionCount ? ` <span class="page-count">${view.sectionCount}</span>` : ''
        }</h2>
        <div class="station-services">${view.sections}</div>
      </section>`
    : '';

  const empty =
    !view.plano && !view.sections
      ? `<section class="page-section"><p class="page-note">El catálogo oficial no asigna vagones a esta estación.</p></section>`
      : '';

  return `
    ${mastheadHtml()}

    <div class="page-inner">
      ${crumbsHtml([
        { label: 'Inicio', href: '/' },
        { label: `Estación ${name}` },
      ])}

      <header class="station-hero">
        ${station.corridor ? `<p class="station-hero-corridor">${escapeHTML(tidy(station.corridor))}</p>` : ''}
        <h1 class="station-hero-name">${escapeHTML(name)}</h1>
        ${station.direccion ? `<p class="station-hero-address">${escapeHTML(tidy(station.direccion))}</p>` : ''}
        ${heroChips(station, view.serviceCount)}
      </header>

      ${planoSection}
      ${servicesSection}
      ${empty}

      <section class="page-section" aria-labelledby="llegadas-h">
        <h2 class="page-section-title" id="llegadas-h">Próximos a llegar</h2>
        <div class="station-arrivals">${arrivalsSectionHtml(station.code)}</div>
      </section>

      <section class="page-section station-demand" aria-labelledby="demanda-h">
        <h2 class="page-section-title" id="demanda-h">Demanda</h2>
        <p class="page-note">Consultando validaciones…</p>
      </section>

      <div class="page-actions">
        <button type="button" class="page-action" data-station-plan="origin">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>
          Viajar desde aquí
        </button>
        <button type="button" class="page-action" data-station-plan="destination">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
          Viajar hasta aquí
        </button>
      </div>
    </div>
  `;
}

function descriptor(station: StationPageData): OverlayPage {
  return {
    id: PAGE_ID,
    className: 'station-page',
    path: stationPagePath(station.name, station.code),
    accent: stationAccent(station),
    render: () => render(station),
    wire: (el) => wire(el, station),
    onLeave: () => {
      openCode = null;
      handlers?.onShowOnMap(station);
    },
  };
}

function wire(el: HTMLElement, station: StationPageData): void {
  // Set here, not in `openStationPage`: the shell also opens this page straight
  // from a URL — a popup's link, Back/Forward, a search result — and the page
  // has to know which station it is showing however it got here.
  openCode = station.code;
  // The card this page came from is the same station, smaller. Two of them on
  // screen would also mean two live-arrivals slots for one stop code, and the
  // shared renderer fills the first it finds (`layers/arrivals.ts`).
  closeActivePopup();

  // The live board is the one thing on this page that has to be asked for. It
  // fills the same `.popup-arrivals` slot the popup uses, and the popup is
  // closed while the page is up (`openStationPage`), so the shared renderer
  // cannot paint the wrong one of the two.
  void renderStopArrivals(station.code);

  el.querySelectorAll<HTMLElement>('[data-station-plan]').forEach((button) => {
    button.addEventListener('click', () => {
      const role = button.dataset.stationPlan === 'destination' ? 'destination' : 'origin';
      handlers?.onPlan(role, station);
    });
  });

  // A service chip is the same tag the popup draws (`formatRouteTags`), so it
  // carries the código already; here it opens that route's own page rather than
  // selecting it on a map the reader cannot see behind this one.
  //
  // The tag is a `<span>` because on a map it is a click target inside a card a
  // pointer is already on. On a page it is the *only* way out to a route, so it
  // is promoted to something a keyboard can reach and a screen reader can name
  // (spec §1.1 R5) — done here rather than in the shared renderer, since it is
  // true of this surface and not of the popup.
  el.querySelectorAll<HTMLElement>('.route-tag.clickable[data-route-code]').forEach((tag) => {
    tag.tabIndex = 0;
    tag.setAttribute('role', 'link');
    tag.setAttribute('aria-label', `Ruta ${tag.getAttribute('data-route-code')} — ver su página`);
  });

  const openTag = (target: EventTarget | null): boolean => {
    const tag = (target as HTMLElement | null)?.closest?.('.route-tag.clickable') as HTMLElement | null;
    const code = tag?.getAttribute('data-route-code');
    if (!code) return false;
    handlers?.onOpenRoute(code);
    return true;
  };

  el.addEventListener('click', (event) => {
    if (openTag(event.target)) event.preventDefault();
  });

  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (openTag(event.target)) event.preventDefault();
  });

  void loadDemand().then((rows) => {
    // Only while this is still the page on screen: the reader may have followed
    // a service chip to a route page while the dataset was in flight.
    if (openCode === station.code && el.isConnected) fillDemand(el, station, rows);
  });
}

export function initStationPage(options: StationPageHandlers): void {
  handlers = options;
  registerPageResolver((pathname) => {
    const code = parseStationPathname(pathname);
    if (!code) return null;
    const station = getStationPageData(code);
    return station ? descriptor(station) : null;
  });
}

export function isStationPageOpen(): boolean {
  return isOverlayPageOpen(PAGE_ID);
}

/**
 * Opens the page for a catalog station code (`TM0025`).
 *
 * Returns false when the catalog has no such stop — the caller (a popup link, a
 * deep link at boot) then leaves the reader where they are rather than opening
 * an empty page about a station this app cannot describe.
 */
export function openStationPage(code: string, options: { push?: boolean } = {}): boolean {
  const station = getStationPageData(code);
  if (!station) return false;
  openOverlayPage(descriptor(station), options);
  return true;
}
