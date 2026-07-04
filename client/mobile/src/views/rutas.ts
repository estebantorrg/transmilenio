/** Rutas tab — searchable, filterable route browser. */

import { getRouteZoneLetters, isAlimentadorRoute, isRutaFacilCode, TRONCAL_COLORS } from '@shared/utils/routeColors';
import type { RouteListItem } from '@shared/types/transmilenio';
import { h } from '../lib/dom';
import { needsDarkText } from '../lib/format';
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
      clearLine();
      activeFilter = f.id;
      chipEls.forEach((c, id) => c.classList.toggle('active', id === activeFilter));
      render();
    });
    chipEls.set(f.id, chip);
    chipRow.append(chip);
  }

  // Active "line" context banner (from Inicio → Explora por línea).
  let lineFilter: string | null = null;
  const lineBanner = h('div', { class: 'line-banner hidden' });
  const clearLine = (): void => {
    lineFilter = null;
    lineBanner.classList.add('hidden');
  };

  const countLine = h('div', { class: 'list-count' });
  const list = h('div', { class: 'route-list' });

  head.append(searchWrap, chipRow, lineBanner, countLine);
  el.append(head, list);

  let query = '';
  function render(): void {
    const q = norm(query.trim());
    const matched = state.routes.filter((r) => {
      // Line mode (Explora por línea): troncal routes whose zone letters include
      // the chosen line — e.g. "F" matches F19, GF..., etc.
      if (lineFilter) {
        return r.type === 'troncal' && getRouteZoneLetters(r.code).includes(lineFilter);
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
    if (input.value) clearLine();
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
      lineFilter = letter;
      activeFilter = 'all';
      chipEls.forEach((c, id) => c.classList.toggle('active', id === 'all'));
      query = '';
      input.value = '';
      const color = TRONCAL_COLORS[letter] || '#e3342f';
      const badge = h('span', { class: 'line-banner-badge', text: letter });
      badge.style.background = color;
      badge.style.color = needsDarkText(color) ? '#0a0e17' : '#fff';
      const x = h('button', { class: 'line-banner-x', type: 'button', 'aria-label': 'Quitar línea', text: '✕' });
      x.addEventListener('click', () => {
        clearLine();
        render();
      });
      lineBanner.replaceChildren(
        badge,
        h('span', { class: 'line-banner-text', text: `Línea ${letter} · troncal` }),
        x
      );
      lineBanner.style.setProperty('--line-color', color);
      lineBanner.classList.remove('hidden');
      render();
    },
  } as View & { setLine: (letter: string) => void };
}
