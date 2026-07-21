/** Route-detail and station-detail bottom sheets (shared by every tab). */

import { getRouteAccentColor, STATION_COLOR, PARADERO_COLOR } from '@shared/utils/routeColors';
import type { RouteListItem } from '@shared/types/transmilenio';
import { api, type LiveBusResult } from '@shared/services/api';
import type { TrackingStatus } from '@shared/layers/buses';
import { h, escapeHTML, haptic, toast } from '../lib/dom';
import { formatDistance, needsDarkText } from '../lib/format';
import { isFavorite, toggleFavorite, pushRecent } from '../lib/storage';
import { LivePoller } from '../live/liveStatus';
import { app } from '../appContext';
import { bus, state, type StationRecord } from '../state';
import { openSheet } from './sheet';
import { openPlannerSheet } from '../views/planner';
import { ICONS, liveChip, routeBadge, routeTypeLabel } from './components';

/**
 * Detail sheets (route / station) REPLACE each other instead of stacking: the
 * route↔station ping-pong (timeline stop → station sheet → route chip → …)
 * used to pile sheets without bound. Non-detail sheets (planner) still stack
 * beneath normally.
 *
 * The replacement is done SYNCHRONOUSLY (`close(true)` + `instant`) so that no
 * matter how fast the user taps, the DOM holds at most one detail panel — the
 * previous one is removed the instant the next opens instead of lingering for its
 * 300ms exit animation, which used to let a dozen half-closed panels pile up under
 * a mashing thumb ("everything stacked").
 */
let activeDetail: import('./sheet').SheetHandle | null = null;

function openDetailSheet(options: Parameters<typeof openSheet>[0]): import('./sheet').SheetHandle {
  const replacing = activeDetail !== null;
  activeDetail?.close(true); // synchronous — old panel gone before the new one mounts
  const onClose = options?.onClose;
  const sheet = openSheet({
    ...options,
    instant: replacing, // swap in place; a fresh open still slides up
    onClose: () => {
      if (activeDetail === sheet) activeDetail = null;
      onClose?.();
    },
  });
  activeDetail = sheet;
  return sheet;
}

/** Share a route via the native share sheet, Web Share, or clipboard fallback. */
async function shareRoute(route: RouteListItem): Promise<void> {
  const title = `${route.code} · ${route.name}`;
  const text = `${route.code} · ${route.origin} → ${route.destination} (TransMi Go)`;
  const cap = (window as any).Capacitor;
  const sharePlugin = cap?.Plugins?.Share;
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  try {
    if (cap?.isNativePlatform?.() && sharePlugin?.share) {
      await sharePlugin.share({ title, text, dialogTitle: 'Compartir ruta' });
      return;
    }
    if (typeof nav.share === 'function') {
      await nav.share({ title, text });
      return;
    }
    if (nav.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      toast('Ruta copiada al portapapeles', 'ok');
      return;
    }
    toast('Compartir no disponible', 'warn');
  } catch (err) {
    // User cancelling the native/Web share sheet is not an error.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    toast('No se pudo compartir', 'warn');
  }
}

function starButton(route: RouteListItem): HTMLElement {
  const btn = h('button', { class: 'star-btn', type: 'button', 'aria-label': 'Favorito' });
  const paint = () => {
    const fav = isFavorite(route.id);
    btn.innerHTML = fav ? ICONS.starFill : ICONS.star;
    btn.classList.toggle('on', fav);
  };
  paint();
  btn.addEventListener('click', () => {
    const now = toggleFavorite(route.id);
    haptic('light');
    paint();
    bus.emit('favorites:changed', undefined);
    toast(now ? 'Añadida a favoritas' : 'Quitada de favoritas', now ? 'ok' : 'info');
  });
  return btn;
}

