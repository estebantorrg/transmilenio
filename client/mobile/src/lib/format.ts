/** Human formatting helpers (Spanish, Bogotá). */

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '';
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

/** Rough walking time at ~1.35 m/s. */
export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / 1.35 / 60));
}

export function formatClock(d = new Date()): string {
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function relativeTime(ms: number): string {
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 5) return 'ahora';
  if (secs < 60) return `hace ${secs} s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  return `hace ${Math.round(mins / 60)} h`;
}

export function greeting(d = new Date()): string {
  const hh = d.getHours();
  if (hh < 5) return 'Buenas noches';
  if (hh < 12) return 'Buenos días';
  if (hh < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const la1 = a[1] * rad;
  const la2 = b[1] * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
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
