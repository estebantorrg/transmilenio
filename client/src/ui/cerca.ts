/**
 * Cerca panel — nearest stations & paraderos by GPS, with walking times.
 *
 * Port of the mobile "Cerca" tab (`client/mobile/src/views/cerca.ts`) onto the
 * website. Location resolution and the map user-marker are injected from main.ts
 * so this module doesn't duplicate the geolocation cascade (spec §1.1 R2).
 */

import { escapeHTML } from '../utils/html';
import { NEARBY_RADIUS_METERS, formatDistance, haversineMeters, isWithinBogota, walkMinutes } from '../utils/geo';
import { LOCATION_FAILURE_MESSAGE, classifyLocationFailure } from '../utils/locationError';
import { POINT_KIND_META, POINT_KINDS, type PointKind } from '../data/pointKinds';
import { initChipRowScroll } from './chipRow';

// The kind vocabulary itself lives in `data/pointKinds` — shared verbatim with
// the app, so a kind cannot exist in one client's lookup surfaces and not the
// other's (spec §5.4.2b, §1.1 R2).
export { POINT_KINDS, POINT_KIND_LABELS, type PointKind } from '../data/pointKinds';

export interface NearbyPoint {
  codigo: string;
  name: string;
  coordinate: [number, number];
  direccion: string;
  kind: PointKind;
  hours?: string; // recharge points (weekday hours) / transmibici (capacity)
  /** Labelled rows for the point's own popup/sheet — the full opening hours of a
   *  tullave counter (weekday / Saturday / Sunday-holiday, §5.5.1), a
   *  cicloparqueadero's capacity. `hours` stays the one-line row summary, which
   *  is all a Cerca row has space for. */
  details?: Array<{ label: string; value: string }>;
}

type KindFilter = 'all' | PointKind;
type LocationResult = { longitude: number; latitude: number; source: 'gps' | 'ip' };

interface CercaOptions {
  /** Resolves the user's location (reuses main.ts's cascade). */
  resolveLocation: () => Promise<LocationResult>;
  /** Selecting a row focuses the point on the map + opens its popup. */
  onSelect: (point: NearbyPoint) => void;
  /** Called with a fresh fix so main.ts can drop/refresh the user marker. */
  onLocated?: (lng: number, lat: number, source: 'gps' | 'ip') => void;
}

let points: NearbyPoint[] = [];
let userCoord: [number, number] | null = null;
let kindFilter: KindFilter = 'all';
let opts: CercaOptions | null = null;

const MAX_ROWS = 40;

export function initCerca(options: CercaOptions): void {
  opts = options;

  const locateBtn = document.getElementById('cerca-locate') as HTMLButtonElement | null;
  locateBtn?.addEventListener('click', () => void locate());

  // The kind chips do not fit a phone's sidebar width, so the row scrolls like
  // the Explore chip rows (wheel + drag on desktop, swipe on touch) instead of
  // clipping "Bici" out of reach.
  const chipRow = document.getElementById('cerca-chips');
  if (chipRow) initChipRowScroll(chipRow);

  document.querySelectorAll<HTMLButtonElement>('.cerca-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      kindFilter = (chip.dataset.kind as KindFilter) || 'all';
      document.querySelectorAll<HTMLButtonElement>('.cerca-chip').forEach((c) => {
        const active = c === chip;
        c.classList.toggle('active', active);
        c.setAttribute('aria-selected', String(active));
      });
      render();
    });
  });

  // Draw the initial "Cerca de ti" empty state — the panel markup ships empty
  // so this stays the single source of that copy (spec §1.1 R2).
  render();
}

/** Feed the point universe (stations first, then enriched with zonal stops). */
export function setNearbyPoints(next: NearbyPoint[]): void {
  points = next;
  if (userCoord) render();
}

/**
 * Fix the user location from outside the panel (dragging the map marker) so
 * the ranked list always follows the marker.
 */
export function setCercaLocation(lng: number, lat: number): void {
  userCoord = [lng, lat];
  render();
}

function setStatus(text: string): void {
  const el = document.getElementById('cerca-status');
  if (el) el.textContent = text;
}

/** The cause (shared classifier) plus this panel's own way forward. */
function locateFailureMessage(err: unknown): string {
  const failure = classifyLocationFailure(err);
  const next =
    failure === 'outside'
      ? 'esta app cubre solo la red de Bogotá'
      : failure === 'denied'
      ? 'actívalo en el navegador, o arrastra el círculo azul en el mapa'
      : 'arrastra el círculo azul en el mapa hasta donde estás';
  return `${LOCATION_FAILURE_MESSAGE[failure]} · ${next}`;
}

async function locate(): Promise<void> {
  const btn = document.getElementById('cerca-locate') as HTMLButtonElement | null;
  if (btn?.classList.contains('loading') || !opts) return;
  btn?.classList.add('loading');
  setStatus('Buscando tu ubicación…');
  try {
    const result = await opts.resolveLocation();
    const lng = result.longitude;
    const lat = result.latitude;
    if (!isWithinBogota(lng, lat)) throw new Error('fuera de Bogotá');
    userCoord = [lng, lat];
    opts.onLocated?.(lng, lat, result.source);
    setStatus(
      result.source === 'ip'
        ? 'Ubicación aproximada (IP, ~2 km) · arrastra el punto en el mapa para ajustar'
        : 'Ubicación fijada'
    );
    render();
  } catch (err) {
    setStatus(locateFailureMessage(err));
  } finally {
    btn?.classList.remove('loading');
  }
}

