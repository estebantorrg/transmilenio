/**
 * Shared real-time "próximos a llegar" renderer for stop popups (spec §5.8).
 *
 * Used by BOTH the zonal-paradero popup (`stops.ts`) and the troncal-estación
 * popup (`stations.ts`) so the feature is global and the two never drift
 * (spec §1.1 R2). Given a stop CODE (cenefa or TM… estación code) it asks the
 * server which serving routes have a live bus inbound and how long away, then
 * lists each as e.g. "H75 → Portal Tunal · Llegada en aprox. 5 min".
 */

import { api } from '../services/api';
import { escapeHTML, safeColor } from '../utils/html';
import { getStopTagColor } from '../utils/routeColors';

/** The `<div class="popup-arrivals">` slot to embed in a popup for `code`. */
export function arrivalsSectionHtml(code: string): string {
  if (!code) return '';
  return `<div class="popup-arrivals" data-arr-code="${escapeHTML(code)}"><div class="arr-loading">Buscando llegadas…</div></div>`;
}

/** Human ETA phrase for one route's nearest approaching bus. */
function etaText(etaMinutes: number, distanceMeters: number): string {
  if (etaMinutes <= 0) {
    return distanceMeters <= 150 ? 'Llegando' : 'Menos de 1 min';
  }
  if (etaMinutes === 1) return 'Llegada en aprox. 1 min';
  return `Llegada en aprox. ${etaMinutes} min`;
}

/**
 * Fetch + render arrivals into the open popup slot for `code`. Re-queries the
 * DOM after the await so a popup swapped mid-flight isn't overwritten. Never
 * throws — an outage renders a quiet "no disponible" line.
 */
export async function renderStopArrivals(code: string): Promise<void> {
  if (!code) return;
  const sel = `.popup-arrivals[data-arr-code="${CSS.escape(code)}"]`;
  if (!document.querySelector(sel)) return;

  try {
    const res = await api.getStopArrivals(code);
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return; // popup changed while in flight

    const arrivals = res.arrivals ?? [];
    if (arrivals.length === 0) {
      el.innerHTML = `<div class="arr-empty">Sin buses en aproximación ahora</div>`;
      return;
    }

    el.innerHTML =
      `<div class="popup-routes-label">Próximos a llegar<span class="popup-count">${arrivals.length}</span></div>` +
      arrivals
        .slice(0, 8)
        .map((a) => {
          const color = safeColor(getStopTagColor(a.codigo, a.color), '#00608B');
          const dest = a.destino ? `→ ${escapeHTML(a.destino)}` : '';
          return `
        <div class="arr-row">
          <span class="arr-badge" style="background:${color}">${escapeHTML(a.codigo)}</span>
          <div class="arr-body">
            ${dest ? `<div class="arr-dest">${dest}</div>` : ''}
            <div class="arr-eta">${escapeHTML(etaText(a.etaMinutes, a.distanceMeters))}</div>
          </div>
        </div>`;
        })
        .join('');
  } catch {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) el.innerHTML = `<div class="arr-empty">Llegadas no disponibles</div>`;
  }
}
