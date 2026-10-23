/**
 * One request through the public Colombian proxy pool (spec §5.2.5).
 *
 * Live buses, arrivals, the card read and the tullave sync each carried their
 * own copy of this, and the copies had drifted: live buses tried the proven
 * proxy alone and then up to three waves, arrivals skipped the lone try, and the
 * card read and the sync gave up after a single wave — so a saldo failed
 * whenever the first five proxies were dead, with a pool of working ones behind
 * them. One implementation, and every caller gets all of it (spec §1.1 R2).
 *
 * The race itself (`raceProxies`) takes the pool as an argument, so it can be
 * tested without the real one — `proxy_manager.ts` starts scraping on import.
 */

import type https from 'https';
import type { ProxyItem } from './proxy_manager.js';

// Free CO proxies run 4.5–14 s; be patient and race several so the fastest wins.
export const CO_PROXY_TIMEOUT_MS = Number(process.env.LIVE_PROXY_TIMEOUT_MS) || 14_000;
// How long a request waits on a cold pool for its first verified proxy. Well
// under every caller's budget (live 14.5 s, card 14 s, an arrivals route 8.5 s):
// at 18 s the wait alone outlasted all of them, and the browser's 15 s.
const CO_PROXY_READY_TIMEOUT_MS = 6_000;
const CO_PROXY_RACE_WIDTH = Number(process.env.CO_PROXY_RACE_WIDTH) || 5;
// If a whole wave of free proxies dies (connection reset / timeout — common),
// fall through to the next-best, non-overlapping wave instead of failing.
// Bounded so a dead pool cannot run past the caller's overall budget.
const CO_PROXY_MAX_WAVES = Number(process.env.CO_PROXY_MAX_WAVES) || 3;

/** The part of `ProxyManager` a race needs. */
export interface ProxyPool {
  waitForReady(timeoutMs: number): Promise<number>;
  getProvenProxy(): ProxyItem | null;
  getProxies(n: number, exclude?: Set<string>): ProxyItem[];
  reportSuccess(ip: string, port: number, latencyMs: number): void;
  reportFailure(ip: string, port: number): void;
}

/**
 * Sends one request through the pool and resolves with the first valid answer.
 *
 * Wave 0 is the single best proxy that has been answering, alone: a race sends
 * the *same* request to several proxies and throws all but one answer away, so
 * a healthy pool paid five upstream requests for every one it needed. A failure
 * there falls through to the ordinary races, each over proxies not tried yet.
 * The winner is rewarded, genuine losers are penalised, and the ones still in
 * flight are aborted the moment a winner resolves (an aborted loser is not a
 * failure). Rejects only when every wave has failed.
 */
export async function raceProxies<T>(
  pool: ProxyPool,
  attempt: (proxy: ProxyItem, signal: AbortSignal) => Promise<T>,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  if ((await pool.waitForReady(CO_PROXY_READY_TIMEOUT_MS)) === 0) {
    throw new Error('No Colombian proxy available');
  }

  const raceWave = async (proxies: ProxyItem[]): Promise<T> => {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    signal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      return await Promise.any(proxies.map(async (proxy) => {
        const started = Date.now();
        try {
          const result = await attempt(proxy, controller.signal);
          pool.reportSuccess(proxy.ip, proxy.port, Date.now() - started);
          return result;
        } catch (error) {
          if (!controller.signal.aborted) pool.reportFailure(proxy.ip, proxy.port);
          throw error;
        }
      }));
    } catch (error: any) {
      const causes: unknown[] = error?.errors ?? [error];
      throw new Error(causes.map((cause: any) => String(cause?.message || cause)).join(' | '));
    } finally {
      controller.abort(); // cancel the slower in-flight proxies
      signal?.removeEventListener('abort', onParentAbort);
    }
  };

  const tried = new Set<string>();
  let lastError: Error | null = null;
  const solo = pool.getProvenProxy();

  for (let wave = solo ? 0 : 1; wave <= CO_PROXY_MAX_WAVES; wave++) {
    if (signal?.aborted) break;
    const proxies = wave === 0 ? [solo!] : pool.getProxies(CO_PROXY_RACE_WIDTH, tried);
    if (proxies.length === 0) break;
    for (const proxy of proxies) tried.add(`${proxy.ip}:${proxy.port}`);

    console.log(`[CO proxy] ${label} via ${wave === 0 ? `SOLO ${proxies[0].ip}:${proxies[0].port}` : `RACEx${proxies.length} wave ${wave}/${CO_PROXY_MAX_WAVES}`}`);
    try {
      // A valid empty answer resolves the wave too — a working proxy is not
      // worth burning further waves on.
      return await raceWave(proxies);
    } catch (error: any) {
      lastError = error;
    }
  }

  throw new Error(`All CO proxies failed across ${tried.size} tried${lastError ? `: ${lastError.message}` : ''}`);
}

/** {@link raceProxies} over the real pool, each attempt tunnelled through its proxy. */
export async function viaColombianProxy<T>(
  label: string,
  attempt: (agent: https.Agent, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const { ProxyManager, SimpleProxyAgent } = await import('./proxy_manager.js');
  return raceProxies(
    ProxyManager,
    (proxy, proxySignal) => attempt(new SimpleProxyAgent(proxy.ip, proxy.port), proxySignal),
    label,
    signal
  );
}
