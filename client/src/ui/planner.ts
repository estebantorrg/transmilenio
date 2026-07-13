import maplibregl from 'maplibre-gl';
import { api } from '../services/api';
import { findRoutes, getDistance, initRouter, isTunnelTransfer, enrichWalkingGeometries as enrichPlansWalking, type JourneyPlan, type CableStationInput } from '../services/router';
import { drawJourneyPath, clearJourneyPath, assignSegmentColors } from '../layers/journeyLayer';
import { escapeHTML, safeColor } from '../utils/html';
import { getSessionExactLocation, setSessionExactLocation } from '../utils/sessionLocation';
import type { RouteListItem } from '../types/transmilenio';

let mapInstance: maplibregl.Map;

// Selection states
let originCoord: [number, number] | null = null;
let originStopCode: string | undefined = undefined;
let originSelectionText = '';

let destCoord: [number, number] | null = null;
let destStopCode: string | undefined = undefined;
let destSelectionText = '';

let mapPickMode: 'origin' | 'destination' | null = null;
let activePlanIndex: number | null = null;
let calculatedPlans: JourneyPlan[] = [];
let lastSortBy: 'transfers' | 'time' | 'walk' = 'transfers';
let plannerRequestSeq = 0;
let originAutocompleteSeq = 0;
let destAutocompleteSeq = 0;

type PlannerEndpoint = 'origin' | 'destination';

const MAP_PICK_DEFAULT_LABEL = 'Elegir en mapa';
const MAP_PICK_ACTIVE_LABEL = 'Cancelar';

function getEndpointElements(endpoint: PlannerEndpoint): {
  input: HTMLInputElement | null;
  clear: HTMLElement | null;
  autocomplete: HTMLElement | null;
} {
  const inputId = endpoint === 'origin' ? 'plan-origin-input' : 'plan-destination-input';
  const clearId = endpoint === 'origin' ? 'plan-origin-clear' : 'plan-destination-clear';
  const autocompleteId = endpoint === 'origin' ? 'origin-autocomplete' : 'destination-autocomplete';

  return {
    input: document.getElementById(inputId) as HTMLInputElement | null,
    clear: document.getElementById(clearId),
    autocomplete: document.getElementById(autocompleteId),
  };
}

function getEmptyStateIllustration(type: 'default' | 'incomplete' | 'close' | 'loading' | 'error' | 'no-results'): string {
  switch (type) {
    case 'default':
      return `
        <svg class="planner-illustration" width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 48C16 48 24 24 36 24C48 24 48 16 48 16" stroke="url(#route-grad-default)" stroke-width="4" stroke-linecap="round" stroke-dasharray="8 4" class="empty-route-path" />
          <circle cx="16" cy="48" r="7" fill="#1C1E22" stroke="var(--tm-green)" stroke-width="3" />
          <circle cx="16" cy="48" r="3" fill="var(--tm-green)" />
          <circle cx="48" cy="16" r="7" fill="#1C1E22" stroke="var(--tm-red-light)" stroke-width="3" />
          <circle cx="48" cy="16" r="3" fill="var(--tm-red-light)" />
          <circle cx="36" cy="24" r="4" fill="#1C1E22" stroke="var(--tm-yellow)" stroke-width="2" />
          <defs>
            <linearGradient id="route-grad-default" x1="16" y1="48" x2="48" y2="16" gradientUnits="userSpaceOnUse">
              <stop stop-color="var(--tm-green)" />
              <stop offset="0.5" stop-color="var(--tm-yellow)" />
              <stop offset="1" stop-color="var(--tm-red-light)" />
            </linearGradient>
          </defs>
        </svg>
      `;
    case 'incomplete':
      return `
        <svg class="planner-illustration" width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="32" cy="32" r="28" fill="rgba(239, 68, 68, 0.05)" stroke="rgba(239, 68, 68, 0.15)" stroke-width="2" />
          <path d="M16 48C18 42 22 38 26 38M38 32C42 30 46 26 48 16" stroke="rgba(255,255,255,0.15)" stroke-width="3" stroke-linecap="round" stroke-dasharray="6 4" />
          <circle cx="16" cy="48" r="6" fill="#1C1E22" stroke="rgba(255,255,255,0.3)" stroke-width="2" />
          <circle cx="48" cy="16" r="6" fill="#1C1E22" stroke="rgba(255,255,255,0.3)" stroke-width="2" />
          <path d="M32 20V36M32 44H32.02" stroke="var(--tm-red-light)" stroke-width="4" stroke-linecap="round" />
        </svg>
      `;
    case 'close':
      return `
        <svg class="planner-illustration" width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="24" cy="32" r="16" fill="rgba(93, 181, 123, 0.08)" stroke="rgba(93, 181, 123, 0.2)" stroke-width="2" />
          <circle cx="40" cy="32" r="16" fill="rgba(255, 90, 110, 0.08)" stroke="rgba(255, 90, 110, 0.2)" stroke-width="2" />
          <path d="M26 32H38" stroke="url(#route-grad-close)" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 3" class="empty-route-path" />
          <circle cx="24" cy="32" r="6" fill="#1C1E22" stroke="var(--tm-green)" stroke-width="2" />
          <circle cx="40" cy="32" r="6" fill="#1C1E22" stroke="var(--tm-red-light)" stroke-width="2" />
          <path d="M32 18 L35 22 M32 18 L29 22 M32 18 V26" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round" />
          <defs>
            <linearGradient id="route-grad-close" x1="24" y1="32" x2="40" y2="32" gradientUnits="userSpaceOnUse">
              <stop stop-color="var(--tm-green)" />
              <stop offset="1" stop-color="var(--tm-red-light)" />
            </linearGradient>
          </defs>
        </svg>
      `;
    case 'loading':
      return `
        <svg class="planner-illustration loading-route-svg" width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="32" cy="32" r="24" stroke="rgba(216, 16, 45, 0.1)" stroke-width="4" />
          <circle cx="32" cy="32" r="24" stroke="url(#loading-grad)" stroke-width="4" stroke-linecap="round" stroke-dasharray="40 100" class="loading-circle-glow" />
          <path d="M20 40C20 40 26 28 34 28C42 28 44 24 44 24" stroke="rgba(255,255,255,0.2)" stroke-width="3" stroke-linecap="round" stroke-dasharray="5 3" />
          <circle cx="20" cy="40" r="5" fill="#1C1E22" stroke="var(--tm-green)" stroke-width="2" />
          <circle cx="44" cy="24" r="5" fill="#1C1E22" stroke="var(--tm-red-light)" stroke-width="2" />
          <defs>
            <linearGradient id="loading-grad" x1="8" y1="32" x2="56" y2="32" gradientUnits="userSpaceOnUse">
              <stop stop-color="var(--tm-red)" />
              <stop offset="1" stop-color="var(--tm-red-light)" />
            </linearGradient>
          </defs>
        </svg>
      `;
    case 'error':
      return `
        <svg class="planner-illustration" width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="32" cy="32" r="28" fill="rgba(239, 68, 68, 0.05)" stroke="rgba(239, 68, 68, 0.15)" stroke-width="2" />
          <path d="M22 22 L42 42 M42 22 L22 42" stroke="var(--tm-red-light)" stroke-width="4" stroke-linecap="round" />
        </svg>
      `;
    case 'no-results':
      return `
        <svg class="planner-illustration" width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 48C20 44 24 44 28 44" stroke="rgba(255, 90, 110, 0.3)" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 4" />
          <path d="M36 36C40 36 44 32 48 16" stroke="rgba(93, 181, 123, 0.3)" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 4" />
          <circle cx="16" cy="48" r="6" fill="#1C1E22" stroke="var(--tm-green)" stroke-width="2" />
          <circle cx="48" cy="16" r="6" fill="#1C1E22" stroke="var(--tm-red-light)" stroke-width="2" />
          <circle cx="34" cy="30" r="10" stroke="var(--text-secondary)" stroke-width="2" />
          <path d="M41 37 L47 43" stroke="var(--text-secondary)" stroke-width="2" stroke-linecap="round" />
        </svg>
      `;
  }
}