/** Empty state that says what happened AND what is actually out there — a bare
 *  "Sin resultados" next to a filter chip left the rider guessing whether the
 *  kind is empty, still loading, or simply far away. */
function renderEmpty(nearest: { p: NearbyPoint; d: number } | null): string {
  if (points.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-title">Cargando la red…</div>
        <div class="empty-state-text">Las estaciones ya están; los paraderos zonales y los puntos tullave entran en un momento.</div>
      </div>`;
  }

  const kindLabel = kindFilter === 'all' ? 'puntos de la red' : POINT_KIND_META[kindFilter].plural.toLowerCase();
  const radius = formatDistance(NEARBY_RADIUS_METERS);
  // The nearest match beyond the radius is the most useful thing we know: it
  // turns "no hay" into a distance and a name, and it is one click away.
  const beyond = nearest
    ? `<div class="empty-state-text">Lo más cercano es <strong>${escapeHTML(nearest.p.name)}</strong>, a ${escapeHTML(
        formatDistance(nearest.d)
      )} (${walkMinutes(nearest.d)} min a pie).</div>
       <button class="empty-state-action" type="button" data-kind="${nearest.p.kind}" data-code="${escapeHTML(
        nearest.p.codigo
      )}">Ver el más cercano</button>`
    : `<div class="empty-state-text">No hay ${escapeHTML(kindLabel)} en el catálogo para esta zona.</div>`;

  return `
    <div class="empty-state">
      <div class="empty-state-title">Sin ${escapeHTML(kindLabel)} a menos de ${escapeHTML(radius)}</div>
      <div class="empty-state-text">Nada a distancia caminable desde tu ubicación${
        kindFilter === 'all' ? '' : ' · prueba con “Todos”'
      }.</div>
      ${beyond}
    </div>`;
}

function render(): void {
  const list = document.getElementById('cerca-list');
  if (!list) return;

  if (!userCoord) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Cerca de ti</div>
        <div class="empty-state-text">Usa tu ubicación para ver las estaciones, paraderos, puntos tullave y cicloparqueaderos más cercanos, con la distancia y el tiempo a pie de cada uno.</div>
        <div class="empty-state-text">También puedes arrastrar el círculo azul en el mapa para consultar cualquier otro punto de la ciudad.</div>
      </div>`;
    return;
  }

  const origin = userCoord;
  const measured = points
    .filter((p) => kindFilter === 'all' || p.kind === kindFilter)
    .map((p) => ({ p, d: haversineMeters(origin, p.coordinate) }))
    .filter((x) => Number.isFinite(x.d))
    .sort((a, b) => a.d - b.d);
  // Bounded like the app's list (spec §5.2.1b): a coarse fix used to present
  // things kilometres away as "cerca de ti".
  const ranked = measured.filter((x) => x.d <= NEARBY_RADIUS_METERS).slice(0, MAX_ROWS);

  if (ranked.length === 0) {
    list.innerHTML = renderEmpty(measured[0] ?? null);
    const action = list.querySelector<HTMLButtonElement>('.empty-state-action');
    action?.addEventListener('click', () => {
      const point = points.find((p) => p.kind === action.dataset.kind && p.codigo === action.dataset.code);
      if (point) opts?.onSelect(point);
    });
    return;
  }

  list.innerHTML = ranked.map(({ p, d }) => nearRowHtml(p, d)).join('');

  list.querySelectorAll<HTMLElement>('.near-row').forEach((row) => {
    row.addEventListener('click', () => {
      const point = points.find((p) => p.kind === row.dataset.kind && p.codigo === row.dataset.code);
      if (point) opts?.onSelect(point);
    });
  });
}

const KIND_META = POINT_KIND_META;

/** Shared row renderer for a nearby/searchable point. `meters` is optional so
 *  the sidebar's station search (no user fix required) reuses the same row
 *  without a distance column (spec §1.1 R2 — no duplicated markup). */
export function nearRowHtml(point: NearbyPoint, meters?: number): string {
  const meta = KIND_META[point.kind];
  const sub = meta.carriesExtra
    ? [point.direccion, point.hours].filter(Boolean).join(' · ') || meta.fallback
    : point.direccion || meta.fallback;
  const right = typeof meters === 'number' && Number.isFinite(meters)
    ? `
      <div class="near-right">
        <div class="near-dist">${escapeHTML(formatDistance(meters))}</div>
        <div class="near-walk">${walkMinutes(meters)} min</div>
      </div>`
    : '';
  return `
    <button class="near-row" type="button" data-kind="${point.kind}" data-code="${escapeHTML(point.codigo)}">
      <span class="near-dot ${meta.cls}"></span>
      <div class="near-mid">
        <div class="near-name-row">
          <span class="near-name">${escapeHTML(point.name)}</span>
          <span class="near-kind ${meta.cls}">${meta.label}</span>
        </div>
        <div class="near-sub">${escapeHTML(sub)}</div>
      </div>
      ${right}
    </button>`;
}
