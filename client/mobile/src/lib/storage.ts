/** LocalStorage-backed favorites & recents (per-device, zero PII — spec §3.3). */

const FAV_KEY = 'tmgo.favorites.v1';
const RECENT_KEY = 'tmgo.recents.v1';
const CARDS_KEY = 'tmgo.cards.v1';
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