function renderPlannerPrompt(message = 'Elige tu origen y destino para encontrar la mejor ruta en TransMilenio y SITP.'): void {
  const resultsContainer = document.getElementById('planner-results');
  if (!resultsContainer) return;

  const isDefault = message.includes('Elige tu origen y destino') || message.includes('Planifica tu viaje');
  const type = isDefault ? 'default' : 'incomplete';

  resultsContainer.innerHTML = `
    <div class="planner-empty-state">
      ${getEmptyStateIllustration(type)}
      <div class="card-empty-title">${isDefault ? 'Planifica tu viaje' : 'Selección requerida'}</div>
      <div class="card-empty-text">${escapeHTML(message)}</div>
    </div>
  `;
}

function invalidatePlannerResults(message?: string): void {
  plannerRequestSeq++;
  calculatedPlans = [];
  activePlanIndex = null;
  if (mapInstance) clearJourneyPath(mapInstance);
  renderPlannerPrompt(message);
}

function setEndpointSelection(
  endpoint: PlannerEndpoint,
  label: string,
  coord: [number, number],
  code?: string
): void {
  const { input, clear, autocomplete } = getEndpointElements(endpoint);
  if (input) input.value = label;
  clear?.classList.remove('hidden');
  autocomplete?.classList.add('hidden');

  if (endpoint === 'origin') {
    originCoord = coord;
    originStopCode = code;
    originSelectionText = label;
  } else {
    destCoord = coord;
    destStopCode = code;
    destSelectionText = label;
  }

  invalidatePlannerResults();
  syncPlannerHash();
}

function clearEndpointSelection(endpoint: PlannerEndpoint, focus = false): void {
  const { input, clear, autocomplete } = getEndpointElements(endpoint);
  if (input) {
    input.value = '';
    if (focus) input.focus();
  }
  clear?.classList.add('hidden');
  autocomplete?.classList.add('hidden');

  if (endpoint === 'origin') {
    originCoord = null;
    originStopCode = undefined;
    originSelectionText = '';
  } else {
    destCoord = null;
    destStopCode = undefined;
    destSelectionText = '';
  }

  invalidatePlannerResults();
  syncPlannerHash();
}

function isPlannerVisible(): boolean {
  return !document.getElementById('planner-panel')?.classList.contains('hidden');
}

function getEndpointText(endpoint: PlannerEndpoint): string {
  return endpoint === 'origin' ? 'origen' : 'destino';
}

function updateMapPickButton(endpoint: PlannerEndpoint, active: boolean): void {
  const button = document.getElementById(`btn-${endpoint}-map`) as HTMLButtonElement | null;
  if (!button) return;

  const endpointText = getEndpointText(endpoint);
  const label = button.querySelector<HTMLElement>('.map-pick-label');

  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
  button.title = active
    ? `Cancelar seleccion de ${endpointText} en el mapa`
    : `Elegir ${endpointText} haciendo clic en el mapa`;
  button.setAttribute(
    'aria-label',
    active ? `Cancelar seleccion de ${endpointText} en el mapa` : `Elegir ${endpointText} en el mapa`
  );

  if (label) label.textContent = active ? MAP_PICK_ACTIVE_LABEL : MAP_PICK_DEFAULT_LABEL;
}

function updateMapPickHint(mode: PlannerEndpoint | null): void {
  const hint = document.getElementById('map-pick-hint');
  if (!hint) return;

  if (!mode) {
    hint.textContent = '';
    hint.classList.add('hidden');
    return;
  }

  hint.textContent = `Haz clic en el mapa para fijar el ${getEndpointText(mode)}. Pulsa Cancelar para salir.`;
  hint.classList.remove('hidden');
}

// ─── Deep linking (#/plan?o=…&d=…) ────────────────────────
// A planned trip is mirrored into the URL hash so a journey is shareable and
// restorable. Writes use replaceState (no history spam, fires no event); the
// `#/r/<code>` route links owned by the sidebar are left untouched because we
// only ever write while the planner panel is visible.

function fmtLatLng(coord: [number, number]): string {
  return `${coord[1].toFixed(6)},${coord[0].toFixed(6)}`;
}

function parseLatLng(value: string | null): [number, number] | null {
  if (!value) return null;
  const [lat, lng] = value.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
}

function pointLabel(coord: [number, number]): string {
  return `Punto en el mapa · ${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}`;
}

