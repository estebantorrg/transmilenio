/**
 * Sidebar UI controller.
 * Manages route list, search, filters, and detail panel.
 */

import type { RouteListItem } from '../types/transmilenio';
import { escapeHTML, safeColor } from '../utils/html';
import { getRouteAccentColor, isAlimentadorRoute, isRutaFacilCode } from '../utils/routeColors';
import { api, type CardBalanceRead, type CardBalanceMovement, type LiveStatus } from '../services/api';
import { getZonalAreas, getZoneLabel } from '../data/zones';

/** Status the live-tracking card can show: the in-flight `loading` plus the
 *  honest API outcomes. Mirrors `TrackingStatus` in `layers/buses.ts`. */
type TrackingStatus = 'loading' | LiveStatus;

// Manual-refresh handler, registered by main.ts (forwards to refreshLiveBusesNow).
let liveRefreshHandler: (() => void) | null = null;
export function setLiveRefreshHandler(fn: (() => void) | null): void {
  liveRefreshHandler = fn;
}

// Freshness ticker: re-renders the "actualizado hace Xs" sub-line between polls.
let liveFreshAt = 0;
let liveFreshTimer: number | null = null;

function stopFreshTicker(): void {
  if (liveFreshTimer !== null) {
    window.clearInterval(liveFreshTimer);
    liveFreshTimer = null;
  }
}

function formatAgo(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 5) return 'ahora';
  if (secs < 60) return `hace ${secs} s`;
  const mins = Math.round(secs / 60);
  return mins < 60 ? `hace ${mins} min` : `hace ${Math.round(mins / 60)} h`;
}

/** Short uppercase family label shown under the route name (TRONCAL / ZONAL / …). */
function routeTypeLabel(route: RouteListItem): string {
  if (route.subType === 'dual') return 'PADRÓN';
  if (isAlimentadorRoute(route) || route.subType === 'alimentador') return 'ALIMENTADOR';
  return route.type === 'troncal' ? 'TRONCAL' : 'ZONAL';
}

let allRoutes: RouteListItem[] = [];
let selectedRouteId: string | null = null;
let onRouteSelect: ((route: RouteListItem) => void) | null = null;
let onRouteDeselect: (() => void) | null = null;
let onLayerToggle: ((layer: string, visible: boolean) => void) | null = null;
let onStopSelect: ((stop: any, routeType: 'troncal' | 'zonal') => void) | null = null;

type RouteFilter = 'all' | 'fav' | 'recent' | 'troncal' | 'zonal' | 'alimentador' | 'facil';
let currentFilter: RouteFilter = 'all';
// SITP zone narrowing, active only under the Zonal filter (null = all zones).
let currentZone: number | null = null;
let searchQuery = '';

const FAV_KEY = 'tm:favorites';
const RECENT_KEY = 'tm:recents';
const RECENT_LIMIT = 12;

const favorites = new Set<string>(readStored(FAV_KEY));
let recents: string[] = readStored(RECENT_KEY);

function readStored(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — favorites degrade to session-only */
  }
}

function toggleFavorite(id: string): void {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  persist(FAV_KEY, [...favorites]);
}

function pushRecent(id: string): void {
  recents = [id, ...recents.filter((r) => r !== id)].slice(0, RECENT_LIMIT);
  persist(RECENT_KEY, recents);
}

// ─── Deep linking (#/r/<code>[/<dest>]) ───────────────────
// The selected route is mirrored into the URL hash so links are shareable and
// the browser/phone Back button closes the detail panel instead of leaving the
// app. `suppressHashChange` guards the programmatic write so our own update does
// not re-enter the hashchange handler.
//
// Rutas duales/fáciles (Z8, F417, F409…) carry the *same código for both
// directions* — distinct only by destination. A bare `#/r/<code>` would be
// ambiguous, so when siblings share a code we append a destination slug
// (`#/r/Z8/portal-el-dorado`) to pin the exact direction.
let suppressHashChange = false;
let deepLinkApplied = false;