export function openRouteSheet(route: RouteListItem): void {
  pushRecent(route.id);
  const accent = getRouteAccentColor(route);
  const sheet = openDetailSheet({ accent, full: true, onClose: () => poller.stop() });

  // ── Header ──
  const header = h('div', { class: 'rd-header' });
  const badge = routeBadge(route, 'lg');
  const titles = h('div', { class: 'rd-titles' }, [
    h('div', { class: 'rd-name', text: route.name }),
    h('div', {
      class: 'rd-od',
      html: `${escapeHTML(route.origin)} <span class="arrow">→</span> ${escapeHTML(route.destination)}`,
    }),
  ]);
  const shareBtn = h('button', { class: 'star-btn', type: 'button', 'aria-label': 'Compartir ruta', html: ICONS.share });
  shareBtn.addEventListener('click', () => {
    haptic('light');
    void shareRoute(route);
  });
  header.append(badge, titles, shareBtn, starButton(route));
  sheet.body.append(header);

  const tags = h('div', { class: 'rd-tags' });
  tags.append(h('span', { class: 'rd-tag', text: routeTypeLabel(route) }));
  // ArcGIS longitud_ruta_troncal is already in kilometres (verified: ~13–24),
  // matching the website's route.length display — do not divide by 1000.
  if (route.length && route.length > 0.2) tags.append(h('span', { class: 'rd-tag', text: `${route.length.toFixed(1)} km` }));
  if (route.busType) tags.append(h('span', { class: 'rd-tag', text: route.busType }));
  if (route.operator) tags.append(h('span', { class: 'rd-tag', text: route.operator }));
  // Sistema label mirrors the website route detail (spec §1.1 R2 wording parity).
  const sistema = route.subType === 'dual' ? 'TransMilenio Dual' : route.type === 'troncal' ? 'TransMilenio Troncal' : 'SITP Zonal';
  tags.append(h('span', { class: 'rd-tag', text: sistema }));
  sheet.body.append(tags);

  // ── Live status ──
  const liveRow = h('div', { class: 'rd-live' });
  const liveSlot = h('div', { class: 'rd-live-slot' }, [liveChip('loading')]);
  const refresh = h('button', { class: 'rd-live-refresh', type: 'button', 'aria-label': 'Actualizar', html: ICONS.refresh });
  liveRow.append(liveSlot, refresh);
  sheet.body.append(liveRow);

  const setLive = (payload: LiveBusResult | 'loading') => {
    const status: TrackingStatus | 'loading' = payload === 'loading' ? 'loading' : payload.status;
    liveSlot.replaceChildren(liveChip(status, payload === 'loading' ? undefined : payload));
  };
  const poller = new LivePoller(route, setLive);
  refresh.addEventListener('click', () => {
    haptic('light');
    setLive('loading');
    poller.refresh();
  });
  poller.start();

  // ── Actions ──
  const actions = h('div', { class: 'rd-actions' });
  const mapBtn = h('button', { class: 'btn btn-primary', type: 'button', html: `${ICONS.map}<span>Ver en el mapa</span>` });
  mapBtn.style.setProperty('--accent', accent);
  mapBtn.addEventListener('click', () => {
    haptic('medium');
    sheet.close();
    app().showRouteOnMap(route);
  });
  actions.append(mapBtn);
  sheet.body.append(actions);

  // ── Schedule ──
  if (route.schedule) {
    sheet.body.append(
      h('div', { class: 'rd-section' }, [
        h('div', { class: 'rd-section-title', text: 'Horarios' }),
        h('div', { class: 'rd-schedule', text: route.schedule }),
      ])
    );
  }

  // ── Stops timeline ──
  const stops = route.stops ?? [];
  const section = h('div', { class: 'rd-section' });
  section.append(h('div', { class: 'rd-section-title', text: `Paradas (${stops.length})` }));
  if (stops.length === 0) {
    section.append(h('div', { class: 'muted', text: 'Trazado sin paradas detalladas.' }));
  } else {
    const timeline = h('div', { class: 'timeline' });
    timeline.style.setProperty('--accent', accent);
    stops.forEach((stop, i) => {
      const node = h('button', { class: 'timeline-stop', type: 'button' });
      const isEnd = i === 0 || i === stops.length - 1;
      node.append(
        h('span', { class: `timeline-dot${isEnd ? ' end' : ''}` }),
        h('div', { class: 'timeline-info' }, [
          h('div', { class: 'timeline-name', text: stop.nombre }),
          stop.direccion ? h('div', { class: 'timeline-addr', text: stop.direccion }) : h('span'),
        ])
      );
      node.addEventListener('click', () => {
        openStationSheet({
          code: stop.sourceCode || stop.codigo,
          name: stop.nombre,
          direccion: stop.direccion || '',
          coordinate: stop.coordinate,
          wagonCount: 0,
          kind: stop.kind ?? (route.type === 'troncal' ? 'station' : 'stop'),
        });
      });
      timeline.append(node);
    });
    section.append(timeline);
  }
  sheet.body.append(section);
}

/** Routes that serve a given station/stop code (both directions kept distinct). */
function routesServing(code: string): RouteListItem[] {
  const target = code.toUpperCase();
  const seen = new Set<string>();
  const out: RouteListItem[] = [];
  for (const route of state.routes) {
    const hit = (route.stops ?? []).some(
      (s) => (s.codigo || '').toUpperCase() === target || (s.sourceCode || '').toUpperCase() === target
    );
    if (hit && !seen.has(route.id)) {
      seen.add(route.id);
      out.push(route);
    }
  }
  return out;
}