function serializePlannerState(): string | null {
  if (!originCoord && !destCoord) return null;
  const sp = new URLSearchParams();
  if (originCoord) {
    sp.set('o', fmtLatLng(originCoord));
    if (originSelectionText) sp.set('ol', originSelectionText);
    if (originStopCode) sp.set('oc', originStopCode);
  }
  if (destCoord) {
    sp.set('d', fmtLatLng(destCoord));
    if (destSelectionText) sp.set('dl', destSelectionText);
    if (destStopCode) sp.set('dc', destStopCode);
  }
  const mode = (document.getElementById('plan-transport-mode') as HTMLInputElement | null)?.value;
  const pref = (document.getElementById('plan-preference') as HTMLInputElement | null)?.value;
  if (mode && mode !== 'mix') sp.set('m', mode);
  if (pref && pref !== 'transfers') sp.set('p', pref);
  return sp.toString();
}

function syncPlannerHash(): void {
  if (!isPlannerVisible()) return;
  const state = serializePlannerState();
  const base = location.pathname + location.search;
  if (state) {
    const want = `#/plan?${state}`;
    if (location.hash !== want) history.replaceState(null, '', base + want);
  } else if (location.hash.startsWith('#/plan')) {
    history.replaceState(null, '', base);
  }
}

function parsePlannerHash(): URLSearchParams | null {
  const match = location.hash.match(/^#\/plan\?(.*)$/);
  return match ? new URLSearchParams(match[1]) : null;
}

function setDropdownValue(dropdownId: string, hiddenId: string, value: string): void {
  const dropdown = document.getElementById(dropdownId);
  const hidden = document.getElementById(hiddenId) as HTMLInputElement | null;
  const item = dropdown?.querySelector<HTMLElement>(`.custom-dropdown-item[data-value="${value}"]`);
  if (!dropdown || !hidden || !item) return;
  hidden.value = value;
  dropdown.querySelectorAll('.custom-dropdown-item').forEach((i) => i.classList.remove('selected'));
  item.classList.add('selected');
  const label = dropdown.querySelector('.custom-dropdown-label');
  if (label) label.textContent = item.textContent || '';
}

/** Restore the planner from a shared/back-navigated `#/plan?…` link. */
function restorePlannerFromHash(): void {
  const sp = parsePlannerHash();
  if (!sp) return;

  document.getElementById('tab-planner')?.click();
  setDropdownValue('dropdown-transport', 'plan-transport-mode', sp.get('m') || 'mix');
  setDropdownValue('dropdown-preference', 'plan-preference', sp.get('p') || 'transfers');

  const origin = parseLatLng(sp.get('o'));
  const dest = parseLatLng(sp.get('d'));
  if (origin) setEndpointSelection('origin', sp.get('ol') || pointLabel(origin), origin, sp.get('oc') || undefined);
  if (dest) setEndpointSelection('destination', sp.get('dl') || pointLabel(dest), dest, sp.get('dc') || undefined);
  if (origin && dest) calculateRoute();
}

/**
 * Initializes the Journey Planner UI controllers.
 */
export function initPlanner(
  map: maplibregl.Map,
  routes: RouteListItem[],
  cableStations?: CableStationInput[]
): void {
  mapInstance = map;

  // Initialize routing graph (incl. TransMiCable line when provided)
  initRouter(routes, cableStations);

  // Setup panel tab controls
  initTabs();

  // Setup input autocompletes and buttons
  initInputHandlers();

  // Setup map click listener for picking coordinates
  initMapClickListener();

  // Setup custom dropdown selects
  initCustomDropdowns();

  // Restore a shared journey link and keep planner state in sync with the URL.
  window.addEventListener('hashchange', () => {
    if (parsePlannerHash()) restorePlannerFromHash();
  });
  restorePlannerFromHash();
}

/**
 * Entry point used by station/stop popups ("Desde aquí" / "Hasta aquí"): opens
 * the planner tab and sets the chosen endpoint to the clicked point. Passing the
 * catalog `code` lets the router snap onto the real stop/station node.
 */
export function planFromPopup(
  role: PlannerEndpoint,
  label: string,
  coord: [number, number],
  code?: string
): void {
  if (!mapInstance) return;
  document.getElementById('tab-planner')?.click();
  setEndpointSelection(role, label, coord, code);
}

function initCustomDropdowns(): void {
  const dropdowns = document.querySelectorAll('.custom-dropdown');
  
  dropdowns.forEach((dropdown) => {
    const trigger = dropdown.querySelector('.custom-dropdown-trigger') as HTMLButtonElement;
    const menu = dropdown.querySelector('.custom-dropdown-menu') as HTMLElement;
    const items = dropdown.querySelectorAll('.custom-dropdown-item');
    const hiddenInput = dropdown.querySelector('input[type="hidden"]') as HTMLInputElement;

    if (!trigger || !menu || !hiddenInput) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      
      // Close other dropdowns
      document.querySelectorAll('.custom-dropdown-menu').forEach((otherMenu) => {
        if (otherMenu !== menu) otherMenu.classList.add('hidden');
      });
      document.querySelectorAll('.custom-dropdown-trigger').forEach((otherTrigger) => {
        if (otherTrigger !== trigger) otherTrigger.setAttribute('aria-expanded', 'false');
      });

      const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', String(!isExpanded));
      menu.classList.toggle('hidden');
    });

    items.forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const li = item as HTMLElement;
        const val = li.dataset.value || '';
        const label = li.textContent || '';

        hiddenInput.value = val;
        
        const labelEl = trigger.querySelector('.custom-dropdown-label');
        if (labelEl) labelEl.textContent = label;

        items.forEach((i) => i.classList.remove('selected'));
        li.classList.add('selected');

        trigger.setAttribute('aria-expanded', 'false');
        menu.classList.add('hidden');

        // Trigger planner calculation if input changed
        invalidatePlannerResults();
        syncPlannerHash();
      });
    });
  });

  // Close dropdown on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-dropdown-menu').forEach((menu) => menu.classList.add('hidden'));
    document.querySelectorAll('.custom-dropdown-trigger').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
  });
}

/**
 * Switch between the sidebar's top-level panels (Explorar / Cerca / Planear).
 * One generic controller so the tab set stays data-driven instead of a growing
 * pile of per-tab handlers.
 */
