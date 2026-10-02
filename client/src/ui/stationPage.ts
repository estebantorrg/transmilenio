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
import {
  buildStationWagonView,
  getStationPageData,
  stationCodeTagsHtml,
  wirePlanoScroll,
  type StationPageData,
} from '../layers/stations';
import { escapeHTML, safeColor } from '../utils/html';
import { avisosSlotHtml, watchAvisos } from './avisos';
import { TRONCAL_COLORS } from '../utils/routeColors';
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
import { parseStationPathname, stationPagePath, tidy } from './routeDetail';
import { platformsOf } from '../../../shared/station_platforms.js';

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
 *
 * The **window travels with the rows**. A ridership figure is a measurement of
 * some days, and which days is part of the figure: the dataset is a rolling
 * mean regenerated when the upstream Salidas window advances, so a page that
 * printed the number alone was claiming a permanence it does not have.
 */
interface DemandData {
  stations: StationDemand[];
  days: number;
  window: { from: string; to: string } | null;
}

let demandPromise: Promise<DemandData> | null = null;

function loadDemand(): Promise<DemandData> {
  demandPromise ??= api
    .getStationDemand()
    .then((res) => ({
      stations: res.success && res.stations ? res.stations : [],
      days: res.days ?? 0,
      window: res.window ?? null,
    }))
    .catch(() => ({ stations: [], days: 0, window: null }));
  return demandPromise;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * `20260813` → `13 ago 2026`.
 *
 * Parsed by parts, never through `new Date('2026-08-13')`: that is read as UTC
 * midnight and printed in the reader's zone, so the same string renders as the
 * 12th for anyone west of Greenwich — Bogotá included, which is the whole
 * audience. These are dates, not instants.
 */
function demandDate(value: string | undefined): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value ?? ''));
  if (!match) return '';
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : '';
}

/** "de los 15 días hábiles entre el 23 jul 2026 y el 13 ago 2026", as far as
 *  the dataset actually says — each clause is dropped when its field is absent
 *  rather than filled with a guess. */
