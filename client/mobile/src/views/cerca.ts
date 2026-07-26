/** Cerca tab — nearest stations, stops & POIs by GPS, with walk times. */

import { h, haptic, toast } from '../lib/dom';
import { formatDistance, haversineMeters } from '../lib/format';
import { POINT_KIND_LABELS, POINT_KINDS, type PointKind } from '@shared/data/pointKinds';
import { allPoints, bus, state, type StationRecord } from '../state';
import { getSessionExactLocation, setSessionExactLocation } from '@shared/utils/sessionLocation';
import { isWithinBogota } from '@shared/utils/geo';
import { app } from '../appContext';
import { pointRow } from '../ui/pointRow';
import { ICONS } from '../ui/components';
import type { View } from './types';

type KindFilter = 'all' | PointKind;

/** Ranked rows shown. Beyond this the list stops being "cerca de ti". */
const MAX_ROWS = 40;
/**
 * Nothing further than this is "near" on foot — 3 km is a ~40 min walk. Without
 * a bound, a rider on the edge of the network (or with a coarse fix) got a list
 * of things kilometres away presented as their nearby options.
 */
const MAX_NEARBY_METERS = 3000;

export function createCercaView(): View {
  const el = h('section', { class: 'screen screen-cerca' });
  const head = h('div', { class: 'screen-head' }, [
    h('h1', { class: 'screen-title', text: 'Cerca de ti' }),
    h('p', { class: 'screen-sub', text: 'Estaciones, paraderos y puntos a tu alrededor' }),
  ]);

  const locateBtn = h('button', { class: 'btn btn-primary locate-cta', type: 'button', html: `${ICONS.locate}<span>Usar mi ubicación</span>` });
  const pickBtn = h('button', { class: 'btn btn-ghost locate-pick', type: 'button', html: `${ICONS.map}<span>Elegir en el mapa</span>` });
  const status = h('div', { class: 'cerca-status', role: 'status', 'aria-live': 'polite' });

  // Kind filter (Todos / Estaciones / Paraderos / Recargas / Bici / Cable) —
  // built from the shared kind list so it can never drift from the search
  // scopes or the row badges (spec §5.4.2b).
  let kindFilter: KindFilter = 'all';
  const chipRow = h('div', { class: 'chip-row', role: 'tablist', 'aria-label': 'Filtrar por tipo de punto' });
  const chipEls = new Map<KindFilter, HTMLElement>();
  const chipSpec: [KindFilter, string][] = [['all', 'Todos'], ...POINT_KINDS.map((k) => [k, POINT_KIND_LABELS[k]] as [KindFilter, string])];
  for (const [id, label] of chipSpec) {
    const chip = h('button', {
      class: `chip${id === 'all' ? ' active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(id === 'all'),
      text: label,
    });
    chip.addEventListener('click', () => {
      kindFilter = id;
      chipEls.forEach((c, k) => {
        const on = k === kindFilter;
        c.classList.toggle('active', on);
        c.setAttribute('aria-selected', String(on));
      });
      render();
    });
    chipEls.set(id, chip);
    chipRow.append(chip);
  }

  const list = h('div', { class: 'near-list' });

  head.append(h('div', { class: 'locate-actions' }, [locateBtn, pickBtn]), chipRow, status);
  el.append(head, list);

  let userCoord: [number, number] | null = null;

  function showLocateHint(): void {
    list.replaceChildren(
      h('div', { class: 'empty' }, [
        h('div', { class: 'empty-title', text: 'Sin ubicación' }),
        h('div', {
          class: 'empty-text',
          text: 'Usa tu ubicación, o marca un punto en el mapa, para ver lo que tienes alrededor.',
        }),
      ])
    );
  }

  function render(): void {
    if (!userCoord) {
      showLocateHint();
      return;
    }
    const [lng, lat] = userCoord;
    const ranked = allPoints()
      .filter((p) => kindFilter === 'all' || p.kind === kindFilter)
      .map((p) => ({ p, d: haversineMeters([lng, lat], p.coordinate) }))
      .filter((x) => Number.isFinite(x.d) && x.d <= MAX_NEARBY_METERS)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_ROWS);

    list.replaceChildren();
    if (ranked.length === 0) {
      // Distinguish "still loading the catalogue" from "genuinely nothing of
      // this kind within walking distance" — they need different reactions.
      const loading = allPoints().length === 0;
      list.append(
        h('div', { class: 'empty' }, [
          h('div', { class: 'empty-title', text: loading ? 'Cargando la red…' : 'Nada a menos de 3 km' }),
          h('div', {
            class: 'empty-text',
            text: loading
              ? 'Los paraderos y puntos aparecerán en un momento.'
              : kindFilter === 'all'
              ? 'No hay puntos de la red a distancia caminable desde aquí.'
              : `No hay ${POINT_KIND_LABELS[kindFilter as PointKind].toLowerCase()} a distancia caminable. Prueba con “Todos”.`,
          }),
        ])
      );
      return;
    }
    for (const { p, d } of ranked) list.append(pointRow(p, d));
  }

  /** Adopt a fix from any source and re-rank around it. */
  function applyFix(coord: [number, number], label: string): void {
    userCoord = coord;
    setSessionExactLocation(coord[0], coord[1], 'gps');
    app().setUserLocation(coord);
    status.textContent = label;
    render();
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
      if (!isWithinBogota(lng, lat)) throw new Error('fuera de Bogotá');
      applyFix([lng, lat], `Ubicación fijada · ±${Math.round(pos.coords.accuracy)} m`);
    } catch (err) {
      // Say WHICH failure it was and always leave a way forward — the old
      // handler collapsed permission-denied, no-fix and out-of-city into one
      // "No se pudo ubicarte" with nothing to do next.
      const denied = err instanceof GeolocationPositionError && err.code === err.PERMISSION_DENIED;
      const outside = err instanceof Error && err.message.includes('Bogotá');
      const msg = outside
        ? 'Estás fuera de Bogotá'
        : denied
        ? 'Permiso de ubicación denegado'
        : 'No se pudo obtener tu ubicación';
      status.textContent = `${msg} · marca un punto en el mapa`;
      toast(msg, 'warn');
      pickBtn.classList.add('nudge');
      window.setTimeout(() => pickBtn.classList.remove('nudge'), 1400);
    } finally {
      locateBtn.classList.remove('busy');
    }
  }

  async function pickOnMap(): Promise<void> {
    haptic('light');
    const coord = await app().pickPointOnMap('Toca tu ubicación en el mapa');
    if (!coord) return;
    if (!isWithinBogota(coord[0], coord[1])) {
      toast('Ese punto está fuera de Bogotá', 'warn');
      return;
    }
    applyFix(coord, 'Ubicación marcada en el mapa');
    app().navigate('cerca');
  }

  locateBtn.addEventListener('click', locate);
  pickBtn.addEventListener('click', () => void pickOnMap());
  showLocateHint();
  bus.on('stops:ready', () => userCoord && render());
  bus.on('cable:ready', () => userCoord && render());

  return {
    el,
    onShow: () => {
      // Re-sync from the session fix every time: the Mapa fab and the planner
      // GPS button also store it, so a locate made elsewhere re-ranks this list.
      const cached = getSessionExactLocation();
      if (!cached || !isWithinBogota(cached.lng, cached.lat)) return;
      if (userCoord && userCoord[0] === cached.lng && userCoord[1] === cached.lat) return;
      userCoord = [cached.lng, cached.lat];
      status.textContent = 'Ubicación de esta sesión';
      render();
    },
  };
}