const SIDEBAR_TABS = [
  { tab: 'tab-explore', panel: 'explore-panel' },
  { tab: 'tab-cerca', panel: 'cerca-panel' },
  { tab: 'tab-planner', panel: 'planner-panel' },
] as const;

function initTabs(): void {
  const activate = (activeTab: string): void => {
    const sidebar = document.getElementById('sidebar')!;

    // Close card balance panel if open.
    if (sidebar.classList.contains('card-open')) {
      document.getElementById('card-detail-close')?.click();
    }

    for (const { tab, panel } of SIDEBAR_TABS) {
      const isActive = tab === activeTab;
      document.getElementById(tab)?.classList.toggle('active', isActive);
      document.getElementById(panel)?.classList.toggle('hidden', !isActive);
    }

    setMapPickMode(null);

    // The route-detail overlay belongs to Explore; hide it on the other tabs so
    // their panels are visible, restore it when returning to Explore.
    const routeDetail = document.getElementById('route-detail');
    if (activeTab === 'tab-explore') {
      if (sidebar.classList.contains('detail-open')) routeDetail?.classList.remove('hidden');
    } else {
      routeDetail?.classList.add('hidden');
    }

    // Journey highlight lives only while the planner is active.
    if (activeTab === 'tab-planner') {
      if (activePlanIndex !== null && calculatedPlans[activePlanIndex]) {
        drawJourneyPath(mapInstance, calculatedPlans[activePlanIndex]);
      }
    } else {
      clearJourneyPath(mapInstance);
    }
  };

  for (const { tab } of SIDEBAR_TABS) {
    document.getElementById(tab)?.addEventListener('click', () => activate(tab));
  }
}

function setMapPickMode(mode: 'origin' | 'destination' | null): void {
  mapPickMode = mode;
  // Drive the cursor via a container class, not an inline canvas style: the
  // station/stop/cable hover handlers overwrite the canvas inline cursor (and
  // dragging resets it), so a one-shot inline 'crosshair' is lost the moment
  // the pointer crosses a marker or pans. A CSS rule with !important keyed off
  // this class beats those inline writes and keeps the crosshair while picking.
  mapInstance.getContainer().classList.toggle('map-pick-active', mode !== null);
  updateMapPickButton('origin', mode === 'origin');
  updateMapPickButton('destination', mode === 'destination');
  updateMapPickHint(mode);
}

function initMapClickListener(): void {
  mapInstance.on('click', (e) => {
    if (!mapPickMode) return;

    const coord: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    setEndpointSelection(mapPickMode, `Punto en el mapa · ${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}`, coord);

    setMapPickMode(null);
  });
}

interface GeocodeCandidate {
  name: string;
  lat: number;
  lon: number;
  type?: string;
  code?: string;
}

// Client-side geocode cache: repeated/backspace-retype queries render instantly
// and skip the server round-trip entirely. Bounded LRU keyed by lowercased query.
const GEOCODE_CLIENT_CACHE_MAX = 60;
const geocodeClientCache = new Map<string, GeocodeCandidate[]>();

function geocodeCacheGet(key: string): GeocodeCandidate[] | undefined {
  const hit = geocodeClientCache.get(key);
  if (!hit) return undefined;
  geocodeClientCache.delete(key);
  geocodeClientCache.set(key, hit);
  return hit;
}

function geocodeCacheSet(key: string, candidates: GeocodeCandidate[]): void {
  geocodeClientCache.set(key, candidates);
  while (geocodeClientCache.size > GEOCODE_CLIENT_CACHE_MAX) {
    const oldest = geocodeClientCache.keys().next().value;
    if (oldest === undefined) break;
    geocodeClientCache.delete(oldest);
  }
}

