/** Rutas tab — searchable, filterable route browser. */

import { getRouteZoneLetters, isAlimentadorRoute, isRutaFacilCode, TRONCAL_COLORS } from '@shared/utils/routeColors';
import type { RouteListItem } from '@shared/types/transmilenio';
import { h } from '../lib/dom';
import { needsDarkText } from '../lib/format';
import { getZonalAreas } from '../data';
import { bus, state } from '../state';
import { openRouteSheet } from '../ui/detailSheets';
import { ICONS, routeCard } from '../ui/components';
import type { View } from './types';

type Filter = 'all' | 'troncal' | 'zonal' | 'alimentador' | 'facil';
const RENDER_CAP = 140;

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function matchesFilter(route: RouteListItem, filter: Filter): boolean {
  switch (filter) {
    case 'troncal':
      return route.type === 'troncal';
    case 'zonal':
      return route.type === 'zonal' && !isAlimentadorRoute(route);
    case 'alimentador':
      return isAlimentadorRoute(route);
    case 'facil':
      return isRutaFacilCode(route.code);
    default:
      return true;
  }
}

export function createRutasView(): View {
  const el = h('section', { class: 'screen screen-rutas' });

  const head = h('div', { class: 'screen-head' }, [
    h('h1', { class: 'screen-title', text: 'Rutas' }),
    h('p', { class: 'screen-sub', text: 'Todas las rutas de TransMilenio y SITP' }),
  ]);

  const searchWrap = h('div', { class: 'search-pill' });
  searchWrap.innerHTML = ICONS.search;
  const input = h('input', {
    class: 'search-field',
    type: 'search',
    placeholder: 'Busca código, nombre o destino…',
    autocomplete: 'off',
    enterkeyhint: 'search',
  }) as HTMLInputElement;
  searchWrap.append(input);

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'Todas' },
    { id: 'troncal', label: 'Troncal' },
    { id: 'zonal', label: 'Zonal' },
    { id: 'alimentador', label: 'Alimentador' },
    { id: 'facil', label: 'Fácil' },
  ];
  const chipRow = h('div', { class: 'chip-row' });
  let activeFilter: Filter = 'all';
  const chipEls = new Map<Filter, HTMLElement>();
  for (const f of filters) {
    const chip = h('button', { class: 'chip', type: 'button', text: f.label });
    if (f.id === 'all') chip.classList.add('active');
    chip.addEventListener('click', () => {
      // Keep the active line/area (if any) — chips sub-filter type WITHIN it.
      activeFilter = f.id;
      chipEls.forEach((c, id) => c.classList.toggle('active', id === activeFilter));
      render();
    });
    chipEls.set(f.id, chip);
    chipRow.append(chip);
  }

  // Active area context: a troncal corridor line (A–P) OR a SITP numeric zone
  // (1–13) — mutually exclusive, both shown via the same banner.
  let lineFilter: string | null = null;
  let zoneFilter: number | null = null;
  const lineBanner = h('div', { class: 'line-banner hidden' });
  const clearArea = (): void => {
    lineFilter = null;
    zoneFilter = null;
    lineBanner.classList.add('hidden');
  };

  const showAreaBanner = (badgeText: string, label: string, color: string): void => {
    const badge = h('span', { class: 'line-banner-badge', text: badgeText });
    badge.style.background = color;
    badge.style.color = needsDarkText(color) ? '#0a0e17' : '#fff';
    const x = h('button', { class: 'line-banner-x', type: 'button', 'aria-label': 'Quitar filtro', text: '✕' });
    x.addEventListener('click', () => {
      clearArea();
      render();
    });
    lineBanner.replaceChildren(badge, h('span', { class: 'line-banner-text', text: label }), x);
    lineBanner.style.setProperty('--line-color', color);
    lineBanner.classList.remove('hidden');
  };

  const countLine = h('div', { class: 'list-count' });
  const list = h('div', { class: 'route-list' });

  head.append(searchWrap, chipRow, lineBanner, countLine);
  el.append(head, list);

  let query = '';
  function render(): void {
    const q = norm(query.trim());
    const matched = state.routes.filter((r) => {
      if (lineFilter) {
        // Troncal corridor line (A–P) — TransMilenio only.
        if (r.type !== 'troncal' || !getRouteZoneLetters(r.code).includes(lineFilter)) return false;
      } else if (zoneFilter != null) {
        // SITP numeric zone (ArcGIS feed). Strict: only genuine zonal routes —
        // alimentadores (troncal feeders) and troncales never belong to a zone.
        if (r.type !== 'zonal' || isAlimentadorRoute(r)) return false;
        if (!getZonalAreas(r.code).includes(zoneFilter)) return false;
      }
      if (!matchesFilter(r, activeFilter)) return false;
      if (!q) return true;
      return norm(`${r.code} ${r.name} ${r.origin} ${r.destination}`).includes(q);
    });
    matched.sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true }));

    list.replaceChildren();
    const shown = matched.slice(0, RENDER_CAP);
    for (const route of shown) list.append(routeCard(route, openRouteSheet));

    if (matched.length === 0) {
      list.append(
        h('div', { class: 'empty' }, [
          h('div', { class: 'empty-title', text: 'Sin resultados' }),
          h('div', { class: 'empty-text', text: 'Prueba otro código o destino.' }),
        ])
      );
      countLine.textContent = '';
    } else {
      countLine.textContent =
        matched.length > RENDER_CAP ? `Mostrando ${RENDER_CAP} de ${matched.length}` : `${matched.length} rutas`;
    }
  }

  let searchTimer: number | undefined;
  input.addEventListener('input', () => {
    if (input.value) clearArea();
    query = input.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(render, 90);
  });

  bus.on('routes:ready', render);
  bus.on('stops:ready', render);

  return {
    el,
    onShow: () => {
      if (state.routes.length && list.childElementCount === 0) render();
    },
    setLine: (letter: string) => {
      clearArea();
      lineFilter = letter;
      activeFilter = 'all';
      chipEls.forEach((c, id) => c.classList.toggle('active', id === 'all'));
      query = '';
      input.value = '';
      showAreaBanner(letter, `Línea ${letter} · TransMilenio troncal`, TRONCAL_COLORS[letter] || '#e3342f');
      render();
    },
    setZone: (zone: number) => {
      clearArea();
      zoneFilter = zone;
      activeFilter = 'all';
      chipEls.forEach((c, id) => c.classList.toggle('active', id === 'all'));
      query = '';
      input.value = '';
      const label = state.zoneLabels.get(zone);
      showAreaBanner(String(zone), label ? `Zona ${zone} · ${label}` : `Zona SITP ${zone}`, '#00a7c4');
      render();
    },
  } as View & { setLine: (letter: string) => void; setZone: (zone: number) => void };
}
