/**
 * Connectivity banner.
 *
 * The app is offline-capable by design — the catalog, POIs and demand data ship
 * inside the APK (spec §5.2.1b), so browsing routes, stops and schedules keeps
 * working with no signal. What does NOT work offline is everything live: bus
 * positions, arrivals, saldo. Without this banner each of those failed on its
 * own with a generic "no se pudo" toast and the rider had to infer the cause.
 *
 * Says it once, at the top, and gets out of the way when the connection is back.
 */

const OFFLINE_TEXT = 'Sin conexión · rutas y horarios siguen disponibles';
const BACK_ONLINE_TEXT = 'Conexión restablecida';
const BACK_ONLINE_MS = 2400;

let hideTimer: number | undefined;

function banner(): HTMLElement | null {
  return document.getElementById('net-banner');
}

function show(text: string, kind: 'offline' | 'online'): void {
  const el = banner();
  if (!el) return;
  window.clearTimeout(hideTimer);
  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.toggle('net-banner-online', kind === 'online');
  if (kind === 'online') {
    hideTimer = window.setTimeout(() => el.classList.add('hidden'), BACK_ONLINE_MS);
  }
}

export function initNetworkBanner(): void {
  const el = banner();
  if (!el) return;

  // `navigator.onLine` is a lower bound: false is definitive (no interface),
  // true only means "an interface exists". Good enough to explain a failure —
  // and we never *block* anything on it, so a captive-portal false positive
  // costs nothing.
  if (navigator.onLine === false) show(OFFLINE_TEXT, 'offline');

  window.addEventListener('offline', () => show(OFFLINE_TEXT, 'offline'));
  window.addEventListener('online', () => show(BACK_ONLINE_TEXT, 'online'));
}
