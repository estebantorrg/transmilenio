/**
 * This install's id for the `uuid` header the live host requires (spec §5.2.3).
 *
 * Since 2026-09-21 the live host answers an empty `403` to any request without
 * a `uuid`, so the native app (and the extension, which keeps its own copy of
 * this in `extension/background.js`) must send one. It is generated once and
 * kept: one id per install, which is what the official app sends. Never a
 * literal shared by every client — a single id carrying everyone's traffic is
 * what TMSA blocklisted on 2026-09-16 — and never a fresh one per request,
 * which would be minting ids to outrun a block rather than identifying an
 * install (see `server/src/services/official_app_headers.ts`).
 *
 * The store can be unavailable (private mode, blocked site data), so a failure
 * degrades to a per-session id rather than to no id at all, which would mean no
 * live buses.
 */

const STORAGE_KEY = 'tm.installUuid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cached: string | null = null;

function newUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through to the manual build below */
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** This install's id, stable across launches whenever storage is readable. */
export function installUuid(): string {
  if (cached) return cached;

  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }

  if (stored && UUID_RE.test(stored)) {
    cached = stored;
    return cached;
  }

  cached = newUuid();
  try {
    localStorage.setItem(STORAGE_KEY, cached);
  } catch {
    /* per-session id; still a valid install for this run */
  }
  return cached;
}
