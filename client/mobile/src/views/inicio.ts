/** Inicio tab — dashboard: status, quick actions, favorites, recents, lines. */

import { TRONCAL_COLORS } from '@shared/utils/routeColors';
import { closedWindowNotice, liveWindowLabel } from '@shared/services/liveWindow';
import { h, haptic } from '../lib/dom';
import { formatClock, greeting, needsDarkText } from '../lib/format';
import { bus, state } from '../state';
import { getFavorites, getRecents } from '../lib/storage';
import { app } from '../appContext';
import { WEB_ORIGIN, openRouteSheet } from '../ui/detailSheets';
import { legalLinksHtml } from '../../../../shared/legal.js';
import { ICONS, routeBadge } from '../ui/components';
import { canInstallInApp, dismissUpdate, findUpdate, installUpdate } from '../services/appUpdate';
import { refreshNovedades, type Novedad } from '../services/novedades';
import { openSheet } from '../ui/sheet';
import { BANNER_MAX_AGE_MS, ago, clock, headline, postText } from '../../../../shared/novedades.js';
import type { View } from './types';

const NOVEDADES_REFRESH_MS = 3 * 60_000;

/** The day's #TMAhora posts as TransMilenio wrote them, each with its link (spec §5.5.9). */
function openNovedadesSheet(items: Novedad[]): void {
  const sheet = openSheet({ title: 'Novedades de la operación', full: true, accent: 'var(--amber)' });
  sheet.body.append(
    h('p', {
      class: 'novedades-intro',
      text: 'Lo que TransMilenio publica como #TMAhora en X, de las últimas 24 horas, tal como lo publica.',
    }),
    ...items.map((post) =>
      h('article', { class: 'novedades-item' }, [
        h('div', { class: 'novedades-eyebrow', text: `${ago(post.at)} · ${clock(post.at)}` }),
        h('p', { class: 'novedades-text', text: postText(post.text) }),
        h('a', { class: 'novedades-link', href: post.url, target: '_blank', rel: 'noopener', text: 'Ver en X ↗' }),
      ])
    )
  );
}

