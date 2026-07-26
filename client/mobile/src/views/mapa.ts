/** Mapa tab — full-bleed live map with route/station overlays + 3D buses. */

import type { RouteListItem } from '@shared/types/transmilenio';
import type { TrackingStatus } from '@shared/layers/buses';
import type { JourneyPlan } from '@shared/services/router';
import type { LiveBusResult } from '@shared/services/api';
import { h, haptic, toast } from '../lib/dom';
import { setSessionExactLocation } from '@shared/utils/sessionLocation';
import { bus, state, type StationRecord } from '../state';
import { MapController, MAP_STYLE_URL, preloadMapAssets } from '../map/mapController';
import { openRouteSheet, openStationSheet } from '../ui/detailSheets';
import { getMapLayerPrefs, setMapLayerPref, type MapLayerKey } from '../lib/storage';
import { ICONS, liveChip, routeBadge } from '../ui/components';
import type { View } from './types';

export interface MapaView extends View {
  showRoute: (route: RouteListItem) => void;
  focusPoint: (rec: StationRecord) => void;
  setUser: (coord: [number, number]) => void;
  /** Clear the active route + banner (+ stop live tracking). Returns true if one was showing. */
  dismissRoute: () => boolean;
  /** Warm the map's heavy assets while the app is idle, before the tab is opened. */
  prewarm: () => void;
  /** Switch to the map and let the rider tap a point. Resolves null if cancelled. */
  pickPoint: (prompt: string) => Promise<[number, number] | null>;
  /** True while a map pick is in progress (hardware back cancels it). */
  cancelPick: () => boolean;
  /** Draw a planned itinerary (planner → "Ver en el mapa"). */
  showJourney: (plan: JourneyPlan, summary: string) => void;
  /** Clear a drawn itinerary. Returns true if one was showing. */
  dismissJourney: () => boolean;
}

