/** Human formatting helpers (Spanish, Bogotá). */

// Distance/walk math is the website's, verbatim — re-exported rather than
// re-implemented so a change to the walking speed or the rounding lands in both
// clients at once (spec §5.2.1b: the app reuses the website's data layer via
// `@shared`; spec §1.1 R2: no duplicated logic).
export { formatDistance, haversineMeters, walkMinutes } from '@shared/utils/geo';

export function formatClock(d = new Date()): string {
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function greeting(d = new Date()): string {
  const hh = d.getHours();
  if (hh < 5) return 'Buenas noches';
  if (hh < 12) return 'Buenos días';
  if (hh < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Whether a hex color is light enough to need dark text on top. */
export function needsDarkText(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // Relative luminance (sRGB) — light backgrounds want dark ink.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 165;
}

/** rgba() string from a #rrggbb hex + alpha. */
export function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(227,52,47,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
