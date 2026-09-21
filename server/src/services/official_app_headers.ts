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
 * So: ONE id per deployment (`TM_APP_UUID`, else generated at boot), which is
 * what a real install sends. Not a literal in the source — that is a single
 * handle that bans every egress at once, and it is exactly what was hit. And
 * deliberately NOT a fresh id per request: minting ids so no single one carries
 * enough traffic to be noticed is working around the operator's abuse control
 * rather than identifying ourselves to it, and it invites an IP- or
 * attestation-level block that would also cut the native app and the extension.
 * If this id is ever blocked, the answer is less volume, not another id.
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
