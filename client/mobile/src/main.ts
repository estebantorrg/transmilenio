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
import { initNetworkBanner } from './ui/netBanner';
import { ICONS } from './ui/components';
import { createInicioView } from './views/inicio';
import { createRutasView } from './views/rutas';
import { createPlannerView, type PlannerView } from './views/planner';
import { createMapaView, type MapaView } from './views/mapa';
import { createCercaView } from './views/cerca';
import { createSaldoView } from './views/saldo';
import { closeVoice, isVoiceOpen, openVoice } from './views/voz';
import { mountGuidanceBanner } from './ui/guidanceBanner';
import { resumeGuidance } from './services/guidance';
import { consumeVoiceLaunch, onVoiceLaunch } from './voice/bridge';
import type { View } from './views/types';
import type { RouteListItem } from '@shared/types/transmilenio';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'inicio', label: 'Inicio', icon: ICONS.home },
  // "Buscar", not "Rutas": the tab now looks up the whole network by name —
  // routes AND estaciones, paraderos, recargas, bici, cable (spec §5.4.2b).
  { id: 'rutas', label: 'Buscar', icon: ICONS.search },
  // Planning a trip is the app's headline job and it was a bottom sheet: it
  // covered everything, and reaching the map (to pick a point, or to see the
  // itinerary drawn) destroyed it along with everything typed into it.
  { id: 'planner', label: 'Planear', icon: ICONS.plan },
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

/** Boot failed (no cache, catalog unreachable). Offer the one recovery that
 *  exists — try again — instead of leaving a frozen splash the user can only
 *  escape by force-quitting. */
