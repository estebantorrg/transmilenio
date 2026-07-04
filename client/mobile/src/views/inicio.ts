/** Inicio tab — dashboard: status, quick actions, favorites, recents, lines. */

import { TRONCAL_COLORS } from '@shared/utils/routeColors';
import { h, haptic } from '../lib/dom';
import { formatClock, greeting, needsDarkText } from '../lib/format';
import { bus, state } from '../state';
import { getFavorites, getRecents } from '../lib/storage';
import { app } from '../appContext';
import { openRouteSheet } from '../ui/detailSheets';
import { openPlannerSheet } from './planner';
import { ICONS, routeBadge } from '../ui/components';
import type { View } from './types';

export function createInicioView(): View {
  const el = h('section', { class: 'screen screen-inicio' });

  // ── Hero ──
  const clock = h('span', { class: 'hero-clock', text: formatClock() });
  const hero = h('div', { class: 'hero' }, [
    h('div', { class: 'hero-row' }, [
      h('div', {}, [
        h('div', { class: 'hero-greeting', text: greeting() }),
        h('div', { class: 'hero-brand', html: 'TransMi <b>Go</b>' }),
      ]),
      h('div', { class: 'hero-clock-wrap' }, [h('span', { class: 'hero-clock-icon', html: ICONS.clock }), clock]),
    ]),
  ]);

  // ── Service status ──
  const statusCard = h('div', { class: 'status-card' });
  function renderStatus(): void {
    const hp = state.health;
    const dot = (ok: boolean, warn = false) => `status-dot ${warn ? 'warn' : ok ? 'ok' : 'err'}`;
    const catalogOk = (state.counts.stations || hp?.catalogStations || 0) > 0;
    const live = hp?.liveCapable;
    statusCard.replaceChildren(
      h('div', { class: 'status-line' }, [
        h('span', { class: dot(catalogOk, hp?.catalogStale) }),
        h('span', {
          class: 'status-text',
          text: catalogOk
            ? `Red cargada · ${state.counts.troncal + state.counts.zonal} rutas`
            : 'Cargando catálogo…',
        }),
      ]),
      h('div', { class: 'status-line' }, [
        h('span', { class: dot(Boolean(live), !live) }),
        h('span', { class: 'status-text', text: live ? 'Buses en vivo disponibles' : 'Buses en vivo: modo limitado' }),
      ])
    );
  }
  renderStatus();

  // ── Quick actions ──
  const actions = h('div', { class: 'quick-grid' });
  const mkAction = (icon: string, label: string, cls: string, onClick: () => void) => {
    const btn = h('button', { class: `quick-action ${cls}`, type: 'button' }, [
      h('span', { class: 'quick-icon', html: icon }),
      h('span', { class: 'quick-label', text: label }),
    ]);
    btn.addEventListener('click', () => {
      haptic('light');
      onClick();
    });
    return btn;
  };
  actions.append(
    mkAction(ICONS.plan, 'Planear', 'qa-plan', () => openPlannerSheet()),
    mkAction(ICONS.map, 'Mapa en vivo', 'qa-map', () => app().navigate('mapa')),
    mkAction(ICONS.near, 'Cerca de mí', 'qa-near', () => app().navigate('cerca')),
    mkAction(ICONS.card, 'Mi saldo', 'qa-card', () => app().navigate('saldo'))
  );

  // ── Favorites ──
  const favSection = h('div', { class: 'home-section' });
  const recentSection = h('div', { class: 'home-section' });

  function routeRail(ids: string[], emptyText: string): HTMLElement {
    const rail = h('div', { class: 'route-rail' });
    const routes = ids.map((id) => state.routeById.get(id)).filter(Boolean) as NonNullable<ReturnType<typeof state.routeById.get>>[];
    if (routes.length === 0) {
      rail.append(h('div', { class: 'rail-empty', text: emptyText }));
      return rail;
    }
    for (const route of routes.slice(0, 12)) {
      const card = h('button', { class: 'rail-card', type: 'button' });
      card.append(routeBadge(route, 'md'), h('div', { class: 'rail-dest', text: route.destination }));
      card.addEventListener('click', () => openRouteSheet(route));
      rail.append(card);
    }
    return rail;
  }

  function renderFavorites(): void {
    favSection.replaceChildren(
      h('div', { class: 'section-head' }, [
        h('span', { class: 'section-title', html: `${ICONS.starFill} Favoritas` }),
      ]),
      routeRail(getFavorites(), 'Marca rutas con ★ para verlas aquí.')
    );
  }
  function renderRecents(): void {
    const recents = getRecents();
    recentSection.classList.toggle('hidden', recents.length === 0);
    recentSection.replaceChildren(
      h('div', { class: 'section-head' }, [h('span', { class: 'section-title', html: `${ICONS.clock} Recientes` })]),
      routeRail(recents, '')
    );
  }

  // ── Explore by line ──
  const lineSection = h('div', { class: 'home-section' });
  function renderLines(): void {
    const present = new Set<string>();
    for (const r of state.routes) {
      if (r.type !== 'troncal') continue;
      const letter = r.code.trim().charAt(0).toUpperCase();
      if (letter in TRONCAL_COLORS) present.add(letter);
    }
    const grid = h('div', { class: 'line-grid' });
    for (const letter of Object.keys(TRONCAL_COLORS)) {
      if (!present.has(letter)) continue;
      const color = TRONCAL_COLORS[letter];
      const chip = h('button', { class: 'line-chip', type: 'button', text: letter });
      chip.style.background = color;
      chip.style.color = needsDarkText(color) ? '#0a0e17' : '#fff';
      chip.addEventListener('click', () => {
        haptic('light');
        app().openLine(letter);
      });
      grid.append(chip);
    }
    lineSection.replaceChildren(
      h('div', { class: 'section-head' }, [h('span', { class: 'section-title', html: `${ICONS.routes} Explora por línea` })]),
      grid
    );
  }

  renderFavorites();
  renderRecents();
  renderLines();

  el.append(hero, statusCard, actions, favSection, lineSection, recentSection);

  bus.on('health', renderStatus);
  bus.on('routes:ready', () => {
    renderStatus();
    renderFavorites();
    renderRecents();
    renderLines();
  });
  bus.on('favorites:changed', renderFavorites);

  let clockTimer: number | undefined;
  return {
    el,
    onShow: () => {
      clock.textContent = formatClock();
      renderFavorites();
      renderRecents();
      clockTimer = window.setInterval(() => (clock.textContent = formatClock()), 20_000);
    },
    onHide: () => window.clearInterval(clockTimer),
  };
}