function slugifyRoute(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function routesWithCode(code: string): RouteListItem[] {
  const normalized = code.toUpperCase();
  return allRoutes.filter((r) => r.code.toUpperCase() === normalized);
}

/** Build the hash for a route, disambiguating by destination when needed. */
function routeHashFor(route: RouteListItem): string {
  const code = encodeURIComponent(route.code);
  if (routesWithCode(route.code).length > 1) {
    return `#/r/${code}/${encodeURIComponent(slugifyRoute(route.destination))}`;
  }
  return `#/r/${code}`;
}

function parseRouteHash(): { code: string; slug?: string } | null {
  const match = location.hash.match(/^#\/r\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  return {
    code: decodeURIComponent(match[1]).trim(),
    slug: match[2] ? decodeURIComponent(match[2]).trim() : undefined,
  };
}

/** Resolve a hash back to a specific route, picking the right direction. */
function resolveRouteFromHash(code: string, slug?: string): RouteListItem | undefined {
  const matches = routesWithCode(code);
  if (matches.length <= 1) return matches[0];
  if (slug) {
    const exact = matches.find((r) => slugifyRoute(r.destination) === slug);
    if (exact) return exact;
  }
  return matches[0];
}

function pushRouteHash(route: RouteListItem): void {
  const want = routeHashFor(route);
  if (location.hash === want) return;
  suppressHashChange = true;
  location.hash = want;
}

function clearRouteHash(): void {
  if (!location.hash) return;
  // replaceState avoids leaving a dangling history entry and fires no event.
  history.replaceState(null, '', location.pathname + location.search);
}

/** Sync selection to the current hash — used on load and on Back/Forward. */
function applyRouteHash(): void {
  const parsed = parseRouteHash();
  if (parsed) {
    const target = resolveRouteFromHash(parsed.code, parsed.slug);
    if (target && target.id !== selectedRouteId) {
      selectRoute(target);
    }
  } else if (selectedRouteId) {
    closeRouteDetail();
    onRouteDeselect?.();
  }
}

function onHashChange(): void {
  if (suppressHashChange) {
    suppressHashChange = false;
    return;
  }
  applyRouteHash();
}

/** User-initiated close (Volver / Esc): also drops the deep-link from the URL. */
function closeRouteDetailFromUser(): void {
  closeRouteDetail();
  onRouteDeselect?.();
  clearRouteHash();
}

// ─── Toast ────────────────────────────────────────────────
let toastTimer: number | null = null;
function showToast(message: string): void {
  let toast = document.getElementById('tm-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tm-toast';
    toast.className = 'tm-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.classList.remove('visible'), 2400);
}

/** Copy text to the clipboard. Uses the async Clipboard API in secure contexts
 *  and falls back to a hidden textarea + execCommand for everything else
 *  (older/desktop browsers, non-HTTPS). Returns whether the copy succeeded. */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to legacy path */
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** Copy a deep link to the given route to the clipboard. */
async function shareRoute(route: RouteListItem): Promise<void> {
  const url = `${location.origin}${location.pathname}${routeHashFor(route)}`;
  showToast((await copyText(url)) ? 'Enlace copiado al portapapeles' : 'No se pudo copiar el enlace');
}

/** Apply a route filter and reflect it across both control surfaces. */
function setRouteFilter(filter: RouteFilter): void {
  currentFilter = filter;
  // The SITP zone browse only makes sense under the Zonal filter; leaving it
  // clears any active zone so the other filters aren't silently narrowed.
  if (filter !== 'zonal') currentZone = null;
  syncFilterButtons();
  syncZoneChips();
  applyFilters();
}

// ─── SITP zone browse (spec §5.4.2a) ──────────────────────
// Zonal routes carry a home SITP zone (1–13). When the Zonal filter is active we
// reveal a chip row so users can narrow the list to a single zone.
let availableZones: number[] = [];

export function setAvailableZones(zones: number[]): void {
  availableZones = zones;
  renderZoneChips();
  syncZoneChips();
}

function renderZoneChips(): void {
  const row = document.getElementById('zone-chips');
  if (!row) return;
  if (availableZones.length === 0) {
    row.innerHTML = '';
    return;
  }
  const chip = (zone: number | null): string => {
    const active = currentZone === zone;
    const label = zone === null ? 'Todas' : getZoneLabel(zone) || `Zona ${zone}`;
    const title = zone === null ? 'Todas las zonas' : `Zona ${zone}${getZoneLabel(zone) ? ` · ${getZoneLabel(zone)}` : ''}`;
    return `<button class="zone-chip${active ? ' active' : ''}" type="button" role="tab"
      aria-selected="${active}" data-zone="${zone === null ? '' : zone}" title="${escapeHTML(title)}">${escapeHTML(label)}</button>`;
  };
  row.innerHTML = [chip(null), ...availableZones.map((z) => chip(z))].join('');
  row.querySelectorAll<HTMLButtonElement>('.zone-chip').forEach((el) => {
    el.addEventListener('click', () => {
      const raw = el.dataset.zone;
      currentZone = raw ? Number(raw) : null;
      renderZoneChips();
      applyFilters();
    });
  });
}

/** Show the zone row only under the Zonal filter, and only if zones are known. */
function syncZoneChips(): void {
  const row = document.getElementById('zone-chips');
  if (!row) return;
  const show = currentFilter === 'zonal' && availableZones.length > 0;
  row.classList.toggle('hidden', !show);
}

function syncFilterButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.filter-chip').forEach((chip) => {
    const active = (chip.dataset.filter || 'all') === currentFilter;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll<HTMLButtonElement>('.route-view-toggle').forEach((toggle) => {
    const active = toggle.dataset.filter === currentFilter;
    toggle.classList.toggle('active', active);
    toggle.setAttribute('aria-pressed', String(active));
  });
}

/** Reflect collapsed state on aria attributes + body flags shared by both the
 *  desktop drawer and the mobile sheet (map padding, FAB, controls read these). */
function updateCollapseChrome(sidebar: HTMLElement, collapsed: boolean): void {
  const toggleBtn = document.getElementById('sidebar-toggle') as HTMLButtonElement | null;
  const floatingBtn = document.getElementById('sidebar-fab') as HTMLButtonElement | null;

  sidebar.classList.toggle('collapsed', collapsed);
  sidebar.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
  document.body.classList.toggle('sidebar-collapsed', collapsed);

  const expanded = String(!collapsed);
  toggleBtn?.setAttribute('aria-expanded', expanded);
  floatingBtn?.setAttribute('aria-expanded', expanded);
  toggleBtn?.setAttribute('aria-label', collapsed ? 'Mostrar panel' : 'Ocultar panel');
  toggleBtn?.setAttribute('title', collapsed ? 'Mostrar panel' : 'Ocultar panel');
  floatingBtn?.setAttribute('aria-label', collapsed ? 'Mostrar panel' : 'Panel abierto');
  floatingBtn?.setAttribute('title', collapsed ? 'Mostrar panel' : 'Panel abierto');
}

// ─── Mobile bottom-sheet detents ──────────────────────────
// The mobile sheet is a fixed-height panel revealed by a CSS `translateY`.
// Three resting positions ("detents") give it a real app feel instead of a
// binary open/closed toggle. `peek` == collapsed for the shared body flags.
type SheetDetent = 'peek' | 'half' | 'full';
const DETENT_ORDER: SheetDetent[] = ['peek', 'half', 'full'];
let currentDetent: SheetDetent = 'peek';

function getSheetDetent(): SheetDetent {
  return currentDetent;
}

/** Snap the mobile sheet to a detent (clearing any in-drag inline transform). */
function setSheetDetent(detent: SheetDetent): void {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  currentDetent = detent;
  sidebar.style.transform = '';
  sidebar.classList.remove('sheet-peek', 'sheet-half', 'sheet-full');
  sidebar.classList.add(`sheet-${detent}`);
  updateCollapseChrome(sidebar, detent === 'peek');
}

/** Step the sheet down one detent (full→half→peek). Used by hardware back. */
function stepSheetDown(): void {
  const idx = DETENT_ORDER.indexOf(currentDetent);
  if (idx > 0) setSheetDetent(DETENT_ORDER[idx - 1]);
}

function setSidebarCollapsed(collapsed: boolean): void {
  if (isMobileSheet()) {
    // On mobile, "expand" restores the last non-peek detent (default half) so
    // reopening feels intentional rather than always slamming to full screen.
    setSheetDetent(collapsed ? 'peek' : currentDetent === 'peek' ? 'half' : currentDetent);
    return;
  }
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  updateCollapseChrome(sidebar, collapsed);
}

function isMobileSheet(): boolean {
  return window.matchMedia('(max-width: 768px)').matches;
}

/** Expand the sidebar/sheet — used when a popup action jumps into the planner. */
export function openSidebar(): void {
  if (isMobileSheet()) {
    // Half reveals the planner inputs without swallowing the whole map.
    setSheetDetent(currentDetent === 'peek' ? 'half' : currentDetent);
    return;
  }
  setSidebarCollapsed(false);
}

/**
 * Hardware-back close chain for the Android shell (spec §5.2.1b native target).
 * Returns true when it consumed the event; false lets the OS default (exit) run.
 * Order mirrors visual nesting: modal card → route detail → planner → sheet detent.
 */
export function handleMobileBack(): boolean {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return false;

  if (sidebar.classList.contains('card-open')) {
    closeCardBalancePanel();
    return true;
  }
  if (selectedRouteId && sidebar.classList.contains('detail-open')) {
    closeRouteDetailFromUser();
    return true;
  }
  const plannerPanel = document.getElementById('planner-panel');
  const cercaPanel = document.getElementById('cerca-panel');
  const onSecondaryTab =
    (plannerPanel && !plannerPanel.classList.contains('hidden')) ||
    (cercaPanel && !cercaPanel.classList.contains('hidden'));
  if (onSecondaryTab) {
    document.getElementById('tab-explore')?.click();
    return true;
  }
  if (isMobileSheet() && currentDetent !== 'peek') {
    stepSheetDown();
    return true;
  }
  return false;
}

/** Read the sheet's current on-screen translateY in px (0 when untransformed). */
function currentSheetTranslate(sidebar: HTMLElement): number {
  const value = getComputedStyle(sidebar).transform;
  if (!value || value === 'none') return 0;
  return new DOMMatrixReadOnly(value).m42;
}

/** Resting translateY (px) for each detent, derived from live layout so the
 *  drag math and the CSS classes never drift (peek height comes from --peek-h). */
function detentPositions(sidebar: HTMLElement): Record<SheetDetent, number> {
  const sheetH = sidebar.offsetHeight;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const peekH = parseFloat(getComputedStyle(sidebar).getPropertyValue('--peek-h')) || 108;
  return {
    full: 0,
    half: Math.max(0, sheetH - vh * 0.5),
    peek: Math.max(0, sheetH - peekH),
  };
}

/** Pick the detent to settle on from release position + fling velocity. */
function resolveDetent(pos: number, velocity: number, rest: Record<SheetDetent, number>): SheetDetent {
  const FLING = 0.55; // px/ms — above this the gesture is a flick, not a drag
  if (Math.abs(velocity) > FLING) {
    const idx = DETENT_ORDER.indexOf(currentDetent);
    // velocity > 0 → moving down (toward peek); < 0 → up (toward full)
    const next = velocity > 0 ? idx - 1 : idx + 1;
    return DETENT_ORDER[Math.max(0, Math.min(DETENT_ORDER.length - 1, next))];
  }
  // Otherwise snap to the nearest resting position.
  return (Object.keys(rest) as SheetDetent[]).reduce((best, d) =>
    Math.abs(rest[d] - pos) < Math.abs(rest[best] - pos) ? d : best
  , 'peek');
}

/**
 * Mobile bottom-sheet gesture: the sheet tracks the finger 1:1 and settles on
 * the nearest detent (or the flicked one) on release. A tap on the handle with
 * no movement toggles peek↔half. Drag works from the handle and the header.
 */
function initSheetDrag(): void {
  const handle = document.getElementById('sheet-handle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;
  const header = document.querySelector('.sidebar-header') as HTMLElement | null;

  let startY = 0;
  let startTranslate = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let rest: Record<SheetDetent, number> = { peek: 0, half: 0, full: 0 };
  let dragging = false;
  let moved = false;

  const onDown = (e: PointerEvent) => {
    if (!isMobileSheet() || e.button != null && e.button > 0) return;
    dragging = true;
    moved = false;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    startTranslate = currentSheetTranslate(sidebar);
    rest = detentPositions(sidebar);
    sidebar.classList.add('sheet-dragging');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 5) moved = true;
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
    // Follow the finger, allowing a little rubber-band past the full/peek ends.
    const min = -28;
    const max = rest.peek + 28;
    const next = Math.max(min, Math.min(max, startTranslate + dy));
    sidebar.style.transform = `translateY(${next}px)`;
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    sidebar.classList.remove('sheet-dragging');
    if (!moved) {
      setSheetDetent(currentDetent === 'peek' ? 'half' : 'peek');
      return;
    }
    const pos = currentSheetTranslate(sidebar);
    setSheetDetent(resolveDetent(pos, velocity, rest));
  };

  for (const el of [handle, header]) {
    if (!el) continue;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }
}

/**
 * Keyboard-aware sheet: when an input inside the sheet gains focus, promote the
 * sheet to full so the field isn't buried; track `visualViewport` so the footer
 * and inputs float above the soft keyboard via the `--kb-inset` CSS var.
 */
function initKeyboardAwareSheet(): void {
  const sidebar = document.getElementById('sidebar');
  const vv = window.visualViewport;
  if (!sidebar) return;

  sidebar.addEventListener('focusin', (e) => {
    if (!isMobileSheet()) return;
    if ((e.target as HTMLElement)?.matches('input, textarea')) {
      if (currentDetent !== 'full') setSheetDetent('full');
    }
  });

  if (!vv) return;
  const applyInset = () => {
    // How much of the layout viewport the keyboard currently occludes.
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
  };
  vv.addEventListener('resize', applyInset);
  vv.addEventListener('scroll', applyInset);
}

/** Esc closes the open panel / collapses; "/" jumps to search. */
function initKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    if (e.key === 'Escape') {
      const sidebar = document.getElementById('sidebar');
      if (sidebar?.classList.contains('card-open')) { closeCardBalancePanel(); return; }
      if (selectedRouteId) { closeRouteDetailFromUser(); return; }
      if (typing) (target as HTMLInputElement).blur();
      return;
    }

    if (typing) return;
    if (e.key === '/') {
      e.preventDefault();
      const sidebar = document.getElementById('sidebar');
      if (sidebar?.classList.contains('collapsed')) setSidebarCollapsed(false);
      (document.getElementById('search-input') as HTMLInputElement | null)?.focus();
    }
  });
}