function showBootError(message: string, retry: () => void): void {
  boot(100, `Error: ${message}`);
  const splash = document.getElementById('boot');
  splash?.classList.add('boot-error');
  const btn = document.getElementById('boot-retry');
  if (!btn) return;
  btn.classList.remove('hidden');
  btn.addEventListener(
    'click',
    () => {
      btn.classList.add('hidden');
      splash?.classList.remove('boot-error');
      boot(10, 'Reintentando…');
      retry();
    },
    { once: true }
  );
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
  const planner: PlannerView = createPlannerView();
  const mapa = createMapaView() as MapaView;
  const cerca = createCercaView();
  const saldo = createSaldoView();

  const views: Record<TabId, View> = { inicio, rutas, planner, mapa, cerca, saldo };

  const screens = document.getElementById('screens')!;
  for (const [id, view] of Object.entries(views) as [TabId, View][]) {
    view.el.classList.add('screen-hidden');
    // Each screen is the panel of its tab: named by the tab button, reachable
    // by a screen reader's landmark/panel navigation, focusable so activating a
    // tab can move the reading cursor into the content it just revealed.
    view.el.id = `screen-${id}`;
    view.el.setAttribute('role', 'tabpanel');
    view.el.setAttribute('aria-labelledby', `tab-${id}`);
    view.el.tabIndex = -1;
    screens.append(view.el);
  }

  // Tab bar. A real ARIA tablist (roles + aria-selected + roving tabindex +
  // arrow keys) — it used to be five unlabelled buttons in a <nav>, so nothing
  // announced which section was current or how many there were.
  const tabbar = document.getElementById('tabbar')!;
  const tabButtons = new Map<TabId, HTMLElement>();
  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.type = 'button';
    btn.id = `tab-${tab.id}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', `screen-${tab.id}`);
    btn.setAttribute('aria-selected', 'false');
    btn.tabIndex = -1;
    btn.innerHTML = `<span class="tab-icon" aria-hidden="true">${tab.icon}</span><span class="tab-label">${tab.label}</span>`;
    btn.addEventListener('click', () => navigate(tab.id));
    tabButtons.set(tab.id, btn);
    tabbar.append(btn);
  }

  // ← / → move between tabs, Home/End jump to the ends (WAI-ARIA tabs pattern).
  tabbar.addEventListener('keydown', (e: KeyboardEvent) => {
    const order = TABS.map((t) => t.id);
    const current = order.indexOf(state.tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (current + 1) % order.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + order.length) % order.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    if (next < 0) return;
    e.preventDefault();
    navigate(order[next]);
    tabButtons.get(order[next])?.focus();
  });

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
      prevBtn?.setAttribute('aria-selected', 'false');
      if (prevBtn) prevBtn.tabIndex = -1;

      state.tab = next;
      const view = views[next];
      view.el.classList.remove('screen-hidden');
      const nextBtn = tabButtons.get(next);
      nextBtn?.classList.add('active');
      nextBtn?.setAttribute('aria-current', 'page');
      nextBtn?.setAttribute('aria-selected', 'true');
      if (nextBtn) nextBtn.tabIndex = 0;
      view.onShow?.();
      bus.emit('tab', next);
    } else {
      // Re-tapping the tab you are already on scrolls that screen back to the
      // top — the standard phone gesture for "take me back up". (The old code
      // scrolled `#screens`, which is `overflow:hidden`; each `.screen` is the
      // scroller, so it did nothing at all.)
      views[next].el.scrollTo({ top: 0, behavior: 'smooth' });
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
    openPlanner: (seed) => {
      navigate('planner');
      if (seed) planner.seedEndpoint(seed.role, { coord: seed.coord, code: seed.code, name: seed.name });
    },
    planTrip: (trip) => {
      navigate('planner');
      if (trip.origin) planner.seedEndpoint('origin', { coord: trip.origin.coord, name: trip.origin.name });
      // Destination last: `seedEndpoint` clears the previous answer, so seeding in
      // this order leaves the form complete before the search runs.
      planner.seedEndpoint('destination', {
        coord: trip.destination.coord,
        code: trip.destination.code,
        name: trip.destination.name,
      });
      // Only search when both ends are known — with no fix the planner shows the
      // seeded destination and its own "elige el origen" affordances instead.
      if (trip.origin) planner.search();
    },
    openLine: (letter: string) => {
      navigate('rutas');
      rutas.setLine(letter);
    },
    openZone: (zone: number) => {
      navigate('rutas');
      rutas.setZone(zone);
    },
    dismissMapRoute: () => mapa.dismissRoute(),
    pickPointOnMap: (prompt: string) => {
      navigate('mapa');
      return mapa.pickPoint(prompt);
    },
    cancelPointPick: () => mapa.cancelPick(),
    showJourneyOnMap: (plan, summary) => {
      navigate('mapa');
      mapa.showJourney(plan, summary);
    },
    dismissMapJourney: () => mapa.dismissJourney(),
  });

  // Start on Inicio.
  views.inicio.el.classList.remove('screen-hidden');
  const inicioBtn = tabButtons.get('inicio');
  inicioBtn?.classList.add('active');
  inicioBtn?.setAttribute('aria-current', 'page');
  inicioBtn?.setAttribute('aria-selected', 'true');
  if (inicioBtn) inicioBtn.tabIndex = 0;
  views.inicio.onShow?.();

  // One connectivity banner for the whole app (spec §4.2 graceful degradation).
  initNetworkBanner();

  // In-journey guidance draws over every tab and survives them all, so its
  // banner is mounted once here rather than owned by the planner (spec §5.10).
  mountGuidanceBanner();

  // ── Voice (spec §5.9) ──────────────────────────────────
  // The mic is a floating control rather than a seventh tab: it is not a place
  // in the app, it is a shortcut past all of them.
  const micButton = document.createElement('button');
  micButton.className = 'voz-fab';
  micButton.type = 'button';
  micButton.setAttribute('aria-label', 'Preguntar por una ruta con la voz');
  micButton.innerHTML = `<span aria-hidden="true">${ICONS.mic}</span>`;
  micButton.addEventListener('click', () => openVoice());
  document.getElementById('app')?.append(micButton);

  // A voice launch must not wait for the catalog: the whole feature is answering
  // in ~1.5 s, and `loadCore` parses 13.6 MB. The overlay runs off the 367 KB
  // voice index in parallel with boot and closes over its own data.
  void consumeVoiceLaunch().then((launch) => {
    if (launch.voice) openVoice(launch.code);
  });
  // Deep link while the app is already open (singleTask relaunch).
  onVoiceLaunch((code) => openVoice(code));

  // Android hardware back: close sheet → clear active map route → retrace the tab
  // trail → exit (only from Inicio with an empty trail).
  const cap = (window as any).Capacitor;
  const appPlugin = cap?.Plugins?.App;
  if (cap?.isNativePlatform?.() && appPlugin?.addListener) {
    appPlugin.addListener('backButton', () => {
      // The voice overlay owns the microphone and the speaker; back must stop
      // both, not leave them running behind another screen.
      if (isVoiceOpen()) {
        closeVoice();
        return;
      }
      // A pending map pick is the most modal thing on screen — back cancels it
      // rather than navigating away and leaving the caller waiting forever.
      if (app().cancelPointPick()) return;
      if (sheetCount() > 0) {
        closeTopSheet();
        return;
      }
      // On the map, back first clears whatever is drawn — the itinerary, or the
      // route (stopping its live tracking) — instead of orphaning it behind the
      // previous tab.
      if (state.tab === 'mapa' && (app().dismissMapJourney() || app().dismissMapRoute())) {
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

  // Load data. A failure here is recoverable by retrying (cold backend, no
  // network on first launch) — so offer that rather than stranding the splash.
  const startData = async (): Promise<void> => {
    try {
      await loadCore(boot);
      boot(100, '¡Listo!');
      window.setTimeout(hideBoot, 350);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[boot] core load failed', err);
      showBootError(msg, () => void startData());
      return;
    }

    // Non-blocking follow-ups.
    void fetchHealth();
    void loadBackground();

    // A rider whose phone was killed mid-trip reopens the app still on the bus.
    // Resumed here rather than at boot because the vagón lookup reads the
    // catalog's station records (spec §5.5.6), which `loadCore` has just filled.
    resumeGuidance();

    // Build the map while the phone is idle. It is created lazily (MapLibre needs
    // an attached, sized container), so the first tap on "Mapa" used to pay a
    // style download + first paint the rider watched happen. Warming it after the
    // core data has landed keeps boot fast AND the tab instant.
    const warm = () => mapa.prewarm();
    const idle = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined;
    if (idle) idle(warm, { timeout: 3000 });
    else window.setTimeout(warm, 1200);
  };
  await startData();
}

main().catch((err) => console.error('[main] fatal', err));