/** Render geocode candidates into an autocomplete dropdown and wire selection. */
function renderAutocompleteCandidates(
  dropdown: HTMLElement,
  candidates: GeocodeCandidate[],
  onSelect: (name: string, coord: [number, number], code?: string) => void
): void {
  if (candidates.length === 0) {
    dropdown.innerHTML = `<div class="autocomplete-item"><div class="autocomplete-name">Sin resultados</div></div>`;
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = candidates
    .map((c) => {
      const lat = Number(c.lat);
      const lon = Number(c.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
      const typeClass = c.type === 'station' ? 'station' : c.type === 'stop' ? 'stop' : 'place';
      const icon = c.type === 'station' ? '🚇' : c.type === 'stop' ? '🚏' : '📍';
      const metaText = c.code ? `Código: ${c.code}` : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      return `
        <div class="autocomplete-item ${typeClass}"
             data-name="${escapeHTML(c.name)}"
             data-lat="${lat}"
             data-lon="${lon}"
             data-code="${escapeHTML(c.code || '')}">
          <span class="autocomplete-icon">${icon}</span>
          <div class="autocomplete-info">
            <span class="autocomplete-name">${escapeHTML(c.name)}</span>
            <span class="autocomplete-meta">${escapeHTML(metaText)}</span>
          </div>
        </div>
      `;
    })
    .join('');

  dropdown.classList.remove('hidden');

  dropdown.querySelectorAll('.autocomplete-item').forEach((el) => {
    el.addEventListener('click', () => {
      const data = el as HTMLElement;
      const name = data.dataset.name;
      if (!name) return;
      const lat = Number(data.dataset.lat);
      const lon = Number(data.dataset.lon);
      const code = data.dataset.code;
      onSelect(name, [lon, lat], code || undefined);
      dropdown.classList.add('hidden');
    });
  });
}

function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): (...args: Parameters<T>) => void {
  let timer: number;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

function initInputHandlers(): void {
  const originInput = document.getElementById('plan-origin-input') as HTMLInputElement;
  const destInput = document.getElementById('plan-destination-input') as HTMLInputElement;

  const originClear = document.getElementById('plan-origin-clear')!;
  const destClear = document.getElementById('plan-destination-clear')!;

  const originAutocomplete = document.getElementById('origin-autocomplete')!;
  const destAutocomplete = document.getElementById('destination-autocomplete')!;

  const btnSwap = document.getElementById('btn-swap-locations')!;
  const btnCalculate = document.getElementById('btn-calculate-route')!;

  // 1. Clears
  originClear.addEventListener('click', () => {
    clearEndpointSelection('origin', true);
  });

  destClear.addEventListener('click', () => {
    clearEndpointSelection('destination', true);
  });

  // Hide autocompletes on outside click
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.input-group')) {
      originAutocomplete.classList.add('hidden');
      destAutocomplete.classList.add('hidden');
    }
  });

  // 2. Map Pickers
  document.getElementById('btn-origin-map')!.addEventListener('click', (e) => {
    e.stopPropagation();
    setMapPickMode(mapPickMode === 'origin' ? null : 'origin');
  });

  document.getElementById('btn-destination-map')!.addEventListener('click', (e) => {
    e.stopPropagation();
    setMapPickMode(mapPickMode === 'destination' ? null : 'destination');
  });

  // 3. Autocomplete query debounced triggers
  const handleAutocomplete = async (
    endpoint: PlannerEndpoint,
    query: string,
    dropdown: HTMLElement,
    onSelect: (name: string, coord: [number, number], code?: string) => void
  ) => {
    const trimmed = query.trim();
    const requestSeq = endpoint === 'origin' ? ++originAutocompleteSeq : ++destAutocompleteSeq;
    const isCurrentRequest = () => {
      const latestSeq = endpoint === 'origin' ? originAutocompleteSeq : destAutocompleteSeq;
      const latestValue = getEndpointElements(endpoint).input?.value.trim() ?? '';
      return requestSeq === latestSeq && latestValue === trimmed;
    };

    if (trimmed.length < 3) {
      dropdown.classList.add('hidden');
      return;
    }

    // Instant path: serve a prior identical query from cache, no server round-trip.
    const cacheKey = trimmed.toLowerCase();
    const cached = geocodeCacheGet(cacheKey);
    if (cached) {
      renderAutocompleteCandidates(dropdown, cached, onSelect);
      return;
    }

    // Immediate feedback while the lookup is in flight (perceived speed).
    dropdown.innerHTML = `<div class="autocomplete-item loading"><span class="autocomplete-icon">🔍</span><div class="autocomplete-name">Buscando lugares…</div></div>`;
    dropdown.classList.remove('hidden');

    try {
      // Query local lookup + Nominatim + ArcGIS geocoder proxy
      const res = await api.geocodeAddress(trimmed);
      if (!isCurrentRequest()) return;
      const candidates: GeocodeCandidate[] = res.success && Array.isArray(res.candidates) ? res.candidates : [];
      geocodeCacheSet(cacheKey, candidates);
      renderAutocompleteCandidates(dropdown, candidates, onSelect);
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error('[Planner] Geocode lookup error:', err);
      dropdown.classList.add('hidden');
    }
  };

  const debouncedOrigin = debounce((q: string) => {
    handleAutocomplete('origin', q, originAutocomplete, (name, coord, code) => {
      setEndpointSelection('origin', name, coord, code);
    });
  }, 300);

  const debouncedDest = debounce((q: string) => {
    handleAutocomplete('destination', q, destAutocomplete, (name, coord, code) => {
      setEndpointSelection('destination', name, coord, code);
    });
  }, 300);

  originInput.addEventListener('input', () => {
    originClear.classList.toggle('hidden', !originInput.value);
    if (originInput.value !== originSelectionText) {
      originCoord = null;
      originStopCode = undefined;
      originSelectionText = '';
      originAutocomplete.classList.add('hidden');
      invalidatePlannerResults('Selecciona un origen de la lista, del mapa o de tu ubicacion actual.');
    }
    debouncedOrigin(originInput.value);
  });

  destInput.addEventListener('input', () => {
    destClear.classList.toggle('hidden', !destInput.value);
    if (destInput.value !== destSelectionText) {
      destCoord = null;
      destStopCode = undefined;
      destSelectionText = '';
      destAutocomplete.classList.add('hidden');
      invalidatePlannerResults('Selecciona un destino de la lista, del mapa o de tu ubicacion actual.');
    }
    debouncedDest(destInput.value);
  });

  // 3b. Keyboard navigation for the autocomplete dropdowns + Enter-to-search.
  const attachAutocompleteKeys = (input: HTMLInputElement, dropdown: HTMLElement) => {
    const selectableItems = (): HTMLElement[] =>
      dropdown.classList.contains('hidden')
        ? []
        : Array.from(dropdown.querySelectorAll<HTMLElement>('.autocomplete-item')).filter(
            (el) => !!el.dataset.name
          );

    const setActive = (items: HTMLElement[], index: number) => {
      items.forEach((el, i) => el.classList.toggle('kbd-active', i === index));
      if (index >= 0 && items[index]) {
        items[index].scrollIntoView({ block: 'nearest' });
      }
    };

    input.addEventListener('keydown', (e) => {
      const items = selectableItems();

      if (e.key === 'ArrowDown' && items.length) {
        e.preventDefault();
        const current = items.findIndex((el) => el.classList.contains('kbd-active'));
        setActive(items, current < items.length - 1 ? current + 1 : 0);
      } else if (e.key === 'ArrowUp' && items.length) {
        e.preventDefault();
        const current = items.findIndex((el) => el.classList.contains('kbd-active'));
        setActive(items, current > 0 ? current - 1 : items.length - 1);
      } else if (e.key === 'Enter') {
        const active = items.find((el) => el.classList.contains('kbd-active'));
        if (active) {
          e.preventDefault();
          active.click();
        } else if (items.length) {
          e.preventDefault();
          items[0].click();
        } else if (originCoord && destCoord) {
          // Both endpoints already resolved — search directly.
          e.preventDefault();
          calculateRoute();
        }
      } else if (e.key === 'Escape') {
        dropdown.classList.add('hidden');
        items.forEach((el) => el.classList.remove('kbd-active'));
      }
    });
  };

  attachAutocompleteKeys(originInput, originAutocomplete);
  attachAutocompleteKeys(destInput, destAutocomplete);

  // 4. GPS buttons
  const handleGpsButton = async (
    endpoint: PlannerEndpoint,
    btn: HTMLButtonElement,
    input: HTMLInputElement,
    clearBtn: HTMLElement
  ) => {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    input.value = 'Obteniendo ubicación actual...';
    clearBtn.classList.remove('hidden');
    if (endpoint === 'origin') {
      originCoord = null;
      originStopCode = undefined;
      originSelectionText = '';
    } else {
      destCoord = null;
      destStopCode = undefined;
      destSelectionText = '';
    }
    invalidatePlannerResults('Obteniendo ubicación actual...');

    try {
      const coord = await resolveLocation();
      setEndpointSelection(endpoint, 'Mi ubicación actual', [coord.longitude, coord.latitude]);
    } catch (err) {
      console.warn('[GPS] Failed to get user location:', err);
      input.value = 'No se pudo obtener ubicación';
      clearBtn.classList.add('hidden');
      invalidatePlannerResults('No se pudo obtener tu ubicación. Elige un punto manualmente.');
      window.setTimeout(() => {
        if (input.value === 'No se pudo obtener ubicación') input.value = '';
      }, 3000);
    } finally {
      btn.classList.remove('loading');
    }
  };

  document.getElementById('btn-origin-gps')!.addEventListener('click', () => {
    const btn = document.getElementById('btn-origin-gps') as HTMLButtonElement;
    handleGpsButton('origin', btn, originInput, originClear);
  });

  document.getElementById('btn-destination-gps')!.addEventListener('click', () => {
    const btn = document.getElementById('btn-destination-gps') as HTMLButtonElement;
    handleGpsButton('destination', btn, destInput, destClear);
  });

  // 5. Swap
  btnSwap.addEventListener('click', () => {
    const tempVal = originInput.value;
    originInput.value = destInput.value;
    destInput.value = tempVal;

    const tempCoord = originCoord;
    originCoord = destCoord;
    destCoord = tempCoord;

    const tempCode = originStopCode;
    originStopCode = destStopCode;
    destStopCode = tempCode;

    const tempSelectionText = originSelectionText;
    originSelectionText = destSelectionText;
    destSelectionText = tempSelectionText;

    originClear.classList.toggle('hidden', !originInput.value);
    destClear.classList.toggle('hidden', !destInput.value);
    invalidatePlannerResults();
    syncPlannerHash();
  });

  // 6. Calculate Route Button click
  btnCalculate.addEventListener('click', () => {
    calculateRoute();
  });
}

