import maplibregl from 'maplibre-gl';
import { api } from '../services/api';
import { findRoutes, getDistance, initRouter, fetchWalkingPath, isTunnelTransfer, type JourneyPlan, type JourneyStep } from '../services/router';
import { drawJourneyPath, clearJourneyPath, assignSegmentColors } from '../layers/journeyLayer';
import { escapeHTML, safeColor } from '../utils/html';
import { getRouteAccentColor } from '../utils/routeColors';
import type { RouteListItem } from '../types/transmilenio';

let mapInstance: maplibregl.Map;
let rawRoutes: RouteListItem[] = [];

// Selection states
let originCoord: [number, number] | null = null;
let originStopCode: string | undefined = undefined;

let destCoord: [number, number] | null = null;
let destStopCode: string | undefined = undefined;

let mapPickMode: 'origin' | 'destination' | null = null;
let activePlanIndex: number | null = null;
let calculatedPlans: JourneyPlan[] = [];

/**
 * Initializes the Journey Planner UI controllers.
 */
export function initPlanner(
  map: maplibregl.Map,
  routes: RouteListItem[],
  onStopSelect?: (stop: any, routeType: 'troncal' | 'zonal') => void
): void {
  mapInstance = map;
  rawRoutes = routes;

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
  if (mode) {
    mapInstance.getCanvas().style.cursor = 'crosshair';
    document.getElementById(`btn-${mode}-map`)?.classList.add('active');
  } else {
    mapInstance.getCanvas().style.cursor = '';
    document.getElementById('btn-origin-map')?.classList.remove('active');
    document.getElementById('btn-destination-map')?.classList.remove('active');
  }
}