export function createMapaView(): MapaView {
  const el = h('section', { class: 'screen screen-mapa' });
  const canvas = h('div', { class: 'map-canvas', id: 'tm-map' });
  el.append(canvas);

  // The map is created lazily on first show: MapLibre needs its container to be
  // attached AND sized, otherwise the style never finishes loading (a detached /
  // display:none container leaves the render loop idle).
  let controller: MapController | null = null;
  // Layer visibility is the rider's standing choice, not a per-launch one: a
  // paradero-first user had to re-tick "Paraderos zonales" every single time the
  // app started. Persisted, and read before the controller exists so the first
  // style load already has them right.
  const layerPrefs = getMapLayerPrefs();
  function ensureController(): MapController {
    if (!controller) {
      controller = new MapController(canvas, layerPrefs);
      controller.onSelectStation = (rec) => openStationSheet(rec);
      // Demand circles aren't stations — a compact toast fits the app's
      // sheet/toast interaction model (no map popups on mobile).
      controller.onSelectDemand = (d) => {
        const nf = new Intl.NumberFormat('es-CO');
        toast(`#${d.rank} ${d.name} · ≈${nf.format(d.total)} validaciones/día`, 'info');
      };
      // Cable stations aren't station sheets — a toast matches the app's model.
      controller.onSelectCable = (s) =>
        toast(`${s.name} · TransMiCable · cabinas ~cada 20 s`, 'info');
      if (state.stations.length) controller.setStations(state.stations);
      if (state.zonalStops.length) controller.setParaderos(state.zonalStops);
      if (state.demand.length) controller.setDemand(state.demand);
      if (state.cableStations.length) controller.setCable(state.cableStations, state.cableTraces);
    }
    return controller;
  }

  // Map filter panel — website-style layer toggles (Estaciones / Paraderos).
  const LAYERS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>';
  const filterBtn = h('button', { class: 'map-fab map-filter-btn', type: 'button', 'aria-label': 'Capas del mapa', html: LAYERS_ICON });
  const filterPanel = h('div', { class: 'map-filter-panel hidden' });
  const mkFilterRow = (key: MapLayerKey, label: string) => {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = layerPrefs[key];
    cb.addEventListener('change', () => {
      const c = ensureController();
      if (key === 'stations') c.setStationsVisible(cb.checked);
      else if (key === 'paraderos') c.setParaderosVisible(cb.checked);
      else if (key === 'cable') c.setCableVisible(cb.checked);
      else c.setDemandVisible(cb.checked);
      layerPrefs[key] = cb.checked;
      setMapLayerPref(key, cb.checked);
      haptic('light');
    });
    return h('label', { class: 'map-filter-row' }, [cb, h('span', { class: `mf-dot mf-${key}` }), h('span', { class: 'mf-label', text: label })]);
  };
  filterPanel.append(
    h('div', { class: 'map-filter-title', text: 'Mostrar en el mapa' }),
    mkFilterRow('stations', 'Estaciones'),
    mkFilterRow('paraderos', 'Paraderos zonales'),
    mkFilterRow('cable', 'TransMiCable'),
    mkFilterRow('demand', 'Demanda')
  );
  // Close the layer panel when tapping anywhere outside it (the map, another FAB) —
  // an open panel that only closes via its own button used to sit covering the map.
  const onOutside = (e: Event): void => {
    if (filterPanel.classList.contains('hidden')) return;
    const t = e.target as Node;
    if (filterPanel.contains(t) || filterBtn.contains(t)) return;
    filterPanel.classList.add('hidden');
    el.removeEventListener('pointerdown', onOutside);
  };
  filterBtn.addEventListener('click', () => {
    const opening = filterPanel.classList.contains('hidden');
    filterPanel.classList.toggle('hidden');
    haptic('light');
    if (opening) {
      // Defer so this same tap doesn't immediately re-close the panel.
      setTimeout(() => el.addEventListener('pointerdown', onOutside), 0);
    } else {
      el.removeEventListener('pointerdown', onOutside);
    }
  });
  el.append(filterBtn, filterPanel);

  // Active-route banner (shows when a route is drawn). Tapping it reopens that
  // route's detail sheet — it used to be an inert label, so the only way back to
  // the paradas/horarios of the route you were watching was to leave the map,
  // find the route in the list again and reopen it.
  let bannerRoute: RouteListItem | null = null;
  const banner = h('div', { class: 'map-route-banner hidden' });
  const bannerBadgeSlot = h('div', { class: 'mrb-badge' });
  const bannerLive = h('div', { class: 'mrb-live' }, [liveChip('loading')]);
  const bannerClose = h('button', { class: 'mrb-close', type: 'button', 'aria-label': 'Quitar ruta', html: '✕' });
  const bannerName = h('div', { class: 'mrb-name' });
  const bannerOpen = h('button', {
    class: 'mrb-open',
    type: 'button',
    'aria-label': 'Ver detalle de la ruta',
  }, [bannerBadgeSlot, h('div', { class: 'mrb-mid' }, [bannerName, bannerLive])]);
  bannerOpen.addEventListener('click', () => {
    if (!bannerRoute) return;
    haptic('light');
    openRouteSheet(bannerRoute);
  });
  banner.append(bannerOpen, bannerClose);
  el.append(banner);

  function clearActiveRoute(): void {
    void controller?.clearRoute();
    bannerRoute = null;
    banner.classList.add('hidden');
    el.classList.remove('has-route');
  }
  bannerClose.addEventListener('click', () => {
    clearActiveRoute();
    haptic('light');
  });
  /** Hardware-back / programmatic dismissal of the active route. */
  function dismissRoute(): boolean {
    if (banner.classList.contains('hidden')) return false;
    clearActiveRoute();
    return true;
  }

  // Locate FAB.
  const locate = h('button', { class: 'map-fab map-locate-btn', type: 'button', 'aria-label': 'Mi ubicación', html: ICONS.locate });
  locate.addEventListener('click', () => locateUser());
  el.append(locate);

  // ── Journey banner (a planned itinerary drawn on the map) ──
  const journeyBanner = h('div', { class: 'map-route-banner map-journey-banner hidden' });
  const journeyText = h('div', { class: 'mrb-name' });
  const journeySub = h('div', { class: 'mrb-sub' });
  const journeyClose = h('button', { class: 'mrb-close', type: 'button', 'aria-label': 'Quitar itinerario', html: '✕' });
  journeyBanner.append(
    h('span', { class: 'mrb-journey-icon', html: ICONS.plan }),
    h('div', { class: 'mrb-mid' }, [journeyText, journeySub]),
    journeyClose
  );
  journeyClose.addEventListener('click', () => {
    dismissJourney();
    haptic('light');
  });
  el.append(journeyBanner);

  function showJourney(plan: JourneyPlan, summary: string): void {
    clearActiveRoute();
    journeyText.textContent = 'Itinerario';
    journeySub.textContent = summary;
    journeyBanner.classList.remove('hidden');
    el.classList.add('has-route');
    void ensureController().showJourney(plan);
  }

  function dismissJourney(): boolean {
    if (journeyBanner.classList.contains('hidden')) return false;
    journeyBanner.classList.add('hidden');
    el.classList.remove('has-route');
    void controller?.clearJourney();
    return true;
  }

  // ── Map-pick mode ──
  // A banner + cancel while the rider is asked to tap a point on the map. Used
  // whenever the GPS is not an option (denied, no fix, planning from elsewhere).
  let pickAbort: AbortController | null = null;
  const pickHint = h('div', { class: 'map-pick-hint hidden' });
  const pickText = h('span', { class: 'map-pick-text' });
  const pickCancel = h('button', { class: 'map-pick-cancel', type: 'button', text: 'Cancelar' });
  pickCancel.addEventListener('click', () => cancelPick());
  pickHint.append(pickText, pickCancel);
  el.append(pickHint);

  function cancelPick(): boolean {
    if (!pickAbort) return false;
    pickAbort.abort();
    pickAbort = null;
    pickHint.classList.add('hidden');
    return true;
  }

  async function pickPoint(prompt: string): Promise<[number, number] | null> {
    cancelPick();
    const controller = new AbortController();
    pickAbort = controller;
    pickText.textContent = prompt;
    pickHint.classList.remove('hidden');
    const c = ensureController();
    c.resize();
    try {
      const coord = await c.pickPoint(controller.signal);
      if (coord) haptic('medium');
      return coord;
    } finally {
      if (pickAbort === controller) pickAbort = null;
      pickHint.classList.add('hidden');
    }
  }

  function setBannerLive(payload: LiveBusResult | 'loading'): void {
    const status: TrackingStatus | 'loading' = payload === 'loading' ? 'loading' : payload.status;
    bannerLive.replaceChildren(liveChip(status, payload === 'loading' ? undefined : payload));
  }

  function showRoute(route: RouteListItem): void {
    dismissJourney(); // a route and an itinerary are two different answers
    bannerRoute = route;
    banner.classList.remove('hidden');
    el.classList.add('has-route');
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
  bus.on('cable:ready', () => controller?.setCable(state.cableStations, state.cableTraces));

  return {
    el,
    showRoute,
    focusPoint,
    setUser,
    dismissRoute,
    /**
     * Pull the map's two slow assets — the basemap style JSON and the 3D bus
     * chunk + model — into cache while the app sits idle on Inicio, so opening
     * "Mapa" is instant. The MapLibre instance itself is deliberately NOT
     * created here: its container is `display:none` until the tab is shown, and
     * a zero-sized container is exactly the state where the style load never
     * settles.
     */
    prewarm: () => {
      if (controller) return;
      void fetch(MAP_STYLE_URL, { mode: 'cors' }).catch(() => undefined);
      void preloadMapAssets();
    },
    pickPoint,
    cancelPick,
    showJourney,
    dismissJourney,
    onShow: () => {
      const c = ensureController();
      c.resize();
      if (state.stations.length) c.setStations(state.stations);
      if (state.zonalStops.length) c.setParaderos(state.zonalStops);
      if (state.demand.length) c.setDemand(state.demand);
      if (state.cableStations.length) c.setCable(state.cableStations, state.cableTraces);
      requestAnimationFrame(() => c.resize());
    },
  };
}
