/** Route-detail and station-detail bottom sheets (shared by every tab). */

import { getRouteAccentColor, STATION_COLOR, PARADERO_COLOR } from '@shared/utils/routeColors';
import type { RouteListItem } from '@shared/types/transmilenio';
import type { LiveBusResult } from '@shared/services/api';
import type { TrackingStatus } from '@shared/layers/buses';
import { h, escapeHTML, haptic, toast } from '../lib/dom';
import { formatDistance, needsDarkText } from '../lib/format';
import { isFavorite, toggleFavorite, pushRecent } from '../lib/storage';
import { LivePoller } from '../live/liveStatus';
import { app } from '../appContext';
import { bus, state, type StationRecord } from '../state';
import { openSheet } from './sheet';
import { ICONS, liveChip, routeBadge, routeTypeLabel } from './components';

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
  const sheet = openSheet({ accent, full: true, onClose: () => poller.stop() });

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
  header.append(badge, titles, starButton(route));
  sheet.body.append(header);

  const tags = h('div', { class: 'rd-tags' });
  tags.append(h('span', { class: 'rd-tag', text: routeTypeLabel(route) }));
  // ArcGIS longitud_ruta_troncal is already in kilometres (verified: ~13–24),
  // matching the website's route.length display — do not divide by 1000.
  if (route.length && route.length > 0.2) tags.append(h('span', { class: 'rd-tag', text: `${route.length.toFixed(1)} km` }));
  if (route.busType) tags.append(h('span', { class: 'rd-tag', text: route.busType }));
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

export function openStationSheet(station: StationRecord): void {
  const isStation = station.kind === 'station';
  const sheet = openSheet({ accent: isStation ? STATION_COLOR : PARADERO_COLOR });

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
  sheet.body.append(h('div', { class: 'rd-actions' }, [mapBtn]));

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
        sheet.close();
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
