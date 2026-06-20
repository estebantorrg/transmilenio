import maplibregl from 'maplibre-gl';
import { api } from '../services/api';
import { findRoutes, getDistance, initRouter, fetchWalkingPath, isTunnelTransfer, type JourneyPlan } from '../services/router';
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

function renderPlannerPrompt(message = 'Elige tu origen y destino para encontrar la mejor ruta en TransMilenio y SITP.'): void {
  const resultsContainer = document.getElementById('planner-results');
  if (!resultsContainer) return;

  resultsContainer.innerHTML = `
    <div class="planner-empty-state">
      <div class="card-empty-title">Planifica tu viaje</div>
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

/**
 * Initializes the Journey Planner UI controllers.
 */
export function initPlanner(
  map: maplibregl.Map,
  routes: RouteListItem[]
): void {
  mapInstance = map;

  // Initialize routing graph
  initRouter(routes);

  // Setup panel tab controls
  initTabs();

  // Setup input autocompletes and buttons
  initInputHandlers();

  // Setup map click listener for picking coordinates
  initMapClickListener();
}

/**
 * Switch tabs between Route Exploration and Journey Planning.
 */
function initTabs(): void {
  const tabExplore = document.getElementById('tab-explore')!;
  const tabPlanner = document.getElementById('tab-planner')!;
  const explorePanel = document.getElementById('explore-panel')!;
  const plannerPanel = document.getElementById('planner-panel')!;

  tabExplore.addEventListener('click', () => {
    // Close card balance panel if open
    const sidebar = document.getElementById('sidebar')!;
    if (sidebar.classList.contains('card-open')) {
      document.getElementById('card-detail-close')?.click();
    }

    tabExplore.classList.add('active');
    tabPlanner.classList.remove('active');
    explorePanel.classList.remove('hidden');
    plannerPanel.classList.add('hidden');
    setMapPickMode(null);
    
    // Clear active journey highlights from map when leaving planner
    clearJourneyPath(mapInstance);
    
    // Restore sidebar details overlay if a route was active
    if (sidebar.classList.contains('detail-open')) {
      document.getElementById('route-detail')?.classList.remove('hidden');
    }
  });

  tabPlanner.addEventListener('click', () => {
    // Close card balance panel if open
    const sidebar = document.getElementById('sidebar')!;
    if (sidebar.classList.contains('card-open')) {
      document.getElementById('card-detail-close')?.click();
    }

    tabPlanner.classList.add('active');
    tabExplore.classList.remove('active');
    plannerPanel.classList.remove('hidden');
    explorePanel.classList.add('hidden');
    
    // Hide standard route details overlay when entering planner
    document.getElementById('route-detail')?.classList.add('hidden');
    
    // Redraw current selected journey plan if available
    if (activePlanIndex !== null && calculatedPlans[activePlanIndex]) {
      drawJourneyPath(mapInstance, calculatedPlans[activePlanIndex]);
    }
  });
}

function setMapPickMode(mode: 'origin' | 'destination' | null): void {
  mapPickMode = mode;
  mapInstance.getCanvas().style.cursor = mode ? 'crosshair' : '';
  updateMapPickButton('origin', mode === 'origin');
  updateMapPickButton('destination', mode === 'destination');
  updateMapPickHint(mode);
}

function initMapClickListener(): void {
  mapInstance.on('click', (e) => {
    if (!mapPickMode) return;

    const coord: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    setEndpointSelection(mapPickMode, `Punto en mapa: ${coord[0].toFixed(5)}, ${coord[1].toFixed(5)}`, coord);

    setMapPickMode(null);
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

    try {
      // Query local lookup + Nominatim + ArcGIS geocoder proxy
      const res = await api.geocodeAddress(trimmed);
      if (!isCurrentRequest()) return;
      if (!res.success || !res.candidates || res.candidates.length === 0) {
        dropdown.innerHTML = `<div class="autocomplete-item"><div class="autocomplete-name">Sin resultados</div></div>`;
        dropdown.classList.remove('hidden');
        return;
      }

      dropdown.innerHTML = res.candidates
        .map((c: any) => {
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
          const name = data.dataset.name!;
          const lat = Number(data.dataset.lat!);
          const lon = Number(data.dataset.lon!);
          const code = data.dataset.code;

          onSelect(name, [lon, lat], code || undefined);
          dropdown.classList.add('hidden');
        });
        });
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error('[Planner] Geocode lookup error:', err);
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
        <div class="card-empty-title">Estás muy cerca</div>
        <div class="card-empty-text">El origen y el destino están en el mismo lugar. ¡Corta caminata!</div>
      </div>
    `;
    return;
  }

  btnCalculate.classList.add('loading');
  resultsContainer.innerHTML = `
    <div class="planner-empty-state">
      <span class="footer-action-spinner visible" aria-hidden="true"></span>
      <div class="card-empty-title" style="margin-top: 10px;">Calculando la mejor ruta...</div>
      <div class="card-empty-text">Buscando conexiones en TransMilenio y SITP.</div>
    </div>
  `;

  // Read configurations
  const mode = (document.getElementById('plan-transport-mode') as HTMLSelectElement).value as 'mix' | 'troncal' | 'zonal';
  const preference = (document.getElementById('plan-preference') as HTMLSelectElement).value as 'transfers' | 'time' | 'walk';
  const minWalk = preference === 'walk';
  const sortBy = preference;

  window.setTimeout(() => {
    if (requestId !== plannerRequestSeq) {
      btnCalculate.classList.remove('loading');
      return;
    }

    try {
      calculatedPlans = findRoutes({
        origin: originCoord!,
        destination: destCoord!,
        originStopCode,
        destStopCode,
        mode,
        minWalk,
        sortBy,
      });

      btnCalculate.classList.remove('loading');
      renderResults(calculatedPlans);
      
      // Asynchronously load real street-level walking paths from OSRM
      enrichWalkingGeometries(calculatedPlans, requestId).catch(err => {
        console.error('[Planner] Failed walking enrichment:', err);
      });
    } catch (err) {
      if (requestId !== plannerRequestSeq) return;
      console.error('[Planner] Calculation failed:', err);
      btnCalculate.classList.remove('loading');
      resultsContainer.innerHTML = `
        <div class="planner-empty-state">
          <div class="card-empty-title" style="color: var(--tm-red-light);">Error de cálculo</div>
          <div class="card-empty-text">Ocurrió un error al buscar las rutas. Inténtalo de nuevo.</div>
        </div>
      `;
    }
  }, 100);
}

