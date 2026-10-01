/**
 * Which features may reach TRANSMILENIO's Colombia-only host through the public
 * Colombian proxy pool (spec §5.2.5).
 *
 * Two switches, so card reads can be decided on their own without touching live
 * tracking — they carry different data: a live request names a route, a card
 * request carries a tu llave number (privacy policy §2.1, §4):
 *
 *   TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY=1        live buses and arrivals
 *   TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY_CARD=0|1  card reads only
 *
 * The card switch, when unset, follows the first one, so a deploy that set only
 * the original variable behaves exactly as before. Setting it to `0` keeps card
 * reads off the public proxies while live tracking keeps using them.
 */

export type PublicProxyUse = 'live' | 'card';

export function publicProxyAllowed(use: PublicProxyUse, env: NodeJS.ProcessEnv = process.env): boolean {
  const live = env.TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY === '1';
  if (use === 'live') return live;
  const card = String(env.TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY_CARD ?? '').trim();
  return card === '' ? live : card === '1';
}

/** Whether any feature may use the pool (it is only loaded, and scraped, if so). */
export function anyPublicProxyAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return publicProxyAllowed('live', env) || publicProxyAllowed('card', env);
}