async function resolveLocation(): Promise<{ longitude: number; latitude: number }> {
  const minLat = 4.4;
  const maxLat = 4.85;
  const minLng = -74.25;
  const maxLng = -73.95;
  const bogotaCenter = { longitude: -74.1071, latitude: 4.6486 };

  const isWithinBogota = (lng: number, lat: number) => {
    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  };

  const getPosition = (highAccuracy: boolean): Promise<GeolocationPosition> => {
    return new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: highAccuracy,
        timeout: 5000,
      });
    });
  };

  // Try GPS (High Accuracy first)
  if ('geolocation' in navigator) {
    try {
      const pos = await getPosition(true);
      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      if (isWithinBogota(lng, lat)) {
        setSessionExactLocation(lng, lat, 'gps');
        return { longitude: lng, latitude: lat };
      }
    } catch (highError) {
      console.warn('[Planner GPS] Native high-accuracy failed, trying low accuracy...', highError);
      try {
        const pos = await getPosition(false);
        const lng = pos.coords.longitude;
        const lat = pos.coords.latitude;
        if (isWithinBogota(lng, lat)) {
          setSessionExactLocation(lng, lat, 'gps');
          return { longitude: lng, latitude: lat };
        }
      } catch (lowError) {
        console.warn('[Planner GPS] Native low-accuracy failed, checking session fix...', lowError);
      }
    }
  }

  const cached = getSessionExactLocation();
  if (cached && isWithinBogota(cached.lng, cached.lat)) {
    console.info('[Planner GPS] Using session exact location');
    return { longitude: cached.lng, latitude: cached.lat };
  }

  // Fallback to IP GeoIP
  try {
    const geoip = await api.getGeoIp();
    if (geoip.success && geoip.longitude != null && geoip.latitude != null) {
      const lng = geoip.longitude;
      const lat = geoip.latitude;
      if (isWithinBogota(lng, lat)) {
        return { longitude: lng, latitude: lat };
      }
    }
  } catch {
    /* fallback to center */
  }

  // Fallback to central Bogotá if both GPS/IP fail or are out of bounds (e.g. testing from outside Bogotá/Colombia)
  return bogotaCenter;
}

/** Error state for a failed route search. Shows the underlying message (muted)
 *  so a failure is diagnosable in the field instead of an opaque "try again". */
function renderCalcError(container: HTMLElement, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  container.innerHTML = `
    <div class="planner-empty-state">
      ${getEmptyStateIllustration('error')}
      <div class="card-empty-title" style="color: var(--tm-red-light);">Error de cálculo</div>
      <div class="card-empty-text">Ocurrió un error al buscar las rutas. Inténtalo de nuevo.</div>
      ${detail ? `<div class="card-empty-text" style="opacity:.55;font-size:11px;margin-top:6px;word-break:break-word;">${escapeHTML(detail)}</div>` : ''}
    </div>
  `;
}

/**
 * Calculates paths using the local router.
 */