export function initSidebar(options: {
  onRouteSelect: (route: RouteListItem) => void;
  onRouteDeselect: () => void;
  onLayerToggle: (layer: string, visible: boolean) => void;
  onStopSelect?: (stop: any, routeType: 'troncal' | 'zonal') => void;
}): void {
  onRouteSelect = options.onRouteSelect;
  onRouteDeselect = options.onRouteDeselect;
  onLayerToggle = options.onLayerToggle;
  onStopSelect = options.onStopSelect || null;

  const toggleBtn = document.getElementById('sidebar-toggle')!;
  const sidebar = document.getElementById('sidebar')!;
  const floatingBtn = document.getElementById('sidebar-fab');
  // On phones the sheet starts as a peek bar so the map is visible first.
  setSidebarCollapsed(isMobileSheet() || sidebar.classList.contains('collapsed'));

  toggleBtn.addEventListener('click', () => {
    setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
  });
  floatingBtn?.addEventListener('click', () => setSidebarCollapsed(false));

  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const searchClear = document.getElementById('search-clear')!;

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim();
    searchClear.classList.toggle('hidden', !searchQuery);
    applyFilters();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClear.classList.add('hidden');
    applyFilters();
    searchInput.focus();
  });

  // Route filters live on two surfaces: the type segments (Todas/Troncal/Zonal/
  // Alim.) and the saved-view toggles (favoritas/recientes) on the list header.
  // Both drive the single `currentFilter`; picking one surface clears the other.
  document.querySelectorAll<HTMLButtonElement>('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      setRouteFilter((chip.dataset.filter as RouteFilter) || 'all');
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.route-view-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const view = (toggle.dataset.filter as RouteFilter) || 'all';
      // Tapping the active view again clears it and returns to the full list.
      setRouteFilter(currentFilter === view ? 'all' : view);
    });
  });

  // Collapsible "Capas" section
  const layersTitle = document.getElementById('layer-toggles-title');
  const layersWrap = document.getElementById('layer-toggles');
  layersTitle?.addEventListener('click', () => {
    const collapsed = layersWrap?.classList.toggle('collapsed') ?? false;
    layersTitle.setAttribute('aria-expanded', String(!collapsed));
  });

  initSheetDrag();
  initKeyboardAwareSheet();
  initKeyboardShortcuts();

  document.querySelectorAll('.toggle-item').forEach((item) => {
    const cb = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (cb) {
      cb.addEventListener('change', () => {
        const layer = cb.dataset.layer!;
        onLayerToggle?.(layer, cb.checked);
      });
    }
  });

  const detailClose = document.getElementById('route-detail-close')!;
  detailClose.addEventListener('click', closeRouteDetailFromUser);

  // Back/Forward navigation drives selection through the URL hash.
  window.addEventListener('hashchange', onHashChange);

  initCardBalancePanel();
}

