/** LocalStorage-backed favorites & recents (per-device, zero PII — spec §3.3). */

const FAV_KEY = 'tmgo.favorites.v1';
const RECENT_KEY = 'tmgo.recents.v1';
const CARDS_KEY = 'tmgo.cards.v1';
const MAP_LAYERS_KEY = 'tmgo.mapLayers.v1';
const MAX_RECENT = 12;
const MAX_CARDS = 5;

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage may be full/blocked — non-fatal */
  }
}

export function getFavorites(): string[] {
  return read(FAV_KEY);
}

export function isFavorite(id: string): boolean {
  return read(FAV_KEY).includes(id);
}

export function toggleFavorite(id: string): boolean {
  const list = read(FAV_KEY);
  const idx = list.indexOf(id);
  if (idx >= 0) {
    list.splice(idx, 1);
    write(FAV_KEY, list);
    return false;
  }
  list.unshift(id);
  write(FAV_KEY, list);
  return true;
}

export function getRecents(): string[] {
  return read(RECENT_KEY);
}

export function pushRecent(id: string): void {
  const list = read(RECENT_KEY).filter((x) => x !== id);
  list.unshift(id);
  write(RECENT_KEY, list.slice(0, MAX_RECENT));
}

/**
 * Recently planned trips (most recent first). A rider repeats the same two or
 * three journeys — casa→trabajo and back — and re-typing both endpoints every
 * time was the planner's real cost. Coordinates + labels only, on this device
 * (zero PII leaves it, spec §3.3).
 */
export interface RecentTrip {
  originName: string;
  originCoord: [number, number];
  originCode?: string;
  destName: string;
  destCoord: [number, number];
  destCode?: string;
}

const TRIPS_KEY = 'tmgo.trips.v1';
const MAX_TRIPS = 6;

function isCoord(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function isTrip(value: unknown): value is RecentTrip {
  const t = value as RecentTrip;
  return (
    !!t &&
    typeof t.originName === 'string' &&
    typeof t.destName === 'string' &&
    isCoord(t.originCoord) &&
    isCoord(t.destCoord)
  );
}

/** Same two endpoints = same trip, whichever labels they were saved under. */
function tripKey(trip: RecentTrip): string {
  return `${trip.originCoord.join()}|${trip.destCoord.join()}`;
}

export function getRecentTrips(): RecentTrip[] {
  try {
    const raw = localStorage.getItem(TRIPS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isTrip) : [];
  } catch {
    return [];
  }
}

export function pushRecentTrip(trip: RecentTrip): void {
  const key = tripKey(trip);
  const list = getRecentTrips().filter((t) => tripKey(t) !== key);
  list.unshift(trip);
  try {
    localStorage.setItem(TRIPS_KEY, JSON.stringify(list.slice(0, MAX_TRIPS)));
  } catch {
    /* storage may be full/blocked — non-fatal */
  }
}

export function clearRecentTrips(): void {
  try {
    localStorage.removeItem(TRIPS_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Remembered card numbers (last used first). Stored locally only. */
export function getCards(): string[] {
  return read(CARDS_KEY);
}

export function rememberCard(digits: string): void {
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 6) return;
  const list = read(CARDS_KEY).filter((x) => x !== clean);
  list.unshift(clean);
  write(CARDS_KEY, list.slice(0, MAX_CARDS));
}

export function forgetCard(digits: string): void {
  write(CARDS_KEY, read(CARDS_KEY).filter((x) => x !== digits));
}

/** Which whole-network map layers the rider keeps switched on. */
export type MapLayerKey = 'stations' | 'paraderos' | 'demand' | 'cable';

const MAP_LAYER_DEFAULTS: Record<MapLayerKey, boolean> = {
  stations: true,
  paraderos: false,
  demand: false,
  cable: false,
};

/**
 * Map layer toggles are a standing preference, not a per-session one: someone
 * who rides zonal had to re-enable "Paraderos zonales" on every single launch.
 * Unknown/corrupt values fall back to the defaults rather than throwing.
 */
export function getMapLayerPrefs(): Record<MapLayerKey, boolean> {
  const prefs = { ...MAP_LAYER_DEFAULTS };
  try {
    const raw = localStorage.getItem(MAP_LAYERS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const key of Object.keys(prefs) as MapLayerKey[]) {
        if (typeof parsed[key] === 'boolean') prefs[key] = parsed[key];
      }
    }
  } catch {
    /* corrupt storage — defaults are a fine answer */
  }
  return prefs;
}

export function setMapLayerPref(key: MapLayerKey, on: boolean): void {
  const prefs = getMapLayerPrefs();
  prefs[key] = on;
  try {
    localStorage.setItem(MAP_LAYERS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage may be full/blocked — non-fatal */
  }
}
