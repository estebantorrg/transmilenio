/** Rutas tab — searchable, filterable browser for routes AND places. */

import { getRouteZoneLetters, isAlimentadorRoute, isRutaFacilRoute, TRONCAL_COLORS, STATION_COLOR, PARADERO_COLOR } from '@shared/utils/routeColors';
import {
  countPointMatches,
  emptyPointMatches,
  normalizePointText,
  POINT_KINDS,
  POINT_KIND_LABELS,
  POINT_KIND_META,
  previewPointsAcrossKinds,
  rankPointsByKind,
  type PointKind,
  type PointMatches,
} from '@shared/data/pointKinds';
import type { RouteListItem } from '@shared/types/transmilenio';
import { h } from '../lib/dom';
import { de } from '@shared/utils/text';
import { needsDarkText } from '../lib/format';
import { getZonalAreas } from '../data';
import { allPoints, bus, state, type StationRecord } from '../state';
import { getFavorites } from '../lib/storage';
import { openRouteSheet } from '../ui/detailSheets';
import { pointRow } from '../ui/pointRow';
import { ICONS, routeCard } from '../ui/components';
import type { View } from './types';

type Filter = 'all' | 'troncal' | 'zonal' | 'alimentador' | 'facil' | 'fav';

/**
 * What the query looks for (spec §5.4.2b). Until now the app could only look up
 * ROUTES by name: the ~12 500 places — estaciones, paraderos, puntos de recarga,
 * cicloparqueaderos, TransMiCable — were reachable only by standing next to them
 * with GPS on, in Cerca. `Todo` keeps a mixed view; any other scope answers with
 * exactly one thing and drops the route-only chrome with it.
 */
type Scope = 'all' | 'routes' | PointKind;

/** Route rows added per page. The list used to stop dead at 140 with a
 *  "Mostrando 140 de 419" label and no way to reach the other 279. */
const PAGE_SIZE = 80;
/** Place rows above the routes in the mixed `Todo` view — a preview, not the set. */
const PLACE_PREVIEW = 6;
/** Place rows when a single kind IS the scope: the rider asked for these. */
const PLACE_LIMIT = 80;

function matchesFilter(route: RouteListItem, filter: Filter, favorites: Set<string>): boolean {
  switch (filter) {
    case 'troncal':
      return route.type === 'troncal';
    case 'zonal':
      return route.type === 'zonal' && !isAlimentadorRoute(route);
    case 'alimentador':
      return isAlimentadorRoute(route);
    case 'facil':
      return isRutaFacilRoute(route);
    case 'fav':
      return favorites.has(route.id);
    default:
      return true;
  }
}