function calculateRoute(): void {
  const btnCalculate = document.getElementById('btn-calculate-route') as HTMLButtonElement;
  const resultsContainer = document.getElementById('planner-results')!;
  const requestId = ++plannerRequestSeq;

  if (!originCoord || !destCoord) {
    calculatedPlans = [];
    activePlanIndex = null;
    clearJourneyPath(mapInstance);
    resultsContainer.innerHTML = `
      <div class="planner-empty-state">
        ${getEmptyStateIllustration('incomplete')}
        <div class="card-empty-title" style="color: var(--tm-red-light);">Datos incompletos</div>
        <div class="card-empty-text">Por favor selecciona un origen y destino válidos.</div>
      </div>
    `;
    return;
  }

  // Calculate distance between origin and destination coordinates
  const distance = getDistance(originCoord, destCoord);
  if (distance < 50) {
    calculatedPlans = [];
    activePlanIndex = null;
    clearJourneyPath(mapInstance);
    resultsContainer.innerHTML = `
      <div class="planner-empty-state">
        ${getEmptyStateIllustration('close')}
        <div class="card-empty-title">Estás muy cerca</div>
        <div class="card-empty-text">El origen y el destino están en el mismo lugar. ¡Corta caminata!</div>
      </div>
    `;
    return;
  }

  btnCalculate.classList.add('loading');
  resultsContainer.innerHTML = `
    <div class="planner-empty-state">
      ${getEmptyStateIllustration('loading')}
      <div class="card-empty-title" style="margin-top: 10px;">Calculando la mejor ruta...</div>
      <div class="card-empty-text">Buscando conexiones en TransMilenio y SITP.</div>
    </div>
  `;

  // Read configurations
  const mode = (document.getElementById('plan-transport-mode') as HTMLInputElement).value as 'mix' | 'troncal' | 'zonal';
  const preference = (document.getElementById('plan-preference') as HTMLInputElement).value as 'transfers' | 'time' | 'walk';
  const minWalk = preference === 'walk';
  const sortBy = preference;
  lastSortBy = preference;

  window.setTimeout(() => {
    if (requestId !== plannerRequestSeq) {
      btnCalculate.classList.remove('loading');
      return;
    }

    // Compute first. Only a routing failure should surface the error state.
    let plans: JourneyPlan[];
    try {
      plans = findRoutes({
        origin: originCoord!,
        destination: destCoord!,
        originStopCode,
        destStopCode,
        mode,
        minWalk,
        sortBy,
      });
    } catch (err) {
      if (requestId !== plannerRequestSeq) return;
      console.error('[Planner] Route search failed:', err);
      btnCalculate.classList.remove('loading');
      renderCalcError(resultsContainer, err);
      return;
    }

    btnCalculate.classList.remove('loading');
    calculatedPlans = plans;

    // Rendering — including drawing the route on the map — must never be able to
    // discard a valid itinerary. A map/WebGL failure (common on mobile: GPU
    // pressure, style not fully loaded) while drawing should leave the computed
    // steps on screen, since that text is exactly what a stranded user needs.
    try {
      renderResults(calculatedPlans);
    } catch (err) {
      console.error('[Planner] Rendering results failed (itinerary still computed):', err);
    }

    // Asynchronously load real street-level walking paths from OSRM
    enrichWalkingGeometries(calculatedPlans, requestId).catch(err => {
      console.error('[Planner] Failed walking enrichment:', err);
    });
  }, 100);
}

function renderResults(plans: JourneyPlan[], preserveSelection = false): void {
  const container = document.getElementById('planner-results')!;
  
  if (plans.length === 0) {
    container.innerHTML = `
      <div class="planner-empty-state">
        ${getEmptyStateIllustration('no-results')}
        <div class="card-empty-title">Sin rutas encontradas</div>
        <div class="card-empty-text">No se pudo encontrar una conexión entre el origen y destino seleccionados con los filtros actuales.</div>
      </div>
    `;
    clearJourneyPath(mapInstance);
    activePlanIndex = null;
    return;
  }

  container.innerHTML = plans
    .map((plan, index) => {
      // Build summary badges HTML
      const segmentColors = assignSegmentColors(plan);
      const badgesHtml = plan.steps
        .map((step, stepIdx) => {
          if (step.type === 'walk') {
            return `<span class="journey-card-badge walk">🚶 ${Math.round(step.distance)}m</span>`;
          } else {
            const color = safeColor(segmentColors[stepIdx]);
            return `
              <span class="journey-card-badge" style="background:${color};">
                ${escapeHTML(step.routeCode || '')}
              </span>
            `;
          }
        })
        .join('<span class="journey-badges-arrow">➔</span>');

      return `
        <div class="journey-option-card" data-index="${index}">
          <div class="journey-summary">
            <div class="journey-duration">
              ${plan.totalTime} <span>min</span>
            </div>
            <div class="journey-meta-row">
              <div class="journey-meta-item">🚶 ${plan.walkDistance} m</div>
              <div class="journey-meta-item">🔄 ${plan.transfers} ${plan.transfers === 1 ? 'transbordo' : 'transbordos'}</div>
            </div>
          </div>
          <div class="journey-badges">${badgesHtml}</div>
          <div class="journey-steps-list hidden" data-plan-index="${index}"></div>
        </div>
      `;
    })
    .join('');

  // Attach card clicks to show on map and expand timeline details
  const cards = container.querySelectorAll('.journey-option-card');
  cards.forEach((card) => {
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // Do not collapse/expand if clicking on internal substops buttons
      if (target.closest('.journey-step-substops-btn') || target.closest('.journey-step-substops-list')) {
        return;
      }

      const idx = Number((card as HTMLElement).dataset.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= calculatedPlans.length) return;
      
      // If clicking already active, just expand/collapse it
      if (activePlanIndex === idx) {
        const stepsContainer = card.querySelector<HTMLElement>('.journey-steps-list');
        if (!stepsContainer) return;
        stepsContainer.classList.toggle('hidden');
        return;
      }

      selectPlan(idx, cards);
    });
  });

  const selectIndex = (preserveSelection && activePlanIndex !== null && activePlanIndex < plans.length)
    ? activePlanIndex
    : 0;

  selectPlan(selectIndex, cards, isPlannerVisible());
}

function getMapFitPadding(): { top: number; bottom: number; left: number; right: number } {
  const sidebarCollapsed = document.body.classList.contains('sidebar-collapsed');
  const sidebarWidth = sidebarCollapsed ? 0 : Math.min(360, window.innerWidth - 24);
  return {
    top: 60,
    bottom: 60,
    left: sidebarCollapsed ? 28 : Math.min(sidebarWidth + 40, window.innerWidth - 60),
    right: 60,
  };
}

async function enrichWalkingGeometries(plans: JourneyPlan[], requestId: number): Promise<void> {
  // Core walk-refinement (OSRM fetch, total recompute, re-rank) is shared with
  // the mobile planner (spec §1.1 R2). Here we only add the website's staleness
  // guard + selection preservation + re-render.
  const selectedPlan = activePlanIndex !== null ? plans[activePlanIndex] : null;
  try {
    await enrichPlansWalking(plans, lastSortBy);
    if (requestId !== plannerRequestSeq || plans !== calculatedPlans) return;
    activePlanIndex = selectedPlan ? Math.max(0, plans.indexOf(selectedPlan)) : 0;
    renderResults(plans, true);
  } catch (error) {
    console.error('[Planner] Error enriching walking paths:', error);
  }
}