function renderResults(plans: JourneyPlan[], preserveSelection = false): void {
  const container = document.getElementById('planner-results')!;
  
  if (plans.length === 0) {
    container.innerHTML = `
      <div class="planner-empty-state">
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
  if (window.innerWidth <= 768) {
    const bottomPadding = sidebarCollapsed
      ? 36
      : Math.round(Math.min(Math.max(window.innerHeight * 0.5, 260), window.innerHeight * 0.64));
    return {
      top: 52,
      bottom: bottomPadding,
      left: 28,
      right: 28,
    };
  }

  return {
    top: 60,
    bottom: 60,
    left: sidebarCollapsed ? 72 : 400,
    right: 60,
  };
}

async function enrichWalkingGeometries(plans: JourneyPlan[], requestId: number): Promise<void> {
  const promises: Promise<void>[] = [];

  plans.forEach((plan) => {
    plan.steps.forEach((step) => {
      if (step.type === 'walk' && step.path && step.path.length === 2) {
        if (isTunnelTransfer(step.fromCode, step.toCode)) {
          // Keep straight line geometry, distance, and time for tunnel transfers
          step.isTunnel = true;
          return;
        }
        const [from, to] = step.path;
        const p = fetchWalkingPath(from, to).then((res) => {
          if (requestId !== plannerRequestSeq || plans !== calculatedPlans) return;
          step.path = res.coordinates;
          step.distance = res.distance;
          step.time = res.time;
        });
        promises.push(p);
      }
    });
  });

  if (promises.length === 0) return;

  try {
    await Promise.all(promises);
    if (requestId !== plannerRequestSeq || plans !== calculatedPlans) return;
    
    // Recalculate totals for all plans
    plans.forEach((plan) => {
      plan.walkDistance = Math.round(plan.steps.reduce((sum, s) => sum + (s.type === 'walk' ? s.distance : 0), 0));
      plan.totalTime = Math.round(plan.steps.reduce((sum, s) => sum + s.time, 0));
    });

    // Re-render UI and update map preserving active selection
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
              <div class="journey-step-desc">Aprox. <strong>${Math.round(step.distance)} m</strong> (${Math.round(step.time)} min)</div>
            </div>
          </div>
        `;
      } else {
        // Ride step
        const routeColor = segmentColors[i];
        const accentStyle = `color:${safeColor(routeColor)};font-weight:800;`;
        
        const isTroncal = step.routeType === 'troncal';
        const systemName = isTroncal ? 'TransMilenio' : 'SITP Zonal';
        const stopLabel = isTroncal ? 'Estación' : 'Paradero';

        const stopsToggleHtml = step.stops && step.stops.length > 0
          ? `
            <button type="button" class="journey-step-substops-btn" data-step-index="${i}" aria-expanded="false">
              <span>👁 Ver ${step.stops.length} ${step.stops.length === 1 ? 'estación intermedia' : 'estaciones intermedias'}</span>
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
                Abordar <span style="${accentStyle}">${escapeHTML(step.routeCode)}</span>
              </div>
              <div class="journey-step-desc">
                En ${stopLabel} <strong>${escapeHTML(step.fromName)}</strong> (Dirección ${escapeHTML(step.toName)})<br/>
                Viajar <strong>${step.stopCount} ${step.stopCount === 1 ? 'estación' : 'estaciones'}</strong> (${Math.round(step.time)} min) · ${systemName}
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
      const text = planStep.stops?.length === 1 ? 'estación intermedia' : 'estaciones intermedias';

      labelSpan.textContent = isHidden
        ? `👁 Ver ${planStep.stops?.length} ${text}`
        : `✕ Ocultar ${planStep.stops?.length} ${text}`;
    });
  });
}
