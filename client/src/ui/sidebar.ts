/**
 * Sidebar UI controller.
 * Manages route list, search, filters, and detail panel.
 */

import type { RouteListItem } from '../types/transmilenio';
import { escapeHTML, safeColor } from '../utils/html';
import { getRouteAccentColor, isAlimentadorRoute } from '../utils/routeColors';
import { api, type CardBalanceRead, type CardBalanceMovement } from '../services/api';

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

function setSidebarCollapsed(collapsed: boolean): void {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle') as HTMLButtonElement | null;
  const floatingBtn = document.getElementById('sidebar-fab') as HTMLButtonElement | null;
  if (!sidebar) return;

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
  setSidebarCollapsed(sidebar.classList.contains('collapsed'));

  toggleBtn.addEventListener('click', () => {
    setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
  });
  floatingBtn?.addEventListener('click', () => setSidebarCollapsed(false));

  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const searchClear = document.getElementById('search-clear')!;

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    searchClear.classList.toggle('hidden', !query);
    filterRoutes(query);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.add('hidden');
    filterRoutes('');
  });

  document.querySelectorAll('.toggle-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      // If the target is the checkbox itself, the 'change' event will handle it.
      // If the target is a span or text, we let label behavior toggle the checkbox.
      // We listen to 'change' on the checkbox for the actual logic.
    });

    const cb = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (cb) {
      cb.addEventListener('change', () => {
        const layer = cb.dataset.layer!;
        onLayerToggle?.(layer, cb.checked);
      });
    }
  });

  const detailClose = document.getElementById('route-detail-close')!;
  detailClose.addEventListener('click', () => {
    closeRouteDetail();
    onRouteDeselect?.();
  });

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
}

export function setRoutes(routes: RouteListItem[]): void {
  allRoutes = [...routes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'troncal' ? -1 : 1;
    return a.code.localeCompare(b.code, undefined, { numeric: true });
  });

  renderRouteList(allRoutes);
}

function filterRoutes(query: string): void {
  if (!query) {
    renderRouteList(allRoutes);
    return;
  }

  const q = query.toLowerCase();
  const filtered = allRoutes.filter(
    (r) =>
      r.code.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      r.origin.toLowerCase().includes(q) ||
      r.destination.toLowerCase().includes(q)
  );

  renderRouteList(filtered);
}

function renderRouteList(routes: RouteListItem[]): void {
  const container = document.getElementById('route-list')!;
  const countEl = document.getElementById('route-list-count')!;

  countEl.textContent = `${routes.length}`;

  if (routes.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Sin rutas</div>
        <div class="empty-state-text">Prueba con otro codigo, estacion o destino.</div>
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

      return `
        <div class="route-item ${selectedRouteId === route.id ? 'active' : ''}"
             data-type="${route.type}"
             data-id="${escapeHTML(route.id)}">
          <span class="route-item-badge" style="${badgeStyle}">${escapeHTML(route.code)}</span>
          <div class="route-item-info">
            <div class="route-item-name">${escapeHTML(route.name)}</div>
            <div class="route-item-meta">
              <span class="route-item-type">${escapeHTML(routeTypeLabel(route))}</span>
              <span class="route-item-endpoints">${escapeHTML(endpointText)}</span>
            </div>
          </div>
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

  container.querySelectorAll('.route-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.id!;
      const route = allRoutes.find((item) => item.id === id);
      if (route) selectRoute(route);
    });
  });
}

function selectRoute(route: RouteListItem): void {
  selectedRouteId = route.id;
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
  setSidebarCollapsed(false);
  const isTroncal = route.type === 'troncal';
  const routeKindLabel = route.subType === 'dual' ? 'Ruta Dual' : isTroncal ? 'Ruta Troncal' : 'Ruta Zonal SITP';
  const badgeColor = safeColor(getRouteAccentColor(route));
  const scheduleHtml = formatSchedule(route.schedule);

  content.innerHTML = `
    <div class="detail-header">
      <div class="detail-badge ${route.type}" style="background:${badgeColor};color:#fff;">${escapeHTML(route.code)}</div>
      <div class="detail-name">${escapeHTML(route.origin)} -> ${escapeHTML(route.destination)}</div>
      <div class="detail-subtitle">${routeKindLabel}</div>
      <div id="live-tracking-status" class="live-tracking-status">
        <div class="live-card-main">
          <span class="live-status-dot pulse loading"></span>
          <span class="live-status-text">Conectando con buses en vivo...</span>
        </div>
        <span class="live-status-chip loading">Buscando…</span>
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

  sidebar.classList.add('detail-open');
  panel.classList.remove('hidden');

  // Switch to explore tab if route is selected
  const tabExplore = document.getElementById('tab-explore');
  if (tabExplore && !tabExplore.classList.contains('active')) {
    tabExplore.click();
  }
}

export function updateLiveBusStatus(count: number, status: 'loading' | 'success' | 'empty' | 'error' | 'stale', asOf?: number): void {
  const card = document.getElementById('live-tracking-status');
  const dotEl = card?.querySelector('.live-status-dot');
  const textEl = card?.querySelector('.live-status-text');
  const chipEl = card?.querySelector('.live-status-chip');

  if (!dotEl || !textEl || !chipEl) return;

  // Reset state classes
  dotEl.className = 'live-status-dot';
  chipEl.className = 'live-status-chip';

  switch (status) {
    case 'loading':
      dotEl.classList.add('pulse', 'loading');
      chipEl.classList.add('loading');
      textEl.textContent = 'Conectando con buses en vivo...';
      chipEl.textContent = 'Buscando…';
      break;
    case 'success':
      // Truthful state: buses ARE live. We have no schedule-adherence data, so
      // the chip reports liveness/count, never fake punctuality.
      dotEl.classList.add('pulse');
      chipEl.classList.add('success');
      textEl.textContent = `Rastreando ${count} bus${count > 1 ? 'es' : ''} en vivo`;
      chipEl.textContent = `${count} en vivo`;
      break;
    case 'empty':
      dotEl.classList.add('empty');
      chipEl.classList.add('empty');
      textEl.textContent = 'Sin buses activos en este momento';
      chipEl.textContent = 'Sin buses';
      break;
    case 'error':
      dotEl.classList.add('error');
      chipEl.classList.add('error');
      textEl.textContent = 'No se pudo conectar con el rastreo en vivo';
      chipEl.textContent = 'Sin señal';
      break;
    case 'stale': {
      // Cached positions served during an upstream outage.
      dotEl.classList.add('stale');
      chipEl.classList.add('stale');
      const at = typeof asOf === 'number'
        ? new Date(asOf).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
        : '';
      textEl.textContent = at
        ? `Mostrando ${count} bus${count > 1 ? 'es' : ''} (datos de ${at})`
        : `Mostrando ${count} bus${count > 1 ? 'es' : ''} (datos recientes)`;
      chipEl.textContent = 'Demorado';
      break;
    }
  }
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

  document.querySelectorAll('.route-item').forEach((el) => {
    el.classList.remove('active');
  });
}

export function updateCounts(counts: {
  troncal: number;
  zonal: number;
  stations: number;
  stops: number;
}): void {
  document.getElementById('count-troncal')!.textContent = counts.troncal.toString();
  document.getElementById('count-zonal')!.textContent = counts.zonal.toString();
  document.getElementById('count-stations')!.textContent = counts.stations.toString();
  document.getElementById('count-stops')!.textContent = counts.stops.toString();
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