function demandPeriod(data: DemandData): string {
  const days = data.days > 0 ? `${data.days} días hábiles` : 'días hábiles';
  const from = demandDate(data.window?.from);
  const to = demandDate(data.window?.to);
  if (!from || !to) return `Promedio de ${days}`;
  return `Promedio de ${days} entre el ${from} y el ${to}`;
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
function fillDemand(el: HTMLElement, station: StationPageData, data: DemandData): void {
  const section = el.querySelector<HTMLElement>('.station-demand');
  if (!section) return;
  const row = demandFor(station, data.stations);
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
    <p class="page-note">${escapeHTML(demandPeriod(data))}, del dataset abierto de Salidas de TRANSMILENIO S.A. El puesto es sobre las 139 estaciones troncales.</p>
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

const planActionsHtml = `
      <div class="page-actions">
        <button type="button" class="page-action" data-station-plan="origin">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>
          Viajar desde aquí
        </button>
        <button type="button" class="page-action" data-station-plan="destination">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
          Viajar hasta aquí
        </button>
      </div>`;

/** The halves of a stop the catalog files as one, each as a page of its own. */
interface Half {
  href: string;
  station: StationPageData;
  serviceCount: number;
  tunnel: boolean;
}

function halvesOf(code: string): Half[] {
  return platformsOf(code).flatMap((platform) => {
    const station = getStationPageData(platform.codigo);
    if (!station) return [];
    const view = buildStationWagonView(station.wagons, station.vagonLabels, station.wagonPlan, station.corridorSentidos, station.planoLayout, station.code, station.planoDetalle, station.planoGeo);
    return [{ href: stationPagePath(platform.nombre, platform.codigo), station, serviceCount: view.serviceCount, tunnel: Boolean(platform.tunelA) }];
  });
}

/**
 * The page at the stop's own URL, for the two stops the catalog files as one
 * (Ricaurte, Av. Jiménez): a choice between its halves, not a drawing of both.
 *
 * Each half is a station on its own troncal with its own vagones and no service
 * in common with the other, and each has its own page. Nothing on the site
 * links here any more — a route page links the half it stops at — but this is
 * the address a search for "Ricaurte" finds and the one every link shared
 * before the split points at, and that reader does not yet know which half
 * they need. So the page answers that one question: the two halves, each with
 * its troncal and the códigos that stop there, so "I am taking the G43" picks
 * one. The tunnel is named only where it is open — Av. Jiménez's own plano
 * strikes its tunnel through, so there the page says that instead.
 */
function renderChooser(station: StationPageData, halves: Half[]): string {
  const name = tidy(station.name);
  const tunnel = halves.every((h) => h.tunnel);
  const cuantas = halves.length === 2 ? 'dos' : String(halves.length);
  const joined = tunnel
    ? 'en troncales distintas, unidas por un túnel peatonal'
    : 'en troncales distintas; el túnel entre ellas figura cerrado en su plano oficial';
  const cards = halves
    .map(({ href, station: half, serviceCount }) => {
      const accent = stationAccent(half);
      const facts = [
        half.corridor ? `Troncal ${tidy(half.corridor)}` : '',
        half.platformCount ? `${half.platformCount} ${half.platformCount === 1 ? 'vagón' : 'vagones'}` : '',
        serviceCount ? `${serviceCount} servicios` : '',
      ].filter(Boolean);
      return `
        <li>
          <a class="station-choice" href="${href}" style="--choice-accent:${accent}">
            <span class="station-choice-head">
              <span class="station-choice-name">${escapeHTML(tidy(half.name))}</span>
              <span class="station-choice-arrow" aria-hidden="true"></span>
            </span>
            <span class="station-choice-facts">${escapeHTML(facts.join(' · '))}</span>
            <span class="station-choice-tags">${stationCodeTagsHtml(half.wagons)}</span>
          </a>
        </li>`;
    })
    .join('');

  return `
    ${mastheadHtml()}

    <div class="page-inner">
      ${crumbsHtml([
        { label: 'Inicio', href: '/' },
        { label: `Estación ${name}` },
      ])}

      <header class="station-hero">
        <p class="station-hero-corridor">${cuantas[0].toUpperCase() + cuantas.slice(1)} estaciones</p>
        <h1 class="station-hero-name">${escapeHTML(name)}</h1>
        ${station.direccion ? `<p class="station-hero-address">${escapeHTML(tidy(station.direccion))}</p>` : ''}
      </header>

      <section class="page-section" aria-labelledby="eleccion-h">
        <h2 class="page-section-title" id="eleccion-h">¿A cuál vas?</h2>
        <p class="page-note">${escapeHTML(name)} son ${cuantas} estaciones ${joined}. Cada una tiene sus propios vagones y no comparten servicios: elige la de la ruta que vas a tomar.</p>
        <ul class="station-choices">${cards}</ul>
      </section>
      ${planActionsHtml}
    </div>
  `;
}

function render(station: StationPageData): string {
  const halves = halvesOf(station.code);
  if (halves.length > 1) return renderChooser(station, halves);
  const view =buildStationWagonView(station.wagons, station.vagonLabels, station.wagonPlan, station.corridorSentidos, station.planoLayout, station.code, station.planoDetalle, station.planoGeo);
  const name = tidy(station.name);

  const planoSection = view.plano
    ? `
      <section class="page-section" aria-labelledby="plano-h">
        <h2 class="page-section-title" id="plano-h">Plano de la estación</h2>
        <p class="page-note">Servicios troncales por vagón, separados por sentido. Un vagón suele atender los dos sentidos: el rumbo indicado es el de salida hacia la siguiente parada.</p>
        <div class="station-plano">${view.plano}</div>
        ${view.detallado
          ? `<p class="page-note">Esquema propio, dibujado a partir del <em>plano de ubicación</em> oficial de la estación: los vagones, sus números, los servicios de cada lado, y los accesos, taquillas, torniquetes y salidas que el plano señala. No representa distancias ni la posición real de los andenes en la calle.</p>`
          : `<p class="page-note">Esquema propio, dibujado como el <em>plano de ubicación</em> de la estación: un vagón por segmento, con los servicios de cada sentido arriba y abajo. Los vagones, sus números y los servicios de cada lado son los que registra el catálogo oficial. No incluye salidas, taquillas, torniquetes ni puentes peatonales, y no representa distancias ni la posición real de los andenes en la calle.</p>`
        }
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

      ${avisosSlotHtml(station.avisos, 'station-avisos')}

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

      ${planActionsHtml}
    </div>
  `;
}

function descriptor(station: StationPageData): OverlayPage {
  return {
    id: PAGE_ID,
    className: 'station-page',
    path: stationPagePath(station.name, station.code),
    // The chooser is on no one troncal — its halves are — so it takes the
    // station layer's red rather than the parent stop's corridor.
    accent: platformsOf(station.code).length ? 'var(--tm-red)' : stationAccent(station),
    render: () => render(station),
    wire: (el) => wire(el, station),
    onLeave: () => {
      openCode = null;
      handlers?.onShowOnMap(station);
    },
  };
}

/** The widest a figure is on this page, as the portal plans have it: 1320px, or
 *  the view less a 24px gutter each side. */
const LIENZO_MAX = 1320;
const GUTTER = 24;

/**
 * The column-drawn plan, fitted to the page the way a portal's is.
 *
 * It was drawn at one scale (`--tm-scale: 1.3`) inside the 760px text column,
 * so a station of three vagones with two crossings and a bridge ran past the
 * column's edge on an ordinary laptop window — "Vagón 1 · 4 serv…" under the
 * fade — and scrolled sideways while 300px of the page sat empty either side.
 * Now it is a figure: as large as its page scale where the screen has the room,
 * stepping out of the column centred on its axis to get it; smaller as the room
 * shrinks, down to the popup's own scale; and only below that does it scroll
 * inside its own box. The width is measured, not estimated, because a vagón is
 * as wide as its longest row of tags.
 */
function fitPlan(el: HTMLElement): void {
  const box = el.querySelector<HTMLElement>('.station-plano');
  const plano = box?.querySelector<HTMLElement>(':scope > .popup-plano:not(.popup-plano-portal)');
  const inner = plano?.querySelector<HTMLElement>(':scope > .popup-plano-inner');
  const column = box?.parentElement;
  if (!box || !plano || !inner || !column) return;

  const fit = (): void => {
    box.style.removeProperty('--tm-scale');
    plano.style.removeProperty('width');
    plano.style.removeProperty('margin-left');
    // The page's own scale for the plan (1.3, or 1.05 on a phone).
    const pagina = parseFloat(getComputedStyle(box).getPropertyValue('--tm-scale')) || 1.3;
    const medida = column.clientWidth;
    if (!medida) return;
    // The page's width without its scrollbar, which the gutter is measured from.
    // The page scrolls in its own overlay, so that is the box to ask: the
    // document does not know about the overlay's scrollbar, and measured from it
    // the plan sat 8px left of the column's axis.
    const vista = el.clientWidth || document.documentElement.clientWidth || window.innerWidth;
    const lienzo = Math.max(medida, Math.min(LIENZO_MAX, vista - 2 * GUTTER));
    // Every dimension in the drawing is a multiple of the scale, so one
    // measurement gives its width at any other — less 2px, because text widths
    // round and a plan scaled to fit exactly came out a pixel over and scrolled.
    const natural = inner.scrollWidth / pagina;
    // Where even the popup's scale will not fit, that is still the least it has
    // to scroll: at 1024px Toberín scrolled 190px at 1, and 540px at 1.3.
    let escala = Math.min(pagina, Math.max(1, (lienzo - 2) / natural));
    if (Math.abs(escala - pagina) > 0.005) box.style.setProperty('--tm-scale', escala.toFixed(3));
    // A few of its parts are fixed widths, not multiples of the scale (borders,
    // the gap between tags), so a scaled-down plan can still come out a pixel or
    // two over: one more step, measured.
    if (inner.scrollWidth > lienzo && escala > 1) {
      escala = Math.max(1, escala * ((lienzo - 2) / inner.scrollWidth));
      box.style.setProperty('--tm-scale', escala.toFixed(3));
    }
    const ancho = Math.min(lienzo, Math.ceil(inner.scrollWidth));
    if (ancho > medida) {
      plano.style.width = `${ancho}px`;
      plano.style.marginLeft = `calc(50% - ${ancho / 2}px)`;
    }
  };
  fit();
  // Refit as the VIEW changes, not only the column: between 808px and 1320px
  // the column keeps its 760px measure while the room either side of it — which
  // is what the plan steps out into — grows and shrinks. A plan that opened at
  // 1024px kept its width at 800px and ran off both edges. Dropped once the
  // page has gone.
  const onResize = (): void => {
    if (!box.isConnected) {
      window.removeEventListener('resize', onResize);
      return;
    }
    fit();
  };
  window.addEventListener('resize', onResize);
  new ResizeObserver(() => fit()).observe(column);
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

  el.querySelectorAll<HTMLElement>('[data-station-plan]').forEach((button) => {
    button.addEventListener('click', () => {
      const role = button.dataset.stationPlan === 'destination' ? 'destination' : 'origin';
      handlers?.onPlan(role, station);
    });
  });

  // The chooser has no plan, no board and no ridership of its own: each of
  // those belongs to one half, and its page has them.
  if (el.querySelector('.station-choices')) return;

  // Same plan, same affordance as in the popup: wheel, drag and edge fades
  // instead of a native scrollbar under the drawing (§5.5.6).
  wirePlanoScroll(el);
  fitPlan(el);

  // The operator's notices in force, over the plan they change, re-read every
  // minute while the page is open: a closure that starts at 22:00 has to show
  // up on a page opened at 21:55.
  watchAvisos(el, station.avisos);

  // The live board is the one thing on this page that has to be asked for. It
  // fills the same `.popup-arrivals` slot the popup uses, and the popup is
  // closed while the page is up (`openStationPage`), so the shared renderer
  // cannot paint the wrong one of the two.
  void renderStopArrivals(station.code);

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

  void loadDemand().then((data) => {
    // Only while this is still the page on screen: the reader may have followed
    // a service chip to a route page while the dataset was in flight.
    if (openCode === station.code && el.isConnected) fillDemand(el, station, data);
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
 * Re-renders the open page against freshly resolved station data.
 *
 * A page deep-linked from a search result opens the moment the catalog lands,
 * which is well before the ArcGIS station layer exists — so it opens without the
 * three facts that layer carries: WiFi, biciestación, and the node id the
 * ridership dataset is keyed on (`getStationPageData`). This is called once
 * those resolve, and is a no-op when nothing is open or the data has not
 * improved. Cheap: one `innerHTML` on a page that is already on screen.
 */
export function refreshStationPage(): void {
  if (!openCode || !isStationPageOpen()) return;
  const station = getStationPageData(openCode);
  if (station) refreshOverlayPage(descriptor(station));
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