let cardRequestSeq = 0;
let cardPanelReturnToDetail = false;

function initCardBalancePanel(): void {
  const openBtn = document.getElementById('card-balance-open') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('card-detail-close') as HTMLButtonElement | null;
  const form = document.getElementById('card-balance-form') as HTMLFormElement | null;
  const input = document.getElementById('card-number-input') as HTMLInputElement | null;
  const clearBtn = document.getElementById('card-number-clear') as HTMLButtonElement | null;

  openBtn?.addEventListener('click', openCardBalancePanel);
  closeBtn?.addEventListener('click', closeCardBalancePanel);
  clearBtn?.addEventListener('click', () => {
    if (!input) return;
    input.value = '';
    input.focus();
    renderCardBalanceEmpty();
  });

  input?.addEventListener('input', () => {
    input.value = groupCardDigits(input.value.replace(/\D/g, '').slice(0, 20));
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input) return;

    const numeroTarjeta = input.value.replace(/\D/g, '');
    if (!/^\d{8,20}$/.test(numeroTarjeta)) {
      renderCardBalanceError('Ingresa un numero de tarjeta valido.');
      return;
    }

    const requestId = ++cardRequestSeq;
    setCardBalanceLoading(true);
    renderCardBalanceLoading();
    try {
      const response = await api.readCardBalance(numeroTarjeta, 'false');
      if (requestId !== cardRequestSeq) return;
      if (!response.success || !response.data) {
        renderCardBalanceError(response.error || 'No se pudo leer el saldo.');
        return;
      }
      renderCardBalanceResult(response.data);
    } catch (error) {
      if (requestId !== cardRequestSeq) return;
      renderCardBalanceError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === cardRequestSeq) setCardBalanceLoading(false);
    }
  });
}

function openCardBalancePanel(): void {
  const sidebar = document.getElementById('sidebar')!;
  const routePanel = document.getElementById('route-detail')!;
  const cardPanel = document.getElementById('card-detail')!;
  cardPanelReturnToDetail = sidebar.classList.contains('detail-open') && !routePanel.classList.contains('hidden');

  sidebar.classList.remove('detail-open');
  sidebar.classList.add('card-open');
  routePanel.classList.add('hidden');
  cardPanel.classList.remove('hidden');

  const input = document.getElementById('card-number-input') as HTMLInputElement | null;
  window.setTimeout(() => input?.focus(), 0);
}

function closeCardBalancePanel(): void {
  const sidebar = document.getElementById('sidebar')!;
  const routePanel = document.getElementById('route-detail')!;
  const cardPanel = document.getElementById('card-detail')!;

  cardPanel.classList.add('hidden');
  sidebar.classList.remove('card-open');

  if (cardPanelReturnToDetail && selectedRouteId) {
    routePanel.classList.remove('hidden');
    sidebar.classList.add('detail-open');
  }
  cardPanelReturnToDetail = false;
}

