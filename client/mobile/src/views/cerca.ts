/** Cerca tab — nearest stations & stops by GPS, with walk times. */

import { h, haptic, toast } from '../lib/dom';
import { formatDistance, haversineMeters, walkMinutes } from '../lib/format';
import { allPoints, bus, state, type StationRecord } from '../state';
import { getSessionExactLocation, setSessionExactLocation } from '@shared/utils/sessionLocation';
import { app } from '../appContext';
import { openStationSheet } from '../ui/detailSheets';
import { ICONS } from '../ui/components';
import type { View } from './types';

type KindFilter = 'all' | 'station' | 'stop' | 'recharge';

const KIND_META: Record<StationRecord['kind'], { cls: string; label: string; fallback: string }> = {
  station: { cls: 'is-station', label: 'Estación', fallback: 'Estación troncal' },
  stop: { cls: 'is-stop', label: 'Paradero', fallback: 'Paradero zonal' },
  recharge: { cls: 'is-recharge', label: 'Recarga', fallback: 'Punto de recarga tullave' },
};

const BOGOTA_BOUNDS = { minLat: 4.4, maxLat: 4.85, minLng: -74.25, maxLng: -73.95 };
function inBogota(lng: number, lat: number): boolean {
  return lat >= BOGOTA_BOUNDS.minLat && lat <= BOGOTA_BOUNDS.maxLat && lng >= BOGOTA_BOUNDS.minLng && lng <= BOGOTA_BOUNDS.maxLng;
}

export function createCercaView(): View {
  const el = h('section', { class: 'screen screen-cerca' });
  const head = h('div', { class: 'screen-head' }, [
    h('h1', { class: 'screen-title', text: 'Cerca de ti' }),
    h('p', { class: 'screen-sub', text: 'Estaciones y paraderos a tu alrededor' }),
  ]);

  const locateBtn = h('button', { class: 'btn btn-primary locate-cta', type: 'button', html: `${ICONS.locate}<span>Usar mi ubicación</span>` });
  const status = h('div', { class: 'cerca-status' });

  // Kind filter (Estaciones / Paraderos / Ambos).
  let kindFilter: KindFilter = 'all';
  const chipRow = h('div', { class: 'chip-row' });
  const chipEls = new Map<KindFilter, HTMLElement>();
  for (const [id, label] of [['all', 'Ambos'], ['station', 'Estaciones'], ['stop', 'Paraderos'], ['recharge', 'Recargas']] as const) {
    const chip = h('button', { class: `chip${id === 'all' ? ' active' : ''}`, type: 'button', text: label });
    chip.addEventListener('click', () => {
      kindFilter = id;
      chipEls.forEach((c, k) => c.classList.toggle('active', k === kindFilter));
      render();
    });
    chipEls.set(id, chip);
    chipRow.append(chip);
  }

  const list = h('div', { class: 'near-list' });

  head.append(locateBtn, chipRow, status);
  el.append(head, list);

  let userCoord: [number, number] | null = null;

  function render(): void {
    if (!userCoord) return;
    const [lng, lat] = userCoord;
    const ranked = allPoints()
      .filter((p) => kindFilter === 'all' || p.kind === kindFilter)
      .map((p) => ({ p, d: haversineMeters([lng, lat], p.coordinate) }))
      .filter((x) => Number.isFinite(x.d))
      .sort((a, b) => a.d - b.d)
      .slice(0, 40);

    list.replaceChildren();
    if (ranked.length === 0) {
      list.append(h('div', { class: 'muted', text: 'Aún cargando paraderos…' }));
      return;
    }
    for (const { p, d } of ranked) list.append(nearRow(p, d));
  }

  function nearRow(point: StationRecord, meters: number): HTMLElement {
    const meta = KIND_META[point.kind];
    const row = h('button', { class: 'near-row', type: 'button' });
    const dot = h('span', { class: `near-dot ${meta.cls}` });
    const nameRow = h('div', { class: 'near-name-row' }, [
      h('span', { class: 'near-name', text: point.name }),
      h('span', { class: `near-kind ${meta.cls}`, text: meta.label }),
    ]);
    const sub =
      point.kind === 'recharge'
        ? [point.direccion, point.hours].filter(Boolean).join(' · ') || meta.fallback
        : point.direccion || meta.fallback;
    const mid = h('div', { class: 'near-mid' }, [nameRow, h('div', { class: 'near-sub', text: sub })]);
    const right = h('div', { class: 'near-right' }, [
      h('div', { class: 'near-dist', text: formatDistance(meters) }),
      h('div', { class: 'near-walk', text: `${walkMinutes(meters)} min` }),
    ]);
    row.append(dot, mid, right);
    row.addEventListener('click', () => {
      haptic('light');
      app().focusPoint(point);
      // Recharge POIs aren't stations — focus the map + toast instead of a station sheet.
      if (point.kind === 'recharge') {
        toast(point.hours ? `${point.name} · Lun–Vie ${point.hours}` : point.name, 'info');
      } else {
        openStationSheet(point);
      }
    });
    return row;
  }

  async function locate(): Promise<void> {
    if (locateBtn.classList.contains('busy')) return;
    locateBtn.classList.add('busy');
    status.textContent = 'Buscando tu ubicación…';
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!('geolocation' in navigator)) return reject(new Error('sin geolocalización'));
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 14000 });
      });
      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      if (!inBogota(lng, lat)) throw new Error('fuera de Bogotá');
      userCoord = [lng, lat];
      setSessionExactLocation(lng, lat, 'gps');
      app().setUserLocation(userCoord);
      status.textContent = `Ubicación fijada · ±${Math.round(pos.coords.accuracy)} m`;
      render();
    } catch (err) {
      const msg = err instanceof Error && err.message.includes('Bogotá') ? 'Estás fuera de Bogotá' : 'No se pudo ubicarte';
      status.textContent = msg;
      toast(msg, 'warn');
    } finally {
      locateBtn.classList.remove('busy');
    }
  }

  locateBtn.addEventListener('click', locate);
  bus.on('stops:ready', () => userCoord && render());

  return {
    el,
    onShow: () => {
      if (!userCoord) {
        const cached = getSessionExactLocation();
        if (cached && inBogota(cached.lng, cached.lat)) {
          userCoord = [cached.lng, cached.lat];
          status.textContent = 'Ubicación de esta sesión';
          render();
        }
      }
    },
  };
}
