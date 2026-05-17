/**
 * Sidebar UI controller.
 * Manages route list, search, filters, and detail panel.
 */
let allRoutes = [];
let selectedRouteCode = null;
let onRouteSelect = null;
let onRouteDeselect = null;
let onLayerToggle = null;
// ─── Initialize ───────────────────────────────────────────
export function initSidebar(options) {
    onRouteSelect = options.onRouteSelect;
    onRouteDeselect = options.onRouteDeselect;
    onLayerToggle = options.onLayerToggle;
    // Sidebar toggle
    const toggleBtn = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
    });
    // Search
    const searchInput = document.getElementById('search-input');
    const searchClear = document.getElementById('search-clear');
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
    // Layer toggles
    document.querySelectorAll('.toggle-item input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const checkbox = e.target;
            const layer = checkbox.dataset.layer;
            onLayerToggle?.(layer, checkbox.checked);
        });
    });
    // Detail panel close
    const detailClose = document.getElementById('route-detail-close');
    detailClose.addEventListener('click', () => {
        closeRouteDetail();
        onRouteDeselect?.();
    });
}
// ─── Populate Route List ──────────────────────────────────
export function setRoutes(routes) {
    allRoutes = routes.sort((a, b) => {
        // Troncal first, then by code
        if (a.type !== b.type)
            return a.type === 'troncal' ? -1 : 1;
        return a.code.localeCompare(b.code);
    });
    renderRouteList(allRoutes);
}
function filterRoutes(query) {
    if (!query) {
        renderRouteList(allRoutes);
        return;
    }
    const q = query.toLowerCase();
    const filtered = allRoutes.filter((r) => r.code.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.origin.toLowerCase().includes(q) ||
        r.destination.toLowerCase().includes(q) ||
        (r.operator && r.operator.toLowerCase().includes(q)));
    renderRouteList(filtered);
}
function renderRouteList(routes) {
    const container = document.getElementById('route-list');
    const countEl = document.getElementById('route-list-count');
    countEl.textContent = `${routes.length} resultados`;
    if (routes.length === 0) {
        container.innerHTML = `
      <div style="text-align:center;padding:40px 16px;color:var(--text-tertiary)">
        <div style="font-size:32px;margin-bottom:8px">🔍</div>
        <div style="font-size:var(--font-size-sm)">No se encontraron rutas</div>
      </div>
    `;
        return;
    }
    // Only render first 200 for performance
    const visible = routes.slice(0, 200);
    container.innerHTML = visible
        .map((r) => `
    <div class="route-item ${selectedRouteCode === r.code ? 'active' : ''}"
         data-code="${r.code}" data-type="${r.type}" data-id="${r.id}">
      <span class="route-item-badge ${r.type}">${r.code}</span>
      <div class="route-item-info">
        <div class="route-item-name">${r.origin} → ${r.destination}</div>
        <div class="route-item-meta">${r.busType || r.operator || r.type}</div>
      </div>
    </div>
  `)
        .join('');
    if (routes.length > 200) {
        container.innerHTML += `
      <div style="text-align:center;padding:16px;color:var(--text-tertiary);font-size:var(--font-size-xs)">
        Mostrando 200 de ${routes.length} rutas. Usa la búsqueda para filtrar.
      </div>
    `;
    }
    // Attach click handlers
    container.querySelectorAll('.route-item').forEach((el) => {
        el.addEventListener('click', () => {
            const code = el.dataset.code;
            const id = el.dataset.id;
            const route = allRoutes.find((r) => r.id === id);
            if (route)
                selectRoute(route);
        });
    });
}
// ─── Route Selection ──────────────────────────────────────
function selectRoute(route) {
    selectedRouteCode = route.code;
    showRouteDetail(route);
    onRouteSelect?.(route);
    // Update active state in list
    document.querySelectorAll('.route-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.code === route.code);
    });
}
// ─── Route Detail Panel ──────────────────────────────────
function showRouteDetail(route) {
    const panel = document.getElementById('route-detail');
    const content = document.getElementById('route-detail-content');
    const isTroncal = route.type === 'troncal';
    content.innerHTML = `
    <div class="detail-header">
      <div class="detail-badge ${route.type}">${route.code}</div>
      <div class="detail-name">${route.origin} → ${route.destination}</div>
      <div class="detail-subtitle">${isTroncal ? 'Ruta Troncal' : 'Ruta Zonal SITP'}</div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Recorrido</div>
      <div class="detail-endpoints">
        <div class="detail-endpoint">
          <div class="detail-endpoint-dot origin"></div>
          <div>
            <div class="detail-endpoint-text">${route.origin}</div>
            <div class="detail-endpoint-label">Origen</div>
          </div>
        </div>
        <div class="detail-endpoint">
          <div class="detail-endpoint-dot destination"></div>
          <div>
            <div class="detail-endpoint-text">${route.destination}</div>
            <div class="detail-endpoint-label">Destino</div>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Detalles</div>
      ${route.busType ? `<div class="detail-row"><span class="detail-row-label">Tipo de bus</span><span class="detail-row-value">${route.busType}</span></div>` : ''}
      ${route.schedule ? `<div class="detail-row"><span class="detail-row-label">Horario L-V</span><span class="detail-row-value">${route.schedule}</span></div>` : ''}
      ${route.operator ? `<div class="detail-row"><span class="detail-row-label">Operador</span><span class="detail-row-value">${route.operator}</span></div>` : ''}
      ${route.length ? `<div class="detail-row"><span class="detail-row-label">Longitud</span><span class="detail-row-value">${route.length.toFixed(1)} km</span></div>` : ''}
      <div class="detail-row"><span class="detail-row-label">Sistema</span><span class="detail-row-value">${isTroncal ? 'TransMilenio Troncal' : 'SITP Zonal'}</span></div>
    </div>
  `;
    panel.classList.remove('hidden');
}
function closeRouteDetail() {
    const panel = document.getElementById('route-detail');
    panel.classList.add('hidden');
    selectedRouteCode = null;
    document.querySelectorAll('.route-item').forEach((el) => {
        el.classList.remove('active');
    });
}
// ─── Update Counts ────────────────────────────────────────
export function updateCounts(counts) {
    document.getElementById('count-troncal').textContent = counts.troncal.toString();
    document.getElementById('count-zonal').textContent = counts.zonal.toString();
    document.getElementById('count-stations').textContent = counts.stations.toString();
    document.getElementById('count-stops').textContent = counts.stops.toString();
    document.getElementById('stat-routes').textContent = (counts.troncal + counts.zonal).toString();
    document.getElementById('stat-stations').textContent = counts.stations.toString();
    document.getElementById('stat-stops').textContent = counts.stops.toString();
}
