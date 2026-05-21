/**
 * Sidebar UI controller.
 * Manages route list, search, filters, and detail panel.
 */

import type { RouteListItem } from '../types/transmilenio';
import { escapeHTML, safeColor } from '../utils/html';
import { getRouteAccentColor } from '../utils/routeColors';

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
      const badgeColor = safeColor(getRouteAccentColor(route));
      const badgeStyle = `background:${badgeColor};border-color:${badgeColor};color:#fff;`;

      return `
        <div class="route-item ${selectedRouteId === route.id ? 'active' : ''}"
             data-type="${route.type}"
             data-id="${escapeHTML(route.id)}">
          <span class="route-item-badge ${route.subType || route.type}" style="${badgeStyle}">${escapeHTML(route.code)}</span>
          <div class="route-item-info">
            <div class="route-item-name">${escapeHTML(route.name)}</div>
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

function showRouteDetail(route: RouteListItem): void {
  const panel = document.getElementById('route-detail')!;
  const content = document.getElementById('route-detail-content')!;
  const sidebar = document.getElementById('sidebar')!;
  const isTroncal = route.type === 'troncal';
  const badgeColor = safeColor(getRouteAccentColor(route));
  const scheduleHtml = formatSchedule(route.schedule);

  content.innerHTML = `
    <div class="detail-header">
      <div class="detail-badge ${route.type}" style="background:${badgeColor};color:#fff;">${escapeHTML(route.code)}</div>
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
      ${route.operator ? `<div class="detail-row"><span class="detail-row-label">Operador</span><span class="detail-row-value">${escapeHTML(route.operator)}</span></div>` : ''}
      ${route.length ? `<div class="detail-row"><span class="detail-row-label">Longitud</span><span class="detail-row-value">${route.length.toFixed(1)} km</span></div>` : ''}
      <div class="detail-row"><span class="detail-row-label">Sistema</span><span class="detail-row-value">${isTroncal ? 'TransMilenio Troncal' : 'SITP Zonal'}</span></div>
    </div>
    
    ${scheduleHtml ? `
    <div class="detail-section">
      <div class="detail-section-title">Horario</div>
      ${scheduleHtml}
    </div>` : ''}
  `;

  sidebar.classList.add('detail-open');
  panel.classList.remove('hidden');
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
