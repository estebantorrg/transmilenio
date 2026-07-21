/**
 * TransMi Go — native mobile app entry.
 *
 * A ground-up app UI (bottom-tab shell, bottom sheets, live dashboard) that
 * shares ONLY the website's data/service layer (`@shared`), never its look.
 * Ships inside the Capacitor Android shell (mobile/); on the web it still runs,
 * but its reason to exist is the app.
 */

import './app.css';
import { state, bus, type TabId } from './state';
import { loadCore, loadBackground, fetchHealth } from './data';
import { setAppContext, app } from './appContext';
import { closeTopSheet, sheetCount } from './ui/sheet';
import { ICONS } from './ui/components';
import { createInicioView } from './views/inicio';
import { createRutasView } from './views/rutas';
import { createMapaView, type MapaView } from './views/mapa';
import { createCercaView } from './views/cerca';
import { createSaldoView } from './views/saldo';
import type { View } from './views/types';
import type { RouteListItem } from '@shared/types/transmilenio';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'inicio', label: 'Inicio', icon: ICONS.home },
  { id: 'rutas', label: 'Rutas', icon: ICONS.routes },
  { id: 'mapa', label: 'Mapa', icon: ICONS.map },
  { id: 'cerca', label: 'Cerca', icon: ICONS.near },
  { id: 'saldo', label: 'Saldo', icon: ICONS.card },
];

function boot(pct: number, label: string): void {
  const fill = document.getElementById('boot-fill');
  const status = document.getElementById('boot-status');
  if (fill) fill.style.width = `${pct}%`;
  if (status) status.textContent = label;
}

function hideBoot(): void {
  const el = document.getElementById('boot');
  const app = document.getElementById('app');
  app?.setAttribute('aria-hidden', 'false');
  if (el) {
    el.classList.add('gone');
    window.setTimeout(() => el.remove(), 500);
  }
}

async function main(): Promise<void> {
  if (state.native) document.body.classList.add('native-app');

  // Build views.
  type RutasView = View & { setLine: (letter: string) => void; setZone: (zone: number) => void };
  const inicio = createInicioView();
  const rutas = createRutasView() as RutasView;
  const mapa = createMapaView() as MapaView;
  const cerca = createCercaView();
  const saldo = createSaldoView();

  const views: Record<TabId, View> = { inicio, rutas, mapa, cerca, saldo };

  const screens = document.getElementById('screens')!;
  for (const view of Object.values(views)) {
    view.el.classList.add('screen-hidden');
    screens.append(view.el);
  }

  // Tab bar.
  const tabbar = document.getElementById('tabbar')!;
  const tabButtons = new Map<TabId, HTMLElement>();
  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.type = 'button';
    btn.setAttribute('aria-label', tab.label);
    btn.innerHTML = `<span class="tab-icon">${tab.icon}</span><span class="tab-label">${tab.label}</span>`;
    btn.addEventListener('click', () => navigate(tab.id));
    tabButtons.set(tab.id, btn);
    tabbar.append(btn);
  }

  // Back stack of visited tabs (most-recent last). Hardware back retraces it
  // instead of always dumping the user on Inicio — the app's worst UX bug was
  // "I go back and it sends somewhere I wasn't." Forward navigations are the ONLY
  // writers (pop-to-existing keeps it deduped); back reads it with record=false.
  const navStack: TabId[] = ['inicio'];

  function navigate(next: TabId, record = true): void {
    const alreadyVisible = next === state.tab && !views[next].el.classList.contains('screen-hidden');
    if (!alreadyVisible) {
      const current = views[state.tab];
      current.onHide?.();
      current.el.classList.add('screen-hidden');
      const prevBtn = tabButtons.get(state.tab);
      prevBtn?.classList.remove('active');
      prevBtn?.removeAttribute('aria-current');

      state.tab = next;
      const view = views[next];
      view.el.classList.remove('screen-hidden');
      const nextBtn = tabButtons.get(next);
      nextBtn?.classList.add('active');
      nextBtn?.setAttribute('aria-current', 'page');
      view.onShow?.();
      bus.emit('tab', next);
      screens.scrollTo({ top: 0 });
    }
    if (record) {
      // Revisiting a tab already in the trail pops back to it (no duplicate),
      // so the stack stays short and back always retraces a sane path.
      const existing = navStack.indexOf(next);
      if (existing >= 0) navStack.length = existing + 1;
      else navStack.push(next);
    }
  }

  // App context wiring for sheets/views.
  setAppContext({
    navigate,
    showRouteOnMap: (route: RouteListItem) => {
      navigate('mapa');
      mapa.showRoute(route);
    },
    focusPoint: (rec) => {
      navigate('mapa');
      mapa.focusPoint(rec);
    },
    setUserLocation: (coord) => mapa.setUser(coord),
    openLine: (letter: string) => {
      navigate('rutas');
      rutas.setLine(letter);
    },
    openZone: (zone: number) => {
      navigate('rutas');
      rutas.setZone(zone);
    },
    dismissMapRoute: () => mapa.dismissRoute(),
  });

  // Start on Inicio.
  views.inicio.el.classList.remove('screen-hidden');
  const inicioBtn = tabButtons.get('inicio');
  inicioBtn?.classList.add('active');
  inicioBtn?.setAttribute('aria-current', 'page');
  views.inicio.onShow?.();

  // Android hardware back: close sheet → clear active map route → retrace the tab
  // trail → exit (only from Inicio with an empty trail).
  const cap = (window as any).Capacitor;
  const appPlugin = cap?.Plugins?.App;
  if (cap?.isNativePlatform?.() && appPlugin?.addListener) {
    appPlugin.addListener('backButton', () => {
      if (sheetCount() > 0) {
        closeTopSheet();
        return;
      }
      // On the map, back first clears the drawn route (and stops its live tracking)
      // instead of orphaning it behind the previous tab.
      if (state.tab === 'mapa' && app().dismissMapRoute()) {
        return;
      }
      if (navStack.length > 1) {
        navStack.pop(); // drop the current tab…
        navigate(navStack[navStack.length - 1], false); // …and show the one before it
        return;
      }
      if (state.tab !== 'inicio') {
        navigate('inicio', false);
        return;
      }
      appPlugin.exitApp?.();
    });
  }

  // Load data.
  try {
    await loadCore(boot);
    boot(100, '¡Listo!');
    window.setTimeout(hideBoot, 350);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    boot(100, `Error: ${msg}`);
    document.getElementById('boot')?.classList.add('boot-error');
    console.error('[boot] core load failed', err);
    return;
  }

  // Non-blocking follow-ups.
  void fetchHealth();
  void loadBackground();
}

main().catch((err) => console.error('[main] fatal', err));
