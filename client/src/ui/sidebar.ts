/**
 * Sidebar UI controller.
 * Manages route list, search, filters, and detail panel.
 */

import type { RouteListItem } from '../types/transmilenio';
import { escapeHTML, safeColor } from '../utils/html';

let allRoutes: RouteListItem[] = [];
let selectedRouteId: string | null = null;
let onRouteSelect: ((route: RouteListItem) => void) | null = null;
let onRouteDeselect: (() => void) | null = null;
let onLayerToggle: ((layer: string, visible: boolean) => void) | null = null;

export function initSidebar(options: {
  onRouteSelect: (route: RouteListItem) => void;
  onRouteDeselect: () => void;
  onLayerToggle: (layer: string, visible: boolean) => void;
}): void {
  onRouteSelect = options.onRouteSelect;
  onRouteDeselect = options.onRouteDeselect;
  onLayerToggle = options.onLayerToggle;

  const toggleBtn = document.getElementById('sidebar-toggle')!;
  const sidebar = document.getElementById('sidebar')!;
  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });

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

  document.querySelectorAll('.toggle-item input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const checkbox = e.target as HTMLInputElement;
      const layer = checkbox.dataset.layer!;
      onLayerToggle?.(layer, checkbox.checked);
    });
  });

  const detailClose = document.getElementById('route-detail-close')!;
  detailClose.addEventListener('click', () => {
    closeRouteDetail();
    onRouteDeselect?.();
  });
}

export function setRoutes(routes: RouteListItem[]): void {
  allRoutes = routes.sort((a, b) => {
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
      r.destination.toLowerCase().includes(q) ||
      (r.operator && r.operator.toLowerCase().includes(q))
  );

  renderRouteList(filtered);
}

function renderRouteList(routes: RouteListItem[]): void {
  const container = document.getElementById('route-list')!;
  const countEl = document.getElementById('route-list-count')!;

  countEl.textContent = `${routes.length} resultados`;

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
      const badgeColor = route.color ? safeColor(route.color) : '';
      const badgeStyle = badgeColor ? `background:${badgeColor};border-color:${badgeColor};color:#fff;` : '';

      return `
        <div class="route-item ${selectedRouteId === route.id ? 'active' : ''}"
             data-type="${route.type}"
             data-id="${escapeHTML(route.id)}">
          <span class="route-item-badge ${route.type}" style="${badgeStyle}">${escapeHTML(route.code)}</span>
          <div class="route-item-info">
            <div class="route-item-name">${escapeHTML(route.origin)} -> ${escapeHTML(route.destination)}</div>
            <div class="route-item-meta">${escapeHTML(route.busType || route.operator || route.type)}</div>
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

function showRouteDetail(route: RouteListItem): void {
  const panel = document.getElementById('route-detail')!;
  const content = document.getElementById('route-detail-content')!;
  const isTroncal = route.type === 'troncal';
  const badgeColor = route.color ? safeColor(route.color) : '';

  content.innerHTML = `
    <div class="detail-header">
      <div class="detail-badge ${route.type}" style="${badgeColor ? `background:${badgeColor};color:#fff;` : ''}">${escapeHTML(route.code)}</div>
      <div class="detail-name">${escapeHTML(route.origin)} -> ${escapeHTML(route.destination)}</div>
      <div class="detail-subtitle">${isTroncal ? 'Ruta Troncal' : 'Ruta Zonal SITP'}</div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Recorrido</div>
      <div class="detail-endpoints">
        <div class="detail-endpoint">
          <div class="detail-endpoint-dot origin"></div>
          <div>
            <div class="detail-endpoint-text">${escapeHTML(route.origin)}</div>
            <div class="detail-endpoint-label">Origen</div>
          </div>
        </div>
        <div class="detail-endpoint">
          <div class="detail-endpoint-dot destination"></div>
          <div>
            <div class="detail-endpoint-text">${escapeHTML(route.destination)}</div>
            <div class="detail-endpoint-label">Destino</div>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Detalles</div>
      ${route.busType ? `<div class="detail-row"><span class="detail-row-label">Tipo de bus</span><span class="detail-row-value">${escapeHTML(route.busType)}</span></div>` : ''}
      ${route.schedule ? `<div class="detail-row"><span class="detail-row-label">Horario L-V</span><span class="detail-row-value">${escapeHTML(route.schedule)}</span></div>` : ''}
      ${route.operator ? `<div class="detail-row"><span class="detail-row-label">Operador</span><span class="detail-row-value">${escapeHTML(route.operator)}</span></div>` : ''}
      ${route.length ? `<div class="detail-row"><span class="detail-row-label">Longitud</span><span class="detail-row-value">${route.length.toFixed(1)} km</span></div>` : ''}
      <div class="detail-row"><span class="detail-row-label">Sistema</span><span class="detail-row-value">${isTroncal ? 'TransMilenio Troncal' : 'SITP Zonal'}</span></div>
    </div>
  `;

  panel.classList.remove('hidden');
}

function closeRouteDetail(): void {
  const panel = document.getElementById('route-detail')!;
  panel.classList.add('hidden');
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
