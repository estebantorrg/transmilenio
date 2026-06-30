import { escapeHTML } from '../utils/html';

/**
 * Renders the "Desde aquí / Hasta aquí" action row shown in station and stop
 * popups. The buttons carry the point's name, coordinate and (optional) catalog
 * code as data attributes; a single delegated handler in `main.ts` forwards the
 * click to the journey planner (`planFromPopup`). Returns '' for an invalid
 * coordinate so callers can append unconditionally.
 */
export function planActionsHtml(
  name: string,
  coordinate: [number, number],
  code?: string
): string {
  const [lng, lat] = coordinate;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return '';

  const data =
    `data-plan-name="${escapeHTML(name)}" ` +
    `data-plan-lng="${lng}" data-plan-lat="${lat}" ` +
    `data-plan-code="${escapeHTML(code || '')}"`;

  return `
    <div class="popup-actions">
      <button type="button" class="popup-plan-btn" data-plan-role="origin" ${data} title="Planear viaje desde aquí">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>
        Desde aquí
      </button>
      <button type="button" class="popup-plan-btn" data-plan-role="destination" ${data} title="Planear viaje hasta aquí">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
        Hasta aquí
      </button>
    </div>
  `;
}