function setCardBalanceLoading(loading: boolean): void {
  const submit = document.getElementById('card-balance-submit') as HTMLButtonElement | null;
  const openBtn = document.getElementById('card-balance-open') as HTMLButtonElement | null;
  submit?.classList.toggle('loading', loading);
  if (submit) submit.disabled = loading;
  openBtn?.classList.toggle('loading', loading);
}

function renderCardBalanceEmpty(): void {
  const result = document.getElementById('card-balance-result');
  if (!result) return;
  result.innerHTML = `
    <div class="card-empty-state">
      <div class="card-empty-title">Sin consulta</div>
      <div class="card-empty-text">La respuesta del servidor se muestra separada de la lectura NFC local.</div>
    </div>
  `;
}

function renderCardBalanceLoading(): void {
  const result = document.getElementById('card-balance-result');
  if (!result) return;
  result.innerHTML = `
    <div class="card-loading-state">
      <span class="footer-action-spinner visible" aria-hidden="true"></span>
      <span>Consultando servidor oficial...</span>
    </div>
  `;
}

function renderCardBalanceError(message: string): void {
  const result = document.getElementById('card-balance-result');
  if (!result) return;
  result.innerHTML = `
    <div class="card-error-state">
      <div class="card-empty-title">No se pudo consultar</div>
      <div class="card-empty-text">${escapeHTML(message)}</div>
    </div>
  `;
}

function groupCardDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

function formatCOP(value: string | number | undefined): string {
  if (value == null || value === '') return 'Sin dato';
  const amount = Number(String(value).replace(/[^\d-]/g, ''));
  if (!Number.isFinite(amount)) return String(value);
  return `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(amount)}`;
}

function formatCardDate(value: string | undefined): string {
  if (!value) return 'Sin fecha';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})(?: UTC)?$/);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]} ${match[4]}`;
}

function cardSourceLabel(source: CardBalanceMovement['source'] | CardBalanceRead['balanceSource']): string {
  return source === 'card' ? 'Tarjeta NFC' : 'Servidor app oficial';
}

function renderCardMovement(movement: CardBalanceMovement): string {
  return `
    <div class="card-movement ${movement.source}">
      <div class="card-movement-main">
        <span>${escapeHTML(formatCardDate(movement.occurredAt))}</span>
        <span>${escapeHTML(movement.type || 'Movimiento')}</span>
      </div>
      <div class="card-movement-line">Monto: ${movement.amount ? escapeHTML(formatCOP(movement.amount)) : 'no enviado por servidor'}</div>
      <div class="card-movement-line">Saldo final: ${escapeHTML(formatCOP(movement.finalBalance))}</div>
      <div class="card-movement-source">${escapeHTML(cardSourceLabel(movement.source))}</div>
    </div>
  `;
}

function renderCardBalanceResult(data: CardBalanceRead): void {
  const result = document.getElementById('card-balance-result');
  if (!result) return;

  const movements = data.movements.length
    ? data.movements.map(renderCardMovement).join('')
    : '<div class="card-empty-state compact">Sin movimientos en respuesta.</div>';

  result.innerHTML = `
    <div class="card-balance-summary">
      <div class="card-balance-label">Saldo reportado</div>
      <div class="card-balance-amount">${escapeHTML(formatCOP(data.balance))}</div>
      <div class="card-balance-meta">
        ${escapeHTML(cardSourceLabel(data.balanceSource))} · ${escapeHTML(formatCardDate(data.asOf))}
      </div>
      <button id="card-copy-balance" class="card-copy-balance" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copiar saldo
      </button>
    </div>

    <div class="card-source-warning">
      <span class="card-source-chip">NFC ausente</span>
      <span>Este saldo es el que tiene registrado el servidor. El saldo mas reciente y los ultimos movimientos solo aparecen al acercar la tarjeta al celular.</span>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Tarjeta</div>
      <div class="detail-row"><span class="detail-row-label">Numero</span><span class="detail-row-value">${escapeHTML(groupCardDigits(data.numeroTarjeta))}</span></div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Movimientos (${data.movements.length})</div>
      <div class="card-movement-list">${movements}</div>
    </div>
  `;

  result.querySelector('#card-copy-balance')?.addEventListener('click', async () => {
    showToast((await copyText(formatCOP(data.balance))) ? 'Saldo copiado' : 'No se pudo copiar el saldo');
  });
}

export function setRoutes(routes: RouteListItem[]): void {
  allRoutes = [...routes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'troncal' ? -1 : 1;
    return a.code.localeCompare(b.code, undefined, { numeric: true });
  });

  applyFilters();

  // First time routes are available, restore any shared deep link (#/r/<code>).
  if (!deepLinkApplied) {
    deepLinkApplied = true;
    if (parseRouteHash()) applyRouteHash();
  }
}

function matchesTypeFilter(r: RouteListItem): boolean {
  switch (currentFilter) {
    case 'troncal':
      return r.type === 'troncal' && !isAlimentadorRoute(r) && r.subType !== 'alimentador';
    case 'zonal':
      return r.type === 'zonal';
    case 'alimentador':
      return isAlimentadorRoute(r) || r.subType === 'alimentador';
    case 'facil':
      return isRutaFacilCode(r.code);
    default:
      return true;
  }
}

function applyFilters(): void {
  let base: RouteListItem[];

  if (currentFilter === 'fav') {
    base = allRoutes.filter((r) => favorites.has(r.id));
  } else if (currentFilter === 'recent') {
    // Preserve recency order.
    base = recents
      .map((id) => allRoutes.find((r) => r.id === id))
      .filter((r): r is RouteListItem => !!r);
  } else {
    base = allRoutes.filter(matchesTypeFilter);
    // Narrow to a single SITP zone when browsing zonal routes by zone.
    if (currentFilter === 'zonal' && currentZone !== null) {
      base = base.filter((r) => getZonalAreas(r.code).includes(currentZone!));
    }
  }

  if (searchQuery) {
    const q = normalizeSearchText(searchQuery);
    base = base
      .filter((r) => routeSearchHaystack(r).includes(q))
      .sort((a, b) => searchRank(a, q) - searchRank(b, q));
  }

  renderRouteList(base);
}

// ─── Search matching ──────────────────────────────────────
// Accent-insensitive: catalog names carry tildes ("Fontibón", "Engativá",
// "Américas") that users rarely type, so both sides are NFD-stripped. Haystacks
// are cached per route — code/name/origin/destination never change after load.
function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const searchHaystacks = new WeakMap<RouteListItem, string>();
function routeSearchHaystack(route: RouteListItem): string {
  let hay = searchHaystacks.get(route);
  if (hay === undefined) {
    hay = normalizeSearchText(`${route.code} ${route.name} ${route.origin} ${route.destination}`);
    searchHaystacks.set(route, hay);
  }
  return hay;
}

/** Rank matches so code hits surface first: exact code, code prefix, then text. */
function searchRank(route: RouteListItem, q: string): number {
  const code = normalizeSearchText(route.code);
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  return 2;
}

function renderRouteList(routes: RouteListItem[]): void {
  const container = document.getElementById('route-list')!;
  const countEl = document.getElementById('route-list-count')!;

  countEl.textContent = `${routes.length}`;

  if (routes.length === 0) {
    const empty =
      currentFilter === 'fav'
        ? { title: 'Sin favoritas', text: 'Toca la estrella ★ en una ruta para guardarla aquí.' }
        : currentFilter === 'recent'
        ? { title: 'Sin recientes', text: 'Las rutas que abras aparecerán aquí.' }
        : { title: 'Sin rutas', text: 'Prueba con otro código, estación o destino.' };
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">${empty.title}</div>
        <div class="empty-state-text">${empty.text}</div>
      </div>
    `;
    return;
  }

  const visible = routes.slice(0, 200);

  container.innerHTML = visible
    .map((route) => {
      const badgeColor = safeColor(getRouteAccentColor(route));
      const badgeBorder = `color-mix(in srgb, ${badgeColor} 45%, #ffffff)`;
      const badgeStyle = `background:${badgeColor};border-color:${badgeBorder};`;
      const endpointText = `${route.origin} -> ${route.destination}`;

      const isFav = favorites.has(route.id);

      const ariaLabel = `${route.code}, ${routeTypeLabel(route)}, ${route.origin} a ${route.destination}`;

      return `
        <div class="route-item ${selectedRouteId === route.id ? 'active' : ''}"
             data-type="${route.type}"
             data-id="${escapeHTML(route.id)}"
             role="button"
             tabindex="0"
             aria-label="${escapeHTML(ariaLabel)}">
          <span class="route-item-badge" style="${badgeStyle}">${escapeHTML(route.code)}</span>
          <div class="route-item-info">
            <div class="route-item-name">${escapeHTML(route.name)}</div>
            <div class="route-item-meta">
              <span class="route-item-type">${escapeHTML(routeTypeLabel(route))}</span>
              <span class="route-item-endpoints">${escapeHTML(endpointText)}</span>
            </div>
          </div>
          <button class="route-item-fav ${isFav ? 'active' : ''}" type="button"
                  data-fav-id="${escapeHTML(route.id)}"
                  aria-pressed="${isFav}"
                  aria-label="${isFav ? 'Quitar de favoritas' : 'Agregar a favoritas'}"
                  title="${isFav ? 'Quitar de favoritas' : 'Agregar a favoritas'}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </button>
        </div>
      `;
    })
    .join('');

  if (routes.length > 200) {
    container.innerHTML += `
      <div class="route-list-overflow">
        Mostrando 200 de ${routes.length} rutas. Usa la busqueda para filtrar.
      </div>
    `;
  }

  const items = Array.from(container.querySelectorAll<HTMLElement>('.route-item'));
  items.forEach((el, index) => {
    const open = () => {
      const route = allRoutes.find((item) => item.id === el.dataset.id);
      if (route) selectRoute(route);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[Math.min(index + 1, items.length - 1)]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[Math.max(index - 1, 0)]?.focus();
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.route-item-fav').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.favId!;
      toggleFavorite(id);
      const isFav = favorites.has(id);
      btn.classList.toggle('active', isFav);
      btn.setAttribute('aria-pressed', String(isFav));
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', isFav ? 'currentColor' : 'none');
      // Re-render only if removal affects the current view.
      if (!isFav && currentFilter === 'fav') applyFilters();
    });
  });
}