/** Fetch + render real-time arrivals for a stop into `host` (spec §5.8). */
async function loadArrivals(cenefa: string, host: HTMLElement): Promise<void> {
  if (!cenefa) {
    host.replaceChildren(h('div', { class: 'muted', text: 'Sin código de paradero.' }));
    return;
  }
  try {
    const res = await api.getArrivals(cenefa);
    const arrivals = res.arrivals ?? [];
    if (arrivals.length === 0) {
      host.replaceChildren(h('div', { class: 'muted', text: 'Sin llegadas en este momento.' }));
      return;
    }
    host.replaceChildren(
      ...arrivals.slice(0, 8).map((a) => {
        const badge = h('span', { class: 'arr-badge', text: a.codigo || '—' });
        badge.style.background = a.color || PARADERO_COLOR;
        if (needsDarkText(a.color || PARADERO_COLOR)) badge.style.color = '#12151b';
        return h('div', { class: 'arr-row' }, [
          badge,
          h('span', { class: 'arr-dest', text: a.destino }),
          h('span', { class: 'arr-time', text: a.tiempo || a.distancia || '' }),
        ]);
      })
    );
  } catch {
    host.replaceChildren(h('div', { class: 'muted', text: 'Llegadas no disponibles.' }));
  }
}

export function openStationSheet(station: StationRecord): void {
  const isStation = station.kind === 'station';
  const sheet = openDetailSheet({ accent: isStation ? STATION_COLOR : PARADERO_COLOR });

  const header = h('div', { class: 'st-header' });
  const icon = h('span', { class: `st-icon ${isStation ? 'is-station' : 'is-stop'}`, html: ICONS.route });
  header.append(
    icon,
    h('div', {}, [
      h('div', { class: 'st-name', text: station.name }),
      h('div', { class: 'st-kind', text: isStation ? 'Estación troncal' : 'Paradero zonal' }),
    ])
  );
  sheet.body.append(header);

  if (station.direccion) sheet.body.append(h('div', { class: 'st-addr', text: station.direccion }));

  const meta = h('div', { class: 'st-meta' });
  if (station.wagonCount) meta.append(h('span', { class: 'st-pill', text: `${station.wagonCount} vagones` }));
  meta.append(h('span', { class: 'st-pill', text: station.code || '—' }));
  sheet.body.append(meta);

  const mapBtn = h('button', { class: 'btn btn-ghost', type: 'button', html: `${ICONS.locate}<span>Ver en el mapa</span>` });
  mapBtn.addEventListener('click', () => {
    haptic('medium');
    sheet.close();
    app().focusPoint(station);
  });
  // Seed the planner from this point ("Desde aquí / Hasta aquí" — website parity).
  const seedPlanner = (role: 'origin' | 'destination') => {
    haptic('medium');
    const ep = { coord: station.coordinate, code: station.code, name: station.name };
    sheet.close(true); // synchronous — no sheet-over-sheet cross-animation
    openPlannerSheet(role === 'origin' ? { origin: ep } : { destination: ep });
  };
  const fromBtn = h('button', { class: 'btn btn-ghost', type: 'button', html: `${ICONS.plan}<span>Desde aquí</span>` });
  fromBtn.addEventListener('click', () => seedPlanner('origin'));
  const toBtn = h('button', { class: 'btn btn-ghost', type: 'button', html: `${ICONS.near}<span>Hasta aquí</span>` });
  toBtn.addEventListener('click', () => seedPlanner('destination'));
  sheet.body.append(h('div', { class: 'rd-actions' }, [mapBtn]), h('div', { class: 'rd-actions rd-actions-2' }, [fromBtn, toBtn]));

  // Real-time arrivals (spec §5.8) — only for zonal paraderos, whose `code` is
  // the cenefa `/paradero/buses` expects. Troncal stations use a different keying,
  // so skip the (always-empty) call for them.
  if (station.kind === 'stop') {
    const arrSection = h('div', { class: 'rd-section' });
    arrSection.append(h('div', { class: 'rd-section-title', text: 'Próximas llegadas' }));
    const arrBody = h('div', { class: 'arr-body' }, [h('div', { class: 'muted', text: 'Buscando llegadas…' })]);
    arrSection.append(arrBody);
    sheet.body.append(arrSection);
    void loadArrivals(station.code, arrBody);
  }

  const serving = routesServing(station.code);
  const section = h('div', { class: 'rd-section' });
  section.append(h('div', { class: 'rd-section-title', text: `Rutas (${serving.length})` }));
  if (serving.length === 0) {
    section.append(h('div', { class: 'muted', text: 'Sin rutas asociadas en el catálogo.' }));
  } else {
    const grid = h('div', { class: 'st-routes' });
    for (const route of serving.slice(0, 40)) {
      const chip = h('button', { class: 'st-route-chip', type: 'button' });
      const b = routeBadge(route, 'sm');
      chip.append(b, h('span', { class: 'st-route-dest', text: `→ ${route.destination}` }));
      const c = getRouteAccentColor(route);
      chip.style.borderColor = c;
      if (needsDarkText(c)) chip.style.color = '#dfe5ee';
      chip.addEventListener('click', () => {
        // openRouteSheet replaces this sheet (detail sheets never stack).
        openRouteSheet(route);
      });
      grid.append(chip);
    }
    section.append(grid);
  }
  sheet.body.append(section);
}

/** Distance-annotated variant used by "Cerca". */
export function openStationSheetWithDistance(station: StationRecord, meters: number): void {
  openStationSheet(station);
  toast(`${station.name} · ${formatDistance(meters)}`, 'info');
}