function selectPlan(index: number, cards: NodeListOf<Element>, updateMap = true): void {
  if (!Number.isInteger(index) || index < 0 || index >= calculatedPlans.length) return;
  activePlanIndex = index;
  const plan = calculatedPlans[index];

  if (updateMap) {
    // Best-effort: a map/WebGL failure here must not abort rendering the
    // itinerary text (cards + timeline) below.
    try {
      drawJourneyPath(mapInstance, plan);

      const bounds = new maplibregl.LngLatBounds();
      let hasBounds = false;
      plan.steps.forEach((step) => {
        step.path?.forEach((coord) => {
          bounds.extend(coord);
          hasBounds = true;
        });
      });

      if (hasBounds) {
        mapInstance.fitBounds(bounds, {
          padding: getMapFitPadding(),
          maxZoom: 15,
        });
      }
    } catch (err) {
      console.error('[Planner] Map draw failed (itinerary shown without map path):', err);
    }
  }

  // Update card UI classes
  cards.forEach((card, i) => {
    card.classList.toggle('active', i === index);
    const stepsContainer = card.querySelector<HTMLElement>('.journey-steps-list');
    if (!stepsContainer) return;
    if (i === index) {
      stepsContainer.classList.remove('hidden');
      renderTimelineSteps(plan, stepsContainer);
    } else {
      stepsContainer.classList.add('hidden');
    }
  });
}

// Zonal rides stop at paraderos; troncal/cable rides at estaciones. The step
// wording follows the actual stop kind instead of calling everything "estación".
function rideStopsNoun(routeType: string | undefined, count: number): string {
  const zonal = routeType === 'zonal';
  if (count === 1) return zonal ? 'paradero' : 'estación';
  return zonal ? 'paraderos' : 'estaciones';
}

function intermediateStopsNoun(routeType: string | undefined, count: number): string {
  const zonal = routeType === 'zonal';
  if (count === 1) return zonal ? 'paradero intermedio' : 'estación intermedia';
  return zonal ? 'paraderos intermedios' : 'estaciones intermedias';
}

function renderTimelineSteps(plan: JourneyPlan, container: HTMLElement): void {
  const segmentColors = assignSegmentColors(plan);
  container.innerHTML = plan.steps
    .map((step, i) => {
      const isFirst = i === 0;
      const isLast = i === plan.steps.length - 1;
      const stepDotClass = isFirst ? 'start' : isLast ? 'end' : 'transfer';

      if (step.type === 'walk') {
        const isTunnel = isTunnelTransfer(step.fromCode, step.toCode);
        const title = isTunnel
          ? `Cruzar túnel de transferencia a ${escapeHTML(step.toName)}`
          : `Caminar hasta ${escapeHTML(step.toName)}`;
        return `
          <div class="journey-step-item">
            <div class="journey-step-timeline">
              <div class="journey-step-dot ${stepDotClass}"></div>
              ${!isLast ? '<div class="journey-step-line walk"></div>' : ''}
            </div>
            <div class="journey-step-content">
              <div class="journey-step-title">${title}</div>
              <div class="journey-step-desc">Aprox. <strong>${Math.round(step.distance)} m</strong> (${Math.max(1, Math.round(step.time))} min)</div>
            </div>
          </div>
        `;
      } else {
        // Ride step
        const routeColor = segmentColors[i];
        const accentStyle = `color:${safeColor(routeColor)};font-weight:800;`;
        
        const isCable = step.routeType === 'cable';
        const isTroncal = step.routeType === 'troncal';
        const systemName = isCable ? 'TransMiCable' : isTroncal ? 'TransMilenio' : 'SITP Zonal';
        const stopLabel = isCable || isTroncal ? 'Estación' : 'Paradero';
        const boardVerb = isCable ? 'Tomar' : 'Abordar';

        const stopsToggleHtml = step.stops && step.stops.length > 0
          ? `
            <button type="button" class="journey-step-substops-btn" data-step-index="${i}" aria-expanded="false">
              <span>👁 Ver ${step.stops.length} ${intermediateStopsNoun(step.routeType, step.stops.length)}</span>
            </button>
            <ul class="journey-step-substops-list hidden">
              ${step.stops.map((s) => `<li>${escapeHTML(s)}</li>`).join('')}
            </ul>
          `
          : '';

        return `
          <div class="journey-step-item">
            <div class="journey-step-timeline">
              <div class="journey-step-dot ${stepDotClass}"></div>
              ${!isLast ? '<div class="journey-step-line ride"></div>' : ''}
            </div>
            <div class="journey-step-content">
              <div class="journey-step-title">
                ${boardVerb} <span style="${accentStyle}">${escapeHTML(step.routeCode)}</span>
              </div>
              <div class="journey-step-desc">
                En ${stopLabel} <strong>${escapeHTML(step.fromName)}</strong> (Dirección ${escapeHTML(step.toName)})<br/>
                Viajar <strong>${step.stopCount} ${rideStopsNoun(step.routeType, step.stopCount ?? 0)}</strong> (${Math.max(1, Math.round(step.time))} min) · ${systemName}
              </div>
              ${stopsToggleHtml}
            </div>
          </div>
        `;
      }
    })
    .join('');

  // Wire intermediate stops toggles
  container.querySelectorAll('.journey-step-substops-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const button = btn as HTMLButtonElement;
      const stepIdx = Number(button.dataset.stepIndex);
      if (!Number.isInteger(stepIdx) || stepIdx < 0 || stepIdx >= plan.steps.length) return;
      const list = button.parentElement?.querySelector<HTMLElement>('.journey-step-substops-list');
      if (!list) return;
      const labelSpan = button.querySelector('span');
      if (!labelSpan) return;

      const isHidden = list.classList.toggle('hidden');
      button.setAttribute('aria-expanded', String(!isHidden));
      const planStep = plan.steps[stepIdx];
      const text = intermediateStopsNoun(planStep.routeType, planStep.stops?.length ?? 0);

      labelSpan.textContent = isHidden
        ? `👁 Ver ${planStep.stops?.length} ${text}`
        : `✕ Ocultar ${planStep.stops?.length} ${text}`;
    });
  });
}