// Element focus returns here when the route detail closes (keyboard a11y).
let lastRouteTrigger: HTMLElement | null = null;

function selectRoute(route: RouteListItem): void {
  if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.route-item')) {
    lastRouteTrigger = document.activeElement;
  }
  selectedRouteId = route.id;
  pushRecent(route.id);
  pushRouteHash(route);
  showRouteDetail(route);
  onRouteSelect?.(route);

  document.querySelectorAll('.route-item').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.id === route.id);
  });
}

function formatSchedule(scheduleRaw: string | undefined): string {
  if (!scheduleRaw) return '';
  
  // Format string by splitting on "/" or "|"
  const parts = scheduleRaw.split(/[/|]/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  let html = '<table class="schedule-table"><tbody>';
  
  parts.forEach(part => {
    // Basic heuristic: separate text (day) and time (e.g. 05:00-22:00)
    const match = part.match(/^(.*?)\s+((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}.*))$/i);
    let day = part;
    let time = '';
    
    if (match) {
      day = match[1].trim();
      time = match[2].trim();
    } else {
      // Also try to capture things like "Lunes a Viernes 4:00 am - 11:00 pm"
      const parts2 = part.split(/(\d{1,2}:\d{2}.*)/i);
      if (parts2.length > 1) {
        day = parts2[0].trim();
        time = parts2[1].trim();
      }
    }
    
    // Normalize common abbreviations
    const normalizedDay = day
      .replace(/^L-V$/i, 'Lunes a Viernes')
      .replace(/^S$/i, 'Sábados')
      .replace(/^D-F$/i, 'Dom. y Festivos')
      .replace(/^D-F-A$/i, 'Dom. y Festivos')
      .replace(/^L-S$/i, 'Lunes a Sábado')
      .replace(/^L-D$/i, 'Lunes a Domingo');

    html += `<tr>
      <td class="schedule-day">${escapeHTML(normalizedDay)}</td>
      <td class="schedule-time">${escapeHTML(time)}</td>
    </tr>`;
  });
  
  html += '</tbody></table>';
  return html;
}

