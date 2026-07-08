/**
 * Cerca panel — nearest stations & paraderos by GPS, with walking times.
 *
 * Port of the mobile "Cerca" tab (`client/mobile/src/views/cerca.ts`) onto the
 * website. Location resolution and the map user-marker are injected from main.ts
 * so this module doesn't duplicate the geolocation cascade (spec §1.1 R2).
 */

import { escapeHTML } from '../utils/html';
import { formatDistance, haversineMeters, isWithinBogota, walkMinutes } from '../utils/geo';

export interface NearbyPoint {
  codigo: string;
  name: string;
  coordinate: [number, number];
  direccion: string;
  kind: 'station' | 'stop';
}

type KindFilter = 'all' | 'station' | 'stop';
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
}

/** Feed the point universe (stations first, then enriched with zonal stops). */
export function setNearbyPoints(next: NearbyPoint[]): void {
  points = next;
  if (userCoord) render();
}

function setStatus(text: string): void {
  const el = document.getElementById('cerca-status');
  if (el) el.textContent = text;
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
        ? 'Ubicación aproximada (IP) · arrastra el punto en el mapa para ajustar'
        : 'Ubicación fijada'
    );
    render();
  } catch (err) {
    const outOfBounds = err instanceof Error && err.message.includes('Bogotá');
    setStatus(outOfBounds ? 'Estás fuera de Bogotá' : 'No se pudo ubicarte');
  } finally {
    btn?.classList.remove('loading');
  }
}

function render(): void {
  const list = document.getElementById('cerca-list');
  if (!list) return;

  if (!userCoord) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Cerca de ti</div>
        <div class="empty-state-text">Usa tu ubicación para ver las estaciones y paraderos más cercanos con tiempos a pie.</div>
      </div>`;
    return;
  }

  const origin = userCoord;
  const ranked = points
    .filter((p) => kindFilter === 'all' || p.kind === kindFilter)
    .map((p) => ({ p, d: haversineMeters(origin, p.coordinate) }))
    .filter((x) => Number.isFinite(x.d))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_ROWS);

  if (ranked.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">${points.length === 0 ? 'Cargando paraderos…' : 'Sin resultados'}</div>
        <div class="empty-state-text">${points.length === 0 ? 'Los paraderos zonales aparecerán en un momento.' : 'Prueba con otro tipo de punto.'}</div>
      </div>`;
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

function nearRowHtml(point: NearbyPoint, meters: number): string {
  const isStation = point.kind === 'station';
  const kindLabel = isStation ? 'Estación' : 'Paradero';
  const sub = point.direccion || (isStation ? 'Estación troncal' : 'Paradero zonal');
  return `
    <button class="near-row" type="button" data-kind="${point.kind}" data-code="${escapeHTML(point.codigo)}">
      <span class="near-dot ${isStation ? 'is-station' : 'is-stop'}"></span>
      <div class="near-mid">
        <div class="near-name-row">
          <span class="near-name">${escapeHTML(point.name)}</span>
          <span class="near-kind ${isStation ? 'is-station' : 'is-stop'}">${kindLabel}</span>
        </div>
        <div class="near-sub">${escapeHTML(sub)}</div>
      </div>
      <div class="near-right">
        <div class="near-dist">${escapeHTML(formatDistance(meters))}</div>
        <div class="near-walk">${walkMinutes(meters)} min</div>
      </div>
    </button>`;
}