export function createInicioView(): View {
  const el = h('section', { class: 'screen screen-inicio' });

  // ── Hero ──
  const clock = h('span', { class: 'hero-clock', text: formatClock() });
  const hero = h('div', { class: 'hero' }, [
    h('div', { class: 'hero-row' }, [
      h('div', {}, [
        h('div', { class: 'hero-greeting', text: greeting() }),
        h('div', { class: 'hero-brand', html: '<img src="/wordmark.svg" alt="MiTrasto" width="145" height="28">' }),
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
    // Outside the upstream's own window there is nothing to track for anyone —
    // say that rather than implying the app is degraded (spec §5.2.2a).
    const closed = closedWindowNotice();
    const liveText = closed
      ? `Rastreo en vivo cerrado · opera de ${liveWindowLabel()}`
      : live
      ? 'Buses en vivo disponibles'
      : 'Buses en vivo: modo limitado';
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
        h('span', { class: dot(Boolean(live) && !closed, Boolean(closed) || !live) }),
        h('span', { class: 'status-text', text: liveText }),
      ])
    );
  }
  renderStatus();

  // ── Novedades (spec §5.5.9) ──
  // Only while the newest post is recent: an old detour shown as current is
  // worse than none. The whole day's posts stay a tap away in the sheet.
  const novedadesCard = h('button', { class: 'novedades-card hidden', type: 'button' });
  let novedades: Novedad[] = [];
  function renderNovedades(): void {
    const newest = novedades[0];
    const show = newest !== undefined && Date.now() - newest.at <= BANNER_MAX_AGE_MS;
    novedadesCard.classList.toggle('hidden', !show);
    if (!newest || !show) return;
    const count = novedades.length;
    // The bare count on screen needs its words for a screen reader.
    novedadesCard.setAttribute(
      'aria-label',
      `TransMilenio, ${ago(newest.at)}: ${headline(newest.text)}. Ver ${count === 1 ? 'la novedad' : `las ${count} novedades`} de hoy`
    );
    novedadesCard.replaceChildren(
      h('span', { class: 'status-dot warn' }),
      h('span', { class: 'novedades-card-text' }, [
        h('span', { class: 'novedades-meta', text: `TransMilenio · ${ago(newest.at)}` }),
        h('span', { class: 'novedades-headline', text: headline(newest.text) }),
      ]),
      h('span', { class: 'novedades-more', 'aria-hidden': 'true', text: `${count} ›` })
    );
  }
  novedadesCard.addEventListener('click', () => {
    haptic('light');
    openNovedadesSheet(novedades);
  });
  const loadNovedades = (): void => {
    void refreshNovedades().then((items) => {
      novedades = items;
      renderNovedades();
    });
  };
  loadNovedades();

  // ── Update notice (spec §5.2.1b) ──
  // The APK is installed by hand, so nothing else tells a rider a newer release
  // exists. Empty and hidden unless there is one they have not dismissed.
  const updateCard = h('div', { class: 'update-card hidden', role: 'status' });
  void findUpdate().then((release) => {
    if (!release) return;
    const later = h('button', { class: 'update-later', type: 'button', text: 'Ahora no' });
    later.addEventListener('click', () => {
      dismissUpdate(release.version);
      updateCard.classList.add('hidden');
    });
    const note = h('span', { text: 'Se instala sobre esta: conservas tus tarjetas y favoritos.' });
    // The way out when the app cannot install it itself: an off-app link, which
    // Capacitor hands to the browser, which downloads the APK.
    const link = h('a', { class: 'update-go', href: release.url, target: '_blank', rel: 'noopener', text: 'Descargar' });
    const install = h('button', { class: 'update-go', type: 'button', text: 'Actualizar' });
    install.addEventListener('click', () => {
      install.disabled = true;
      later.disabled = true;
      install.textContent = 'Descargando…';
      void installUpdate(release, (state) => {
        install.textContent = state === 'instalando' ? 'Instalando…' : `Descargando… ${state} %`;
      }).then((outcome) => {
        later.disabled = false;
        if (outcome === 'instalada') {
          install.textContent = 'Actualizada';
          note.textContent = 'Cierra la app y ábrela de nuevo para usar la nueva versión.';
          return;
        }
        if (outcome === 'fallo') {
          // Not a dead end: the same release, the long way round.
          note.textContent = 'No se pudo actualizar desde la app. Descárgala con el navegador.';
          install.replaceWith(link);
          return;
        }
        install.disabled = false;
        install.textContent = 'Actualizar';
        if (outcome === 'sin-permiso') {
          note.textContent = 'Android necesita que permitas a MiTrasto instalar la actualización.';
        }
      });
    });
    updateCard.append(
      h('div', { class: 'update-text' }, [h('strong', { text: `Versión ${release.version} disponible` }), note]),
      h('div', { class: 'update-actions' }, [canInstallInApp() ? install : link, later])
    );
    updateCard.classList.remove('hidden');
  });

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
    mkAction(ICONS.plan, 'Planear', 'qa-plan', () => app().navigate('planner')),
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

  // ── Explore by SITP zone (numeric, from the ArcGIS feed) ──
  const zoneSection = h('div', { class: 'home-section' });
  function renderZones(): void {
    zoneSection.classList.toggle('hidden', state.zones.length === 0);
    if (state.zones.length === 0) return;
    const grid = h('div', { class: 'zone-grid' });
    for (const zone of state.zones) {
      const label = state.zoneLabels.get(zone);
      const pill = h('button', { class: 'zone-pill', type: 'button' }, [
        h('span', { class: 'zone-num', text: String(zone) }),
        h('span', { class: 'zone-name', text: label || `Zona ${zone}` }),
      ]);
      pill.addEventListener('click', () => {
        haptic('light');
        app().openZone(zone);
      });
      grid.append(pill);
    }
    zoneSection.replaceChildren(
      h('div', { class: 'section-head' }, [h('span', { class: 'section-title', html: `${ICONS.near} Zonas SITP` })]),
      h('p', { class: 'zone-hint', text: 'Zonas operativas del SITP zonal · toca para ver sus rutas' }),
      grid
    );
  }

  renderFavorites();
  renderRecents();
  renderLines();
  renderZones();

  // Privacidad · Términos at the foot of the home screen. They are pages of the
  // website, so they open in the browser (Capacitor hands off-app URLs to it).
  const legal = h('footer', { class: 'home-legal', html: legalLinksHtml(WEB_ORIGIN) });

  el.append(hero, statusCard, novedadesCard, updateCard, actions, favSection, recentSection, lineSection, zoneSection, legal);

  bus.on('health', renderStatus);
  bus.on('routes:ready', () => {
    renderStatus();
    renderFavorites();
    renderRecents();
    renderLines();
  });
  bus.on('stops:ready', renderZones);
  bus.on('favorites:changed', renderFavorites);

  let clockTimer: number | undefined;
  let novedadesTimer: number | undefined;
  return {
    el,
    onShow: () => {
      clock.textContent = formatClock();
      renderFavorites();
      renderRecents();
      clockTimer = window.setInterval(() => (clock.textContent = formatClock()), 20_000);
      loadNovedades();
      novedadesTimer = window.setInterval(loadNovedades, NOVEDADES_REFRESH_MS);
    },
    onHide: () => {
      window.clearInterval(clockTimer);
      window.clearInterval(novedadesTimer);
    },
  };
}
