/** Reusable presentational bits: badges, route cards, live chips, icons. */

import { getRouteAccentColor } from '@shared/utils/routeColors';
import { isAlimentadorRoute } from '@shared/utils/routeColors';
import { isRutaFacilCode } from '@shared/utils/routeColors';
import type { RouteListItem } from '@shared/types/transmilenio';
import type { TrackingStatus } from '@shared/layers/buses';
import type { LiveBusResult } from '@shared/services/api';
import { h, escapeHTML } from '../lib/dom';
import { needsDarkText } from '../lib/format';

export function routeTypeLabel(route: RouteListItem): string {
  if (isAlimentadorRoute(route)) return 'Alimentador';
  if (isRutaFacilCode(route.code)) return 'Ruta fácil';
  if (route.subType === 'dual') return 'Dual';
  return route.type === 'troncal' ? 'Troncal' : 'Zonal';
}

export function routeBadge(route: RouteListItem, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const color = getRouteAccentColor(route);
  const badge = h('span', { class: `route-badge route-badge-${size}`, text: route.code });
  badge.style.background = color;
  badge.style.color = needsDarkText(color) ? '#0a0e17' : '#fff';
  return badge;
}

const STATUS_META: Record<string, { cls: string; label: (r?: LiveBusResult) => string }> = {
  loading: { cls: 'live-loading', label: () => 'Buscando…' },
  live: { cls: 'live-on', label: (r) => `${r?.data.length ?? 0} en vivo` },
  'no-buses': { cls: 'live-off', label: () => 'Sin buses ahora' },
  unverified: { cls: 'live-warn', label: () => 'Sin confirmar' },
  stale: {
    cls: 'live-warn',
    label: (r) => {
      const t = r?.asOf ? new Date(r.asOf) : null;
      return t ? `Datos ${t.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}` : 'Datos recientes';
    },
  },
  unreachable: { cls: 'live-err', label: () => 'No disponible' },
};

export function liveChip(status: TrackingStatus | 'loading', result?: LiveBusResult): HTMLElement {
  const meta = STATUS_META[status] ?? STATUS_META.unreachable;
  const chip = h('span', { class: `live-chip ${meta.cls}` });
  chip.append(h('span', { class: 'live-dot' }), document.createTextNode(meta.label(result)));
  return chip;
}

/** Compact route row used in lists (Rutas, Home favorites, station sheet). */
export function routeCard(route: RouteListItem, onTap: (r: RouteListItem) => void): HTMLElement {
  const card = h('button', { class: 'route-card', type: 'button' });
  card.append(routeBadge(route, 'md'));
  const meta = h('div', { class: 'route-card-meta' });
  meta.append(
    h('div', { class: 'route-card-name', text: route.name }),
    h('div', {
      class: 'route-card-sub',
      html: `<span class="route-chip">${escapeHTML(routeTypeLabel(route))}</span> ${escapeHTML(route.origin)} <span class="arrow">→</span> ${escapeHTML(route.destination)}`,
    })
  );
  card.append(meta);
  card.append(h('span', { class: 'route-card-chev', html: '›' }));
  card.addEventListener('click', () => onTap(route));
  return card;
}

export function iconButton(svg: string, label: string, cls = ''): HTMLButtonElement {
  const btn = h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, html: svg });
  return btn;
}

/** Inline SVG icon set (stroke = currentColor). */
export const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  routes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg>',
  near: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18M7 15h3"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
  starFill: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  bus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="13" rx="2.5"/><path d="M4 11h16"/><circle cx="8" cy="19" r="1.6"/><circle cx="16" cy="19" r="1.6"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4M7 4 3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4"/></svg>',
};
