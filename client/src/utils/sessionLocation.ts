export interface SessionExactLocation {
  lng: number;
  lat: number;
  source: 'gps' | 'manual';
}

const LEGACY_STORAGE_KEY = 'tm-user-exact-location';

let sessionExactLocation: SessionExactLocation | null = null;

export function clearLegacyExactLocation(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function setSessionExactLocation(lng: number, lat: number, source: SessionExactLocation['source']): void {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  sessionExactLocation = { lng, lat, source };
  clearLegacyExactLocation();
}

export function getSessionExactLocation(): SessionExactLocation | null {
  return sessionExactLocation ? { ...sessionExactLocation } : null;
}

clearLegacyExactLocation();