function initMapClickListener(): void {
  mapInstance.on('click', (e) => {
    if (!mapPickMode) return;

    const coord: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const inputId = mapPickMode === 'origin' ? 'plan-origin-input' : 'plan-destination-input';
    const input = document.getElementById(inputId) as HTMLInputElement;

    if (input) {
      input.value = `Mapa: ${coord[0].toFixed(5)}, ${coord[1].toFixed(5)}`;
      if (mapPickMode === 'origin') {
        originCoord = coord;
        originStopCode = undefined;
      } else {
        destCoord = coord;
        destStopCode = undefined;
      }
      document.getElementById(`plan-${mapPickMode}-clear`)?.classList.remove('hidden');
    }

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
    originInput.value = '';
    originCoord = null;
    originStopCode = undefined;
    originClear.classList.add('hidden');
    originAutocomplete.classList.add('hidden');
    originInput.focus();
  });

  destClear.addEventListener('click', () => {
    destInput.value = '';
    destCoord = null;
    destStopCode = undefined;
    destClear.classList.add('hidden');
    destAutocomplete.classList.add('hidden');
    destInput.focus();
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
    query: string,
    dropdown: HTMLElement,
    onSelect: (name: string, coord: [number, number], code?: string) => void
  ) => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      dropdown.classList.add('hidden');
      return;
    }

    try {
      // Query local lookup + Nominatim + ArcGIS geocoder proxy
      const res = await api.geocodeAddress(trimmed);
      if (!res.success || !res.candidates || res.candidates.length === 0) {
        dropdown.innerHTML = `<div class="autocomplete-item"><div class="autocomplete-name">Sin resultados</div></div>`;
        dropdown.classList.remove('hidden');
        return;
      }

      dropdown.innerHTML = res.candidates
        .map((c: any) => {
          const typeClass = c.type === 'station' ? 'station' : c.type === 'stop' ? 'stop' : 'place';
          const icon = c.type === 'station' ? '🚇' : c.type === 'stop' ? '🚏' : '📍';
          const metaText = c.code ? `Código: ${c.code}` : `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`;
          return `
            <div class="autocomplete-item ${typeClass}" 
                 data-name="${escapeHTML(c.name)}" 
                 data-lat="${c.lat}" 
                 data-lon="${c.lon}" 
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
      console.error('[Planner] Geocode lookup error:', err);
    }
  };

  const debouncedOrigin = debounce((q: string) => {
    handleAutocomplete(q, originAutocomplete, (name, coord, code) => {
      originInput.value = name;
      originCoord = coord;
      originStopCode = code;
      originClear.classList.remove('hidden');
    });
  }, 300);

  const debouncedDest = debounce((q: string) => {
    handleAutocomplete(q, destAutocomplete, (name, coord, code) => {
      destInput.value = name;
      destCoord = coord;
      destStopCode = code;
      destClear.classList.remove('hidden');
    });
  }, 300);

  originInput.addEventListener('input', () => {
    originClear.classList.toggle('hidden', !originInput.value);
    debouncedOrigin(originInput.value);
  });

  destInput.addEventListener('input', () => {
    destClear.classList.toggle('hidden', !destInput.value);
    debouncedDest(destInput.value);
  });

  // 4. GPS buttons
  const handleGpsButton = async (
    btn: HTMLButtonElement,
    input: HTMLInputElement,
    clearBtn: HTMLElement,
    onSelect: (coord: [number, number]) => void
  ) => {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    input.value = 'Obteniendo ubicación actual...';

    try {
      const coord = await resolveLocation();
      input.value = 'Mi ubicación actual';
      clearBtn.classList.remove('hidden');
      onSelect([coord.longitude, coord.latitude]);
    } catch (err) {
      console.warn('[GPS] Failed to get user location:', err);
      input.value = 'No se pudo obtener ubicación';
      window.setTimeout(() => {
        if (input.value === 'No se pudo obtener ubicación') input.value = '';
      }, 3000);
    } finally {
      btn.classList.remove('loading');
    }
  };

  document.getElementById('btn-origin-gps')!.addEventListener('click', () => {
    const btn = document.getElementById('btn-origin-gps') as HTMLButtonElement;
    handleGpsButton(btn, originInput, originClear, (coord) => {
      originCoord = coord;
      originStopCode = undefined;
    });
  });

  document.getElementById('btn-destination-gps')!.addEventListener('click', () => {
    const btn = document.getElementById('btn-destination-gps') as HTMLButtonElement;
    handleGpsButton(btn, destInput, destClear, (coord) => {
      destCoord = coord;
      destStopCode = undefined;
    });
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

    originClear.classList.toggle('hidden', !originInput.value);
    destClear.classList.toggle('hidden', !destInput.value);
  });

  // 6. Calculate Route Button click
  btnCalculate.addEventListener('click', () => {
    calculateRoute();
  });
}

async function resolveLocation(): Promise<{ longitude: number; latitude: number }> {
  // Try GPS
  if ('geolocation' in navigator) {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 7000,
        });
      });
      return { longitude: pos.coords.longitude, latitude: pos.coords.latitude };
    } catch {
      /* fallback to geoip */
    }
  }

  // Fallback to IP GeoIP
  const geoip = await api.getGeoIp();
  if (geoip.success && geoip.longitude != null && geoip.latitude != null) {
    return { longitude: geoip.longitude, latitude: geoip.latitude };
  }

  throw new Error('Location lookup failed');
}

/**
 * Calculates paths using the local router.
 */
function calculateRoute(): void {
  const btnCalculate = document.getElementById('btn-calculate-route') as HTMLButtonElement;
  const resultsContainer = document.getElementById('planner-results')!;

  if (!originCoord || !destCoord) {
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
  const minWalk = (document.getElementById('plan-min-walk-checkbox') as HTMLInputElement).checked;

  window.setTimeout(() => {
    try {
      calculatedPlans = findRoutes({
        origin: originCoord!,
        destination: destCoord!,
        originStopCode,
        destStopCode,
        mode,
        minWalk,
      });

      btnCalculate.classList.remove('loading');
      renderResults(calculatedPlans);
      
      // Asynchronously load real street-level walking paths from OSRM
      enrichWalkingGeometries(calculatedPlans).catch(err => {
        console.error('[Planner] Failed walking enrichment:', err);
      });
    } catch (err) {
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
          <div id="journey-steps-${index}" class="journey-steps-list hidden"></div>
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
      
      // If clicking already active, just expand/collapse it
      if (activePlanIndex === idx) {
        const stepsContainer = document.getElementById(`journey-steps-${idx}`)!;
        stepsContainer.classList.toggle('hidden');
        return;
      }

      selectPlan(idx, cards);
    });
  });

  const selectIndex = (preserveSelection && activePlanIndex !== null && activePlanIndex < plans.length)
    ? activePlanIndex
    : 0;

  selectPlan(selectIndex, cards);
}

async function enrichWalkingGeometries(plans: JourneyPlan[]): Promise<void> {
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


function selectPlan(index: number, cards: NodeListOf<Element>): void {
  activePlanIndex = index;
  const plan = calculatedPlans[index];

  // Draw path on map
  drawJourneyPath(mapInstance, plan);

  // Zoom map to fit the calculated path bounds
  const bounds = new maplibregl.LngLatBounds();
  plan.steps.forEach((step) => {
    if (step.path) {
      step.path.forEach((coord) => bounds.extend(coord));
    }
  });
  const isMobile = window.innerWidth <= 768;
  mapInstance.fitBounds(bounds, {
    padding: isMobile
      ? { top: 60, bottom: 20, left: 30, right: 30 }
      : { top: 60, bottom: 60, left: 400, right: 60 },
    maxZoom: 15,
  });

  // Update card UI classes
  cards.forEach((card, i) => {
    card.classList.toggle('active', i === index);
    const stepsContainer = document.getElementById(`journey-steps-${i}`)!;
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
            <button class="journey-step-substops-btn" data-step-index="${i}">
              <span>👁 Ver ${step.stops.length} ${step.stops.length === 1 ? 'estación intermedia' : 'estaciones intermedias'}</span>
            </button>
            <ul id="substops-list-${i}" class="journey-step-substops-list hidden">
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
      const stepIdx = (btn as HTMLElement).dataset.stepIndex;
      const list = document.getElementById(`substops-list-${stepIdx}`)!;
      const labelSpan = btn.querySelector('span')!;
      
      const isHidden = list.classList.toggle('hidden');
      const planStep = plan.steps[Number(stepIdx)];
      const text = planStep.stops?.length === 1 ? 'estación intermedia' : 'estaciones intermedias';
      
      labelSpan.textContent = isHidden 
        ? `👁 Ver ${planStep.stops?.length} ${text}` 
        : `✕ Ocultar ${planStep.stops?.length} ${text}`;
    });
  });
}

function getRouteColorHex(routeCode: string, routeType?: 'troncal' | 'zonal'): string {
  if (routeCode === 'walking') return '#94A3B8';
  const dummyRoute: Partial<RouteListItem> = {
    code: routeCode,
    type: routeType || 'troncal',
  };
  return getRouteAccentColor(dummyRoute as RouteListItem);
}