export function createRutasView(): View {
  const el = h('section', { class: 'screen screen-rutas' });

  const head = h('div', { class: 'screen-head' }, [
    h('h1', { class: 'screen-title', text: 'Buscar' }),
    h('p', { class: 'screen-sub', text: 'Rutas, estaciones, paraderos y puntos de la red' }),
  ]);

  const searchWrap = h('div', { class: 'search-pill' });
  searchWrap.innerHTML = ICONS.search;
  const input = h('input', {
    class: 'search-field',
    type: 'search',
    placeholder: 'Ruta, estación, paradero o dirección…',
    autocomplete: 'off',
    enterkeyhint: 'search',
    'aria-label': 'Buscar en la red',
  }) as HTMLInputElement;
  searchWrap.append(input);

  // ── Scope chips (only while a query exists) ──
  let scope: Scope = 'all';
  const scopeRow = h('div', { class: 'chip-row scope-row hidden', role: 'tablist', 'aria-label': 'Qué buscar' });

  // ── Route type filter ──
  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'Todas' },
    { id: 'fav', label: '★ Favoritas' },
    { id: 'troncal', label: 'Troncal' },
    { id: 'zonal', label: 'Zonal' },
    { id: 'alimentador', label: 'Alimentador' },
    { id: 'facil', label: 'Fácil' },
  ];
  const chipRow = h('div', { class: 'chip-row', role: 'tablist', 'aria-label': 'Filtrar rutas por tipo' });
  let activeFilter: Filter = 'all';
  const chipEls = new Map<Filter, HTMLElement>();
  for (const f of filters) {
    const chip = h('button', { class: 'chip', type: 'button', role: 'tab', text: f.label });
    if (f.id === 'all') {
      chip.classList.add('active');
      chip.setAttribute('aria-selected', 'true');
    } else {
      chip.setAttribute('aria-selected', 'false');
    }
    chip.addEventListener('click', () => {
      // Keep the active line/area (if any) — chips sub-filter type WITHIN it.
      activeFilter = f.id;
      syncTypeChips();
      shownRoutes = PAGE_SIZE;
      shownPlaces = PLACE_LIMIT;
      render();
    });
    chipEls.set(f.id, chip);
    chipRow.append(chip);
  }
  function syncTypeChips(): void {
    chipEls.forEach((c, id) => {
      const on = id === activeFilter;
      c.classList.toggle('active', on);
      c.setAttribute('aria-selected', String(on));
    });
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

  const countLine = h('div', { class: 'list-count', role: 'status', 'aria-live': 'polite' });
  const list = h('div', { class: 'route-list' });

  head.append(searchWrap, scopeRow, chipRow, lineBanner, countLine);
  el.append(head, list);

  let query = '';
  /** How many route rows are currently rendered ("Ver más" grows it). */
  let shownRoutes = PAGE_SIZE;
  let shownPlaces = PLACE_LIMIT;

  function matchedRoutes(): RouteListItem[] {
    const q = normalizePointText(query);
    const favorites = new Set(getFavorites());
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
      if (!matchesFilter(r, activeFilter, favorites)) return false;
      if (!q) return true;
      return normalizePointText(`${r.code} ${r.name} ${r.origin} ${r.destination}`).includes(q);
    });
    // Under a search, exact/prefix code hits outrank text matches (e.g. "7"
    // surfaces ruta 7 before 7-1 and before names containing a 7).
    const rank = (r: RouteListItem): number => {
      const code = normalizePointText(r.code);
      if (code === q) return 0;
      if (code.startsWith(q)) return 1;
      return 2;
    };
    matched.sort((a, b) => {
      if (q) {
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) return byRank;
      }
      return a.code.localeCompare(b.code, 'es', { numeric: true });
    });
    return matched;
  }

  function scopeLabel(s: Scope): string {
    if (s === 'all') return 'Todo';
    if (s === 'routes') return 'Rutas';
    return POINT_KIND_LABELS[s];
  }

  /**
   * The scope row exists only while a query does — browsing the network needs
   * the type/line/zone filters, not a "what am I searching" question. A scope
   * with zero hits stays visible but disabled, so the rider still learns the
   * category is searchable.
   */
  function renderScopeChips(routeCount: number, points: PointMatches<StationRecord>): void {
    if (!query.trim()) {
      scopeRow.classList.add('hidden');
      scopeRow.replaceChildren();
      return;
    }
    const counts: Record<Scope, number> = {
      all: routeCount + countPointMatches(points),
      routes: routeCount,
    } as Record<Scope, number>;
    for (const kind of POINT_KINDS) counts[kind] = points[kind].length;

    scopeRow.replaceChildren();
    for (const s of ['all', 'routes', ...POINT_KINDS] as Scope[]) {
      const count = counts[s];
      const active = scope === s;
      const chip = h('button', {
        class: `chip scope-chip${active ? ' active' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': String(active),
      }, [
        document.createTextNode(scopeLabel(s)),
        h('span', { class: 'scope-chip-count', text: String(count) }),
      ]) as HTMLButtonElement;
      if (count === 0 && s !== 'all') chip.disabled = true;
      chip.addEventListener('click', () => {
        if (scope === s) return;
        scope = s;
        shownRoutes = PAGE_SIZE;
        shownPlaces = PLACE_LIMIT;
        render();
      });
      scopeRow.append(chip);
    }
    scopeRow.classList.remove('hidden');
  }

  /** "1 ruta" / "32 rutas" — the count line read "1 lugares" without this. */
  function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
  }

  function emptyBlock(title: string, text: string): HTMLElement {
    return h('div', { class: 'empty' }, [
      h('div', { class: 'empty-title', text: title }),
      h('div', { class: 'empty-text', text }),
    ]);
  }

  function render(): void {
    const q = query.trim();
    const points = q ? rankPointsByKind(allPoints(), q, (p) => `${p.code} ${p.direccion}`) : emptyPointMatches<StationRecord>();
    // Always resolved: the scope chips carry the route count too, so a rider in
    // a place scope still sees how many routes are one tap away.
    const routes = matchedRoutes();

    // Never a dead end (same rule as the website, spec §5.4.2b): a scope carried
    // over from the previous query that matches nothing for this one widens back
    // to `Todo`, instead of showing an empty panel next to a chip reading 419.
    if (scope !== 'all' && scope !== 'routes' && q && points[scope].length === 0) scope = 'all';
    if (scope === 'routes' && q && routes.length === 0 && countPointMatches(points) > 0) scope = 'all';

    renderScopeChips(routes.length, points);

    // Route-only controls make no sense while the results are places.
    const placesOnly = scope !== 'all' && scope !== 'routes';
    chipRow.classList.toggle('hidden', placesOnly);
    if (placesOnly) lineBanner.classList.add('hidden');
    else if (lineFilter || zoneFilter != null) lineBanner.classList.remove('hidden');

    list.replaceChildren();

    if (placesOnly) {
      const matches = points[scope as PointKind];
      const visible = matches.slice(0, shownPlaces);
      const kindMeta = POINT_KIND_META[scope as PointKind];
      countLine.textContent = `${matches.length} ${(matches.length === 1 ? kindMeta.label : kindMeta.plural).toLowerCase()}`;
      if (visible.length === 0) {
        // Reaching here means nothing matched in ANY category: a scope that is
        // empty while another has hits already widened back to `Todo` above.
        list.append(
          emptyBlock(
            `Sin ${kindMeta.plural.toLowerCase()}`,
            `Nada coincide con “${q}” en ninguna categoría. Se busca por nombre, dirección y código.`
          )
        );
        return;
      }
      const wrap = h('div', { class: 'near-list' });
      for (const p of visible) wrap.append(pointRow(p));
      list.append(wrap);
      // Places page like the routes do — "Afina la búsqueda" was an instruction,
      // not a way to reach the rest of the list.
      if (matches.length > visible.length) {
        const more = h('button', { class: 'list-more', type: 'button', text: `Ver más (${matches.length - visible.length} restantes)` });
        more.addEventListener('click', () => {
          shownPlaces += PLACE_LIMIT;
          render();
          list.lastElementChild?.scrollIntoView({ block: 'nearest' });
        });
        list.append(more);
      }
      return;
    }

    // Mixed view: a preview of places above the routes, round-robin across kinds
    // so one crowded kind (paraderos) cannot hide the others.
    const preview = scope === 'all' && q && activeFilter !== 'fav' ? previewPointsAcrossKinds(points, PLACE_PREVIEW, 2) : [];
    const placeTotal = countPointMatches(points);

    if (preview.length > 0) {
      const wrap = h('div', { class: 'near-list search-places' }, [
        h('div', { class: 'search-places-title' }, [
          document.createTextNode('Lugares'),
          h('span', { class: 'search-places-count', text: String(placeTotal) }),
        ]),
      ]);
      for (const p of preview) wrap.append(pointRow(p));
      if (placeTotal > preview.length) {
        const more = h('button', { class: 'list-more', type: 'button', text: `Ver los ${placeTotal} lugares` });
        more.addEventListener('click', () => {
          // Jump to the kind with the most hits — the one the rider most likely meant.
          const best = POINT_KINDS.reduce((a, b) => (points[b].length > points[a].length ? b : a), POINT_KINDS[0]);
          scope = best;
          render();
        });
        wrap.append(more);
      }
      list.append(wrap);
    }

    if (routes.length === 0) {
      if (preview.length === 0) {
        // Name the narrowing in effect and offer to lift it — "prueba otro
        // código" was the same sentence whether the rider had a typo or a line
        // /zone/type filter silently swallowing every result.
        const narrowing = lineFilter
          ? { label: `la línea ${lineFilter}`, clear: () => clearArea() }
          : zoneFilter != null
          ? { label: `la zona ${zoneFilter}`, clear: () => clearArea() }
          : activeFilter !== 'all' && activeFilter !== 'fav'
          ? {
              label: `el filtro ${filters.find((f) => f.id === activeFilter)?.label ?? activeFilter}`,
              clear: () => {
                activeFilter = 'all';
                syncTypeChips();
              },
            }
          : null;

        if (activeFilter === 'fav') {
          list.append(emptyBlock('Sin rutas favoritas', 'Toca la estrella ★ en cualquier ruta para guardarla aquí.'));
        } else {
          const block = emptyBlock(
            'Sin rutas',
            q
              ? `Ningún resultado para “${q}”${narrowing ? ` dentro ${de(narrowing.label)}` : ''}.`
              : narrowing
              ? `No hay rutas en ${narrowing.label}.`
              : 'Busca por código (B75), estación (Calle 100) o destino (Portal Sur).'
          );
          if (narrowing) {
            const undo = h('button', { class: 'btn btn-ghost empty-action', type: 'button', text: 'Quitar el filtro' });
            undo.addEventListener('click', () => {
              narrowing.clear();
              shownRoutes = PAGE_SIZE;
              render();
            });
            block.append(undo);
          }
          list.append(block);
        }
      }
      countLine.textContent = preview.length > 0 ? plural(placeTotal, 'lugar', 'lugares') : '';
      return;
    }

    if (preview.length > 0) {
      list.append(h('div', { class: 'search-places-title standalone' }, [
        document.createTextNode('Rutas'),
        h('span', { class: 'search-places-count', text: String(routes.length) }),
      ]));
    }
    const visible = routes.slice(0, shownRoutes);
    for (const route of visible) list.append(routeCard(route, openRouteSheet));
    if (routes.length > visible.length) {
      const more = h('button', { class: 'list-more', type: 'button', text: `Ver más (${routes.length - visible.length} restantes)` });
      more.addEventListener('click', () => {
        shownRoutes += PAGE_SIZE;
        render();
        // Keep the rider where they were: re-rendering scrolls nothing, but the
        // button they tapped is gone, so put focus on the list tail instead.
        list.lastElementChild?.scrollIntoView({ block: 'nearest' });
      });
      list.append(more);
    }
    const routeCount = plural(routes.length, 'ruta', 'rutas');
    countLine.textContent =
      preview.length > 0 ? `${routeCount} · ${plural(placeTotal, 'lugar', 'lugares')}` : routeCount;
  }

  let searchTimer: number | undefined;
  input.addEventListener('input', () => {
    if (input.value) clearArea();
    query = input.value;
    shownRoutes = PAGE_SIZE;
    shownPlaces = PLACE_LIMIT;
    if (!query.trim()) scope = 'all';
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(render, 90);
  });

  bus.on('routes:ready', render);
  bus.on('stops:ready', render);
  bus.on('cable:ready', render);
  bus.on('favorites:changed', () => {
    if (activeFilter === 'fav') render();
  });

  return {
    el,
    onShow: () => {
      if (state.routes.length && list.childElementCount === 0) render();
    },
    setLine: (letter: string) => {
      clearArea();
      lineFilter = letter;
      activeFilter = 'all';
      scope = 'all';
      syncTypeChips();
      query = '';
      input.value = '';
      shownRoutes = PAGE_SIZE;
      shownPlaces = PLACE_LIMIT;
      showAreaBanner(letter, `Línea ${letter} · TransMilenio troncal`, TRONCAL_COLORS[letter] || STATION_COLOR);
      render();
    },
    setZone: (zone: number) => {
      clearArea();
      zoneFilter = zone;
      activeFilter = 'all';
      scope = 'all';
      syncTypeChips();
      query = '';
      input.value = '';
      shownRoutes = PAGE_SIZE;
      shownPlaces = PLACE_LIMIT;
      const label = state.zoneLabels.get(zone);
      showAreaBanner(String(zone), label ? `Zona ${zone} · ${label}` : `Zona SITP ${zone}`, PARADERO_COLOR);
      render();
    },
  } as View & { setLine: (letter: string) => void; setZone: (zone: number) => void };
}
