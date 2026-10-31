/**
 * How this project identifies itself to the two upstream hosts the official
 * TransMi app talks to (spec §5.2.3). ONE definition: the live tier, the
 * standalone relay, the proxy-pool probe, the card read, the tullave sync and
 * the catalog loader all spread these, so the identity they send can never
 * drift apart again (spec §1.1 R2).
 *
 * The `uuid` is the app's per-install id, and upstream's treatment of it has
 * flipped twice — so it is derived, never a literal:
 *
 *   2026-09-16  TMSA blocklisted the one fixed id this project had copied into
 *               every tier; any request carrying it got an empty 403.
 *   2026-09-21  the header became **mandatory** — no `uuid` (or an empty one)
 *               is an empty 403 on every live path, while any non-empty value
 *               passes and one stable value keeps working call after call.
 *
 */

import { randomUUID } from 'crypto';

export const LIVE_API_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';

/**
 * This instance's install id: the operator-set `TM_APP_UUID` when present,
 * otherwise one generated once at boot and kept for the life of the process.
 */
export const APP_INSTALL_UUID = (process.env.TM_APP_UUID || '').trim() || randomUUID();

/** Sent to both hosts: the app's HTTP client, release and install id. */
export const OFFICIAL_APP_HEADERS = Object.freeze({
  'User-Agent': 'okhttp/4.12.0',
  'version': '2.9.7',
  'uuid': APP_INSTALL_UUID,
});

/** Sent to the live host, which answers `401` without `Appid` (and `403` without `uuid`). */
export const LIVE_HOST_HEADERS = Object.freeze({
  'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
  ...OFFICIAL_APP_HEADERS,
});

/**
 * Once the live host refuses this id (empty 403), the direct tier keeps carrying
 * it, so asking again is only load on a host that has said no ("less volume",
 * above). The direct tier is skipped while this is set (`runLiveTiers`), with one
 * look per pause to notice the block lifting. The relay and proxy tiers send
 * other ids — the relay its own box's, the proxy a rotating pool
 * (`nextProxyUuid`) — so they keep running. Confirmed 2026-10-30: this
 * deployment's id got an empty 403 from a Colombian IP too, while the website
 * kept firing up to 12 doomed direct requests per poll.
 */
export const ID_REFUSED_PAUSE_MS = 30 * 60_000;
let idRefusedUntil = 0;

/** The host's answer to a refused id: an empty `403`. A geofence refusal is a `401` with a body. */
export function isIdRefusal(hostname: string, status: number | undefined, bodyLength: number): boolean {
  return hostname === LIVE_API_HOST && status === 403 && bodyLength === 0;
}

export function isIdRefused(now = Date.now()): boolean {
  return now < idRefusedUntil;
}

export function markIdRefused(now = Date.now()): void {
  if (!isIdRefused(now)) {
    console.log(`[TM API] Live host refused this install id (empty 403); skipping the direct tier for ${ID_REFUSED_PAUSE_MS / 60_000} min`);
  }
  idRefusedUntil = now + ID_REFUSED_PAUSE_MS;
}

// ─── Proxy UUID Pool ────────────────────────────────────
// Each proxy request carries a different UUID so no single id accumulates
// the traffic of every proxy in the pool. The pool rotates periodically.

const PROXY_UUID_POOL_SIZE = 12;
const PROXY_UUID_ROTATION_MS = 2 * 60 * 60_000;

let proxyUuidPool: string[] = Array.from({ length: PROXY_UUID_POOL_SIZE }, () => randomUUID());
let proxyUuidIndex = 0;

/** A UUID from the rotating proxy pool, round-robin. */
export function nextProxyUuid(): string {
  const uuid = proxyUuidPool[proxyUuidIndex];
  proxyUuidIndex = (proxyUuidIndex + 1) % proxyUuidPool.length;
  return uuid;
}

setInterval(() => {
  proxyUuidPool = Array.from({ length: PROXY_UUID_POOL_SIZE }, () => randomUUID());
  proxyUuidIndex = 0;
}, PROXY_UUID_ROTATION_MS).unref();
