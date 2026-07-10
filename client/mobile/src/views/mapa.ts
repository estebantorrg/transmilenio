/** Mapa tab — full-bleed live map with route/station overlays + 3D buses. */

import type { RouteListItem } from '@shared/types/transmilenio';
import type { TrackingStatus } from '@shared/layers/buses';
import type { LiveBusResult } from '@shared/services/api';
import { h, haptic, toast } from '../lib/dom';
import { setSessionExactLocation } from '@shared/utils/sessionLocation';
import { bus, state, type StationRecord } from '../state';
import { MapController } from '../map/mapController';
import { openStationSheet } from '../ui/detailSheets';
import { ICONS, liveChip, routeBadge } from '../ui/components';
import type { View } from './types';

export interface MapaView extends View {
  showRoute: (route: RouteListItem) => void;
  focusPoint: (rec: StationRecord) => void;
  setUser: (coord: [number, number]) => void;
}

export function createMapaView(): MapaView {
  const el = h('section', { class: 'screen screen-mapa' });
  const canvas = h('div', { class: 'map-canvas', id: 'tm-map' });
  el.append(canvas);

  // The map is created lazily on first show: MapLibre needs its container to be
  // attached AND sized, otherwise the style never finishes loading (a detached /
  // display:none container leaves the render loop idle).
  let controller: MapController | null = null;
  function ensureController(): MapController {
    if (!controller) {
      controller = new MapController(canvas);
      controller.onSelectStation = (rec) => openStationSheet(rec);
      // Demand circles aren't stations — a compact toast fits the app's
      // sheet/toast interaction model (no map popups on mobile).
      controller.onSelectDemand = (d) => {
        const nf = new Intl.NumberFormat('es-CO');
        toast(`#${d.rank} ${d.name} · ≈${nf.format(d.total)} validaciones/día`, 'info');
      };
      if (state.stations.length) controller.setStations(state.stations);
      if (state.zonalStops.length) controller.setParaderos(state.zonalStops);
      if (state.demand.length) controller.setDemand(state.demand);
    }
    return controller;
  }

  // Map filter panel — website-style layer toggles (Estaciones / Paraderos).
  const LAYERS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>';
  const filterBtn = h('button', { class: 'map-fab map-filter-btn', type: 'button', 'aria-label': 'Capas del mapa', html: LAYERS_ICON });
  const filterPanel = h('div', { class: 'map-filter-panel hidden' });
  const mkFilterRow = (key: 'stations' | 'paraderos' | 'demand', label: string, on: boolean) => {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = on;
    cb.addEventListener('change', () => {
      const c = ensureController();
      if (key === 'stations') c.setStationsVisible(cb.checked);
      else if (key === 'paraderos') c.setParaderosVisible(cb.checked);
      else c.setDemandVisible(cb.checked);
      haptic('light');
    });
    return h('label', { class: 'map-filter-row' }, [cb, h('span', { class: `mf-dot mf-${key}` }), h('span', { class: 'mf-label', text: label })]);
  };
  filterPanel.append(
    h('div', { class: 'map-filter-title', text: 'Mostrar en el mapa' }),
    mkFilterRow('stations', 'Estaciones', true),
    mkFilterRow('paraderos', 'Paraderos zonales', false),
    mkFilterRow('demand', 'Demanda', false)
  );
  filterBtn.addEventListener('click', () => {
    filterPanel.classList.toggle('hidden');
    haptic('light');
  });
  el.append(filterBtn, filterPanel);

  // Active-route banner (shows when a route is drawn).
  const banner = h('div', { class: 'map-route-banner hidden' });
  const bannerBadgeSlot = h('div', { class: 'mrb-badge' });
  const bannerLive = h('div', { class: 'mrb-live' }, [liveChip('loading')]);
  const bannerClose = h('button', { class: 'mrb-close', type: 'button', 'aria-label': 'Quitar ruta', html: '✕' });
  const bannerName = h('div', { class: 'mrb-name' });
  banner.append(bannerBadgeSlot, h('div', { class: 'mrb-mid' }, [bannerName, bannerLive]), bannerClose);
  el.append(banner);

  bannerClose.addEventListener('click', () => {
    void controller?.clearRoute();
    banner.classList.add('hidden');
    haptic('light');
  });

  // Locate FAB.
  const locate = h('button', { class: 'map-fab', type: 'button', 'aria-label': 'Mi ubicación', html: ICONS.locate });
  locate.addEventListener('click', () => locateUser());
  el.append(locate);

  function setBannerLive(payload: LiveBusResult | 'loading'): void {
    const status: TrackingStatus | 'loading' = payload === 'loading' ? 'loading' : payload.status;
    bannerLive.replaceChildren(liveChip(status, payload === 'loading' ? undefined : payload));
  }

  function showRoute(route: RouteListItem): void {
    banner.classList.remove('hidden');
    bannerBadgeSlot.replaceChildren(routeBadge(route, 'md'));
    bannerName.textContent = route.name;
    setBannerLive('loading');
    void ensureController().showRoute(route, (count, status, asOf) =>
      setBannerLive(status === 'loading' ? 'loading' : ({ status, data: new Array(count), asOf } as LiveBusResult))
    );
  }

  function focusPoint(rec: StationRecord): void {
    ensureController().flyTo(rec.coordinate, 16);
  }

  function setUser(coord: [number, number]): void {
    ensureController().setUser(coord);
  }

  async function locateUser(): Promise<void> {
    if (locate.classList.contains('busy')) return;
    locate.classList.add('busy');
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!('geolocation' in navigator)) return reject(new Error('sin geolocalización'));
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000 });
      });
      const coord: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      // Share the fix with the other tabs (Cerca re-ranks from it on show).
      setSessionExactLocation(coord[0], coord[1], 'gps');
      const c = ensureController();
      c.setUser(coord);
      c.flyTo(coord, 15.5);
    } catch {
      toast('No se pudo obtener tu ubicación', 'warn');
    } finally {
      locate.classList.remove('busy');
    }
  }

  bus.on('routes:ready', () => {
    controller?.setStations(state.stations);
    controller?.setParaderos(state.zonalStops);
  });
  bus.on('stops:ready', () => controller?.setParaderos(state.zonalStops));
  bus.on('demand:ready', () => controller?.setDemand(state.demand));

  return {
    el,
    showRoute,
    focusPoint,
    setUser,
    onShow: () => {
      const c = ensureController();
      c.resize();
      if (state.stations.length) c.setStations(state.stations);
      if (state.zonalStops.length) c.setParaderos(state.zonalStops);
      if (state.demand.length) c.setDemand(state.demand);
      requestAnimationFrame(() => c.resize());
    },
  };
}
