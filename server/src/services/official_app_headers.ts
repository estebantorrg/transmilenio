/**
 * How this project identifies itself to the two upstream hosts the official
 * TransMi app talks to (spec §5.2.3). ONE definition: the live tier, the
 * standalone relay, the proxy-pool probe, the card read, the tullave sync and
 * the catalog loader all spread these, so the identity they send can never
 * drift apart again (spec §1.1 R2).
 *
 * There is deliberately **no `uuid`**. The app sends a per-install id; this
 * project used to send one fixed value, hand-copied into every tier, and on
 * 2026-09-16 TMSA blocklisted it — any request carrying it got an empty `403`
 * on every path of the live host. A fixed id shared by every egress is a single
 * handle that shuts all of them at once, and `Appid` is the only header the
 * live host requires. Do not add one back, and never rotate one to get past a
 * block (spec §5.2.3).
 */

export const LIVE_API_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';

/** Sent to both hosts: the app's HTTP client and release. Neither is required. */
export const OFFICIAL_APP_HEADERS = Object.freeze({
  'User-Agent': 'okhttp/4.12.0',
  'version': '2.9.7',
});

/** Sent to the live host, which answers `401` without `Appid`. */
export const LIVE_HOST_HEADERS = Object.freeze({
  'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
  ...OFFICIAL_APP_HEADERS,
});