function renderStopsTimeline(route: RouteListItem): string {
  const stops = route.stops;
  if (!stops || stops.length === 0) {
    return '<div class="stops-empty">Cargando paradas…</div>';
  }

  let html = '<div class="stops-timeline">';
  stops.forEach((stop, i) => {
    const isFirst = i === 0;
    const isLast = i === stops.length - 1;
    const dotClass = isFirst ? 'origin' : isLast ? 'destination' : 'intermediate';
    const label = isFirst ? 'Origen' : isLast ? 'Destino' : '';

    html += `
      <div class="timeline-stop ${dotClass}" data-index="${i}">
        <div class="timeline-dot-col">
          <div class="timeline-dot ${dotClass}"></div>
          ${!isLast ? '<div class="timeline-line"></div>' : ''}
        </div>
        <div class="timeline-stop-info">
          <div class="timeline-stop-name">${escapeHTML(stop.nombre)}</div>
          ${label ? `<div class="timeline-stop-label">${label}</div>` : ''}
          ${stop.direccion ? `<div class="timeline-stop-code">${escapeHTML(stop.direccion)}</div>` : (stop.codigo ? `<div class="timeline-stop-code"># ${escapeHTML(stop.codigo)}</div>` : '')}
        </div>
      </div>
    `;
  });
  html += '</div>';
  return html;
}

function showRouteDetail(route: RouteListItem): void {
  const panel = document.getElementById('route-detail')!;
  const content = document.getElementById('route-detail-content')!;
  const sidebar = document.getElementById('sidebar')!;
  const wasHidden = panel.classList.contains('hidden');
  setSidebarCollapsed(false);
  const isTroncal = route.type === 'troncal';
  const routeKindLabel = route.subType === 'dual' ? 'Ruta Dual' : isTroncal ? 'Ruta Troncal' : 'Ruta Zonal SITP';
  const badgeColor = safeColor(getRouteAccentColor(route));
  const scheduleHtml = formatSchedule(route.schedule);

  content.innerHTML = `
    <div class="detail-header">
      <div class="detail-badge-row">
        <div class="detail-badge ${route.type}" style="background:${badgeColor};color:#fff;">${escapeHTML(route.code)}</div>
        <button id="route-detail-share" class="detail-share-btn" type="button" aria-label="Copiar enlace a esta ruta" title="Copiar enlace a esta ruta">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <span>Copiar enlace</span>
        </button>
      </div>
      <div class="detail-name">${escapeHTML(route.origin)} -> ${escapeHTML(route.destination)}</div>
      <div class="detail-subtitle">${routeKindLabel}</div>
      <div id="live-tracking-status" class="live-tracking-status loading">
        <div class="live-card-main">
          <span class="live-status-dot pulse loading"></span>
          <div class="live-status-textcol">
            <span class="live-status-text">Conectando con buses en vivo...</span>
            <span class="live-status-sub"></span>
          </div>
        </div>
        <div class="live-card-side">
          <span class="live-status-chip loading">Buscando…</span>
          <button id="live-status-refresh" class="live-status-refresh" type="button" aria-label="Actualizar ahora" title="Actualizar ahora">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
          </button>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Paradas (${route.stops?.length || 0})</div>
      ${renderStopsTimeline(route)}
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Detalles</div>
      ${route.busType ? `<div class="detail-row"><span class="detail-row-label">Tipo de bus</span><span class="detail-row-value">${escapeHTML(route.busType)}</span></div>` : ''}
      ${route.operator ? `<div class="detail-row"><span class="detail-row-label">Operador</span><span class="detail-row-value">${escapeHTML(route.operator)}</span></div>` : ''}
      ${route.length ? `<div class="detail-row"><span class="detail-row-label">Longitud</span><span class="detail-row-value">${route.length.toFixed(1)} km</span></div>` : ''}
      <div class="detail-row"><span class="detail-row-label">Sistema</span><span class="detail-row-value">${route.subType === 'dual' ? 'TransMilenio Dual' : isTroncal ? 'TransMilenio Troncal' : 'SITP Zonal'}</span></div>
    </div>
    
    ${scheduleHtml ? `
    <div class="detail-section">
      <div class="detail-section-title">Horario</div>
      ${scheduleHtml}
    </div>` : ''}
  `;

  content.querySelectorAll('.timeline-stop').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt((el as HTMLElement).dataset.index || '0', 10);
      const stop = route.stops?.[idx];
      if (stop) {
        onStopSelect?.(stop, route.type);
      }
    });
  });

  content.querySelector('#route-detail-share')?.addEventListener('click', () => {
    void shareRoute(route);
  });

  content.querySelector('#live-status-refresh')?.addEventListener('click', () => {
    const card = document.getElementById('live-tracking-status');
    card?.querySelector('.live-status-refresh')?.classList.add('spinning');
    liveRefreshHandler?.();
  });

  sidebar.classList.add('detail-open');
  panel.classList.remove('hidden');

  // On mobile, opening a route's detail should bring the sheet up so the
  // timeline/live card is actually visible rather than hidden behind the peek.
  if (isMobileSheet() && currentDetent !== 'full') setSheetDetent('full');

  // Switch to explore tab if route is selected
  const tabExplore = document.getElementById('tab-explore');
  if (tabExplore && !tabExplore.classList.contains('active')) {
    tabExplore.click();
  }

  // On a fresh open (not a live re-render), move focus into the panel so
  // keyboard users land on it; Esc/Volver returns focus to the route item.
  if (wasHidden) {
    (document.getElementById('route-detail-close') as HTMLButtonElement | null)?.focus();
  }
}

/**
 * Render the live-tracking card from the honest status the API resolved.
 *
 * The cardinal rule (the whole point of the overhaul): we only claim "no buses"
 * when a Colombian egress *verified* it (`no-buses`). A low-confidence empty
 * from a free public proxy (`unverified`) or a total outage (`unreachable`) is
 * shown as "señal limitada / reintentando", never as a confident absence.
 */
export function updateLiveBusStatus(count: number, status: TrackingStatus, asOf?: number): void {
  const card = document.getElementById('live-tracking-status');
  const dotEl = card?.querySelector('.live-status-dot');
  const textEl = card?.querySelector('.live-status-text');
  const subEl = card?.querySelector('.live-status-sub');
  const chipEl = card?.querySelector('.live-status-chip');
  const refreshEl = card?.querySelector('.live-status-refresh');

  if (!card || !dotEl || !textEl || !chipEl) return;

  refreshEl?.classList.remove('spinning');
  card.className = `live-tracking-status ${status}`;
  dotEl.className = 'live-status-dot';
  chipEl.className = 'live-status-chip';
  stopFreshTicker();
  if (subEl) subEl.textContent = '';

  const plural = count === 1 ? '' : 'es';

  switch (status) {
    case 'loading':
      dotEl.classList.add('pulse', 'loading');
      chipEl.classList.add('loading');
      textEl.textContent = 'Conectando con buses en vivo...';
      chipEl.textContent = 'Buscando…';
      break;

    case 'live':
      // Truthful: buses ARE live. No schedule-adherence data, so the chip
      // reports liveness/count, never fake punctuality.
      dotEl.classList.add('pulse');
      chipEl.classList.add('success');
      textEl.textContent = `Rastreando ${count} bus${plural} en vivo`;
      chipEl.textContent = `${count} en vivo`;
      startFreshTicker(card, 'Actualizado', asOf);
      break;

    case 'no-buses':
      // Verified absence from a CO egress — safe to state plainly.
      dotEl.classList.add('empty');
      chipEl.classList.add('empty');
      textEl.textContent = 'Sin buses en este momento';
      chipEl.textContent = 'Sin buses';
      if (subEl) subEl.textContent = 'Confirmado por el sistema';
      break;

    case 'unverified':
      // A free-proxy empty: could be a silent API. Never assert "no buses".
      dotEl.classList.add('pulse', 'unverified');
      chipEl.classList.add('unverified');
      textEl.textContent = count > 0
        ? `Mostrando ${count} bus${plural} (señal limitada)`
        : 'Señal de rastreo limitada';
      chipEl.textContent = 'Señal débil';
      if (subEl) subEl.textContent = 'Reintentando…';
      break;

    case 'stale': {
      // Cached positions served during an upstream outage (spec §4.2).
      dotEl.classList.add('stale');
      chipEl.classList.add('stale');
      const at = typeof asOf === 'number'
        ? new Date(asOf).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
        : '';
      textEl.textContent = count > 0
        ? `Últimos ${count} bus${plural} conocidos`
        : 'Últimos datos conocidos';
      if (subEl) subEl.textContent = at ? `Datos de ${at}` : 'Datos recientes';
      chipEl.textContent = 'Demorado';
      break;
    }

    case 'unreachable':
      // No transport reached upstream. If we're still showing a prior fix, say so
      // (the map isn't blanked); otherwise report the outage. Either way, retry.
      dotEl.classList.add('error');
      chipEl.classList.add('error');
      if (count > 0) {
        textEl.textContent = `Últimos ${count} bus${plural} · señal interrumpida`;
        chipEl.textContent = 'Demorado';
        if (subEl) subEl.textContent = 'Reintentando…';
      } else {
        textEl.textContent = 'Rastreo en vivo no disponible';
        chipEl.textContent = 'Sin señal';
        if (subEl) subEl.textContent = 'Reintentando…';
      }
      break;
  }
}

/** Tick the "Actualizado hace Xs" sub-line every few seconds between 15s polls. */
function startFreshTicker(card: Element, prefix: string, asOf?: number): void {
  liveFreshAt = typeof asOf === 'number' ? asOf : Date.now();
  const render = () => {
    const sub = card.querySelector('.live-status-sub');
    if (!sub || !document.body.contains(card)) { stopFreshTicker(); return; }
    sub.textContent = `${prefix} ${formatAgo(liveFreshAt)}`;
  };
  render();
  liveFreshTimer = window.setInterval(render, 5000);
}

export function refreshRouteDetail(route: RouteListItem): void {
  if (selectedRouteId === route.id) {
    showRouteDetail(route);
  }
}

function closeRouteDetail(): void {
  const panel = document.getElementById('route-detail')!;
  const sidebar = document.getElementById('sidebar')!;
  panel.classList.add('hidden');
  sidebar.classList.remove('detail-open');
  selectedRouteId = null;
  stopFreshTicker();

  document.querySelectorAll('.route-item').forEach((el) => {
    el.classList.remove('active');
  });

  // Return keyboard focus to the route item that opened the panel.
  if (lastRouteTrigger && document.body.contains(lastRouteTrigger)) {
    lastRouteTrigger.focus();
  }
  lastRouteTrigger = null;
}

export function updateCounts(counts: {
  troncal?: number;
  zonal?: number;
  stations?: number;
  stops?: number;
  cable?: number;
  cableStations?: number;
  demand?: number;
}): void {
  // Every field is optional so partial updates (e.g. a late-loading layer) only
  // touch their own badge and never clobber the others.
  const setCount = (id: string, value: number | undefined): void => {
    if (value === undefined) return;
    const el = document.getElementById(id);
    if (el) el.textContent = value.toString();
  };
  setCount('count-troncal', counts.troncal);
  setCount('count-zonal', counts.zonal);
  setCount('count-stations', counts.stations);
  setCount('count-stops', counts.stops);
  setCount('count-cable', counts.cable);
  setCount('count-cable-stations', counts.cableStations);
  setCount('count-demand', counts.demand);
}

export function selectRouteByCode(code: string): boolean {
  const normalized = code.trim().toUpperCase();
  const route = allRoutes.find((r) => r.code.toUpperCase() === normalized);
  if (route) {
    selectRoute(route);
    return true;
  }
  return false;
}

export function selectRouteByIdOrCode(id: string, code: string): boolean {
  let route = allRoutes.find((r) => r.id === id);
  if (!route && code) {
    const normalized = code.trim().toUpperCase();
    route = allRoutes.find((r) => r.code.toUpperCase() === normalized);
  }
  if (route) {
    selectRoute(route);
    return true;
  }
  return false;
}
