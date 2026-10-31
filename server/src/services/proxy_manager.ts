import http from 'http';
import https from 'https';
import tls from 'tls';
import type { Duplex } from 'stream';
import { isIdRefusal, isIdRefused, LIVE_API_HOST, LIVE_HOST_HEADERS, markIdRefused } from './official_app_headers.js';
import { canRefreshPool, isProvenProxy, shouldRefreshPool } from './proxy_health.js';

// Cap on how long the proxy CONNECT tunnel may take to establish before we
// give up. Without this, an unresponsive proxy leaves the tunnel hanging
// because the per-request timeout only covers the post-connect phase.
const PROXY_CONNECT_TIMEOUT_MS = 8000;

// Verification budget. Real free CO proxies observed at 4.5–14s latency, so the
// test must be patient enough to keep the slow-but-working ones.
const TEST_TIMEOUT_MS = 12_000;
const TEST_BATCH = 50;
// How often a request waiting on a cold pool looks for its first proxy.
const READY_POLL_MS = 200;

// Pool maintenance.
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // re-scrape cadence, while the pool is short and in use
const TARGET_POOL_SIZE = 12; // a pool this big is left alone
/**
 * Bound on work per refresh. Verification costs one live-host request per
 * candidate, so this is also the bound on what a refresh asks upstream — kept
 * down instead by refreshing only when the pool needs it and stopping the
 * moment it reaches target (see `refresh`).
 *
 * **A cheaper pre-filter was tried on 2026-09-21 and reverted.** Asking
 * Cloudflare's `/cdn-cgi/trace` through each proxy for its exit country, and
 * spending a live-host request only on a Colombian exit, looked like a 10-50×
 * cut. Measured on 40 CO-tagged candidates it was simply wrong in both
 * directions: **both** proxies that served the live host failed the Cloudflare
 * request (these proxies reach the appspot host but not cloudflare.com), so the
 * gate discarded every proxy we could actually have used, while two proxies it
 * passed failed the live host. In production it took the verified pool from 4-5
 * down to 1 and pushed the first verified proxy past 100 s. The live host is the
 * only filter that answers the question being asked.
 */
const MAX_TEST_CANDIDATES = 500;

const LIVE_TEST_HOST = LIVE_API_HOST;
// Verification probes up to MAX_TEST_CANDIDATES untrusted proxies; each body is
// only inspected for coordinates, so it never needs to be buffered whole.
const PROBE_MAX_BODY_CHARS = 512 * 1024;
// Scraped proxy lists are third-party text on a 460 MB heap (spec §5.1.3); the
// real ones are a few hundred KB.
const MAX_PROXY_LIST_CHARS = 4 * 1024 * 1024;

export class SimpleProxyAgent extends https.Agent {
  public proxyHost: string;
  public proxyPort: number;

  constructor(proxyHost: string, proxyPort: number) {
    super();
    this.proxyHost = proxyHost;
    this.proxyPort = proxyPort;
  }

  createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, socket: Duplex) => void
  ): Duplex | null {
    if (!callback) return null;
    const targetHost = String(options.host ?? options.hostname ?? '');
    const targetPort = Number(options.port ?? 443);
    const servername = String((options as any).servername ?? options.hostname ?? options.host ?? '')
      .replace(/:\d+$/, '');

    // Guard against the callback firing more than once. The tunnel can fail
    // (TLS error) after it has already succeeded, and Node throws if the
    // createConnection callback is invoked twice.
    let settled = false;
    const done = (err: Error | null, socket?: Duplex) => {
      if (settled) return;
      settled = true;
      callback(err, socket as Duplex);
    };

    const req = http.request({
      host: this.proxyHost,
      port: this.proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        host: `${targetHost}:${targetPort}`,
      },
      timeout: PROXY_CONNECT_TIMEOUT_MS,
    });

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`Proxy connection failed: ${res.statusCode}`));
        return;
      }

      const secureSocket = tls.connect({
        socket,
        servername,
      }, () => {
        done(null, secureSocket);
      });

      secureSocket.on('error', (err) => done(err));
    });

    req.on('timeout', () => {
      req.destroy();
      done(new Error('Proxy CONNECT timed out'));
    });
    req.on('error', (err) => done(err));
    req.end();
    return null;
  }
}

export interface ProxyItem {
  ip: string;
  port: number;
}

interface ProxyStat extends ProxyItem {
  success: number;
  failure: number;
  latencyMs: number; // EMA of successful round-trips
  lastOkAt: number;
}

function keyOf(ip: string, port: number): string {
  return `${ip}:${port}`;
}

class ProxyManagerClass {
  private pool = new Map<string, ProxyStat>();
  private isTesting = false;
  private refreshPromise: Promise<void> | null = null;
  /** When a request last asked the pool for a proxy, and when a pass last ended. */
  private lastUsedAt = 0;
  private lastRefreshAt = 0;

  constructor() {
    // Nothing is probed until a request needs a proxy (`waitForReady`): this
    // module is also loaded by `/api/health`, and a pass at import spent up to
    // 500 live-host requests on an instance nobody was tracking a bus from.
    //
    // `unref` so the timer never holds the process open (a CLI script that
    // imports this module must still be able to exit) — same as the live warm-up.
    // The scheduled re-scrape only runs when the pool needs proxies AND someone
    // is using it (`shouldRefreshPool`): verification costs one live-host
    // request per candidate, which made the unconditional version of this tick
    // the project's single largest source of upstream traffic, larger than the
    // riders using it (§5.2.3).
    setInterval(() => {
      if (shouldRefreshPool(this.pool.size, TARGET_POOL_SIZE, this.lastUsedAt)) void this.refresh();
    }, REFRESH_INTERVAL_MS).unref();
  }

  public getVerifiedCount(): number {
    return this.pool.size;
  }

  /** Pool health for `/api/health`. Records only — a public endpoint is no place
   *  to list the addresses of other people's proxies. */
  public getStats(): { verifiedCount: number; refreshing: boolean; top: Array<{ latencyMs: number; success: number; failure: number }> } {
    const top = [...this.pool.values()]
      .sort((a, b) => this.score(b) - this.score(a))
      .slice(0, 5)
      .map((p) => ({ latencyMs: p.latencyMs, success: p.success, failure: p.failure }));
    return { verifiedCount: this.pool.size, refreshing: this.isTesting, top };
  }

  /**
   * Returns the best `n` proxies (highest score) without removing them, so the
   * caller can race several in parallel. Scoring favours high success rate, low
   * latency, and recent confirmation. `exclude` skips already-tried proxies so a
   * caller can pull successive non-overlapping waves (§5.2.5 wave fallback).
   */
  public getProxies(n: number, exclude?: Set<string>): ProxyItem[] {
    return [...this.pool.values()]
      .filter((p) => !exclude || !exclude.has(keyOf(p.ip, p.port)))
      .sort((a, b) => this.score(b) - this.score(a))
      .slice(0, Math.max(1, n))
      .map((p) => ({ ip: p.ip, port: p.port }));
  }

  /**
   * The best proxy that has actually answered recently, or `null`.
   *
   * Lets a caller send ONE upstream request instead of racing a whole wave of
   * them (§5.2.5): a proxy with a clean recent record is overwhelmingly likely
   * to answer the next request too, and the wave is still there when it does
   * not. "Proven" is deliberately strict — a recent success and no failure
   * since — because a wrong guess here costs the caller a retry.
   */
  public getProvenProxy(): ProxyItem | null {
    const now = Date.now();
    const best = [...this.pool.values()]
      .filter((p) => isProvenProxy(p, now))
      .sort((a, b) => this.score(b) - this.score(a))[0];
    return best ? { ip: best.ip, port: best.port } : null;
  }

  private score(p: ProxyStat): number {
    const total = p.success + p.failure;
    const rate = total ? p.success / total : 0.5;
    const speed = p.latencyMs ? Math.max(0, 1 - p.latencyMs / TEST_TIMEOUT_MS) : 0.3;
    const fresh = Math.max(0, 1 - (Date.now() - p.lastOkAt) / (5 * 60 * 1000));
    return rate * 0.6 + speed * 0.25 + fresh * 0.15;
  }

  public reportSuccess(ip: string, port: number, latencyMs: number): void {
    const k = keyOf(ip, port);
    const p = this.pool.get(k);
    if (!p) {
      this.pool.set(k, { ip, port, success: 1, failure: 0, latencyMs, lastOkAt: Date.now() });
      return;
    }
    p.success++;
    p.lastOkAt = Date.now();
    p.latencyMs = p.latencyMs ? Math.round(p.latencyMs * 0.7 + latencyMs * 0.3) : latencyMs;
  }

  public reportFailure(ip: string, port: number): void {
    const k = keyOf(ip, port);
    const p = this.pool.get(k);
    if (!p) return;
    p.failure++;
    // Evict proxies that never worked, or that fail far more than they succeed.
    if ((p.success === 0 && p.failure >= 3) || p.failure - p.success >= 4) {
      this.pool.delete(k);
    }
  }

  /**
   * Resolves with the pool size as soon as a proxy is in it, when the pass ends
   * empty, or at `timeoutMs`. A pass adds each proxy the moment it verifies
   * (`refresh`), so waiting for the whole pass — which runs past a minute —
   * held every request on a cold pool to the full timeout, past the budget of
   * every caller, after every restart.
   */
  public async waitForReady(timeoutMs = 12_000): Promise<number> {
    this.lastUsedAt = Date.now();
    if (this.pool.size > 0) return this.pool.size;

    const refresh = this.isTesting ? this.refreshPromise : this.refresh();
    let passOver = !refresh;
    const settle = () => { passOver = true; };
    void refresh?.then(settle, settle);
    const deadline = Date.now() + timeoutMs;
    while (this.pool.size === 0 && !passOver && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    return this.pool.size;
  }

  public refresh(): Promise<void> {
    if (this.isTesting) return this.refreshPromise ?? Promise.resolve();
    if (isIdRefused() || !canRefreshPool(this.lastRefreshAt)) return Promise.resolve();
    this.isTesting = true;

    this.refreshPromise = (async () => {
      console.log('[ProxyManager] Refreshing Colombian proxy pool...');
      try {
        const candidates = await this.fetchCandidates();
        console.log(`[ProxyManager] ${candidates.length} candidates. Verifying against live API (geofence filters to CO)...`);

        let verified = 0;
        let tested = 0;
        for (let i = 0; i < candidates.length; i += TEST_BATCH) {
          const batch = candidates.slice(i, i + TEST_BATCH);
          const results = await Promise.all(batch.map((p) => this.probeLiveHost(p.ip, p.port)));
          tested += batch.length;
          results.forEach((latency, idx) => {
            if (latency !== null) {
              // Add to the pool immediately so waitForReady() can return early.
              this.reportSuccess(batch[idx].ip, batch[idx].port, latency);
              verified++;
            }
          });

          if (isIdRefused()) {
            console.log(`[ProxyManager] Live host refuses this install id; stopping after ${tested}/${candidates.length} candidates.`);
            break;
          }

          // Enough is enough: a pool at target does not need the rest of the
          // list probed, and every skipped candidate is an upstream request not
          // made (§5.2.3). The scheduled tick re-scrapes when it runs low.
          if (this.pool.size >= TARGET_POOL_SIZE) {
            console.log(`[ProxyManager] Pool at target (${this.pool.size}); stopping after ${tested}/${candidates.length} candidates.`);
            break;
          }
        }
        console.log(`[ProxyManager] Refresh complete. ${tested} tested, ${verified} newly verified; pool size ${this.pool.size}.`);
      } catch (err: any) {
        console.error('[ProxyManager] Refresh failed:', err.message);
      } finally {
        this.isTesting = false;
        this.lastRefreshAt = Date.now();
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Gathers candidates from the free CO-tagged proxy lists only. A worldwide
   * list used to top this up, but the geofence 401s almost all of it, so every
   * probe of it delivered this deployment's id and Appid to the live host from
   * another foreign IP for nothing — the "one install, hundreds of IPs" shape an
   * operator reads as abuse (2026-10-29 block; spec §5.2.3). CO-tagged only.
   * Public for the station-demand sync, which verifies them against its own
   * Colombia-only host instead (`sync_demand.ts`).
   */
  public async fetchCandidates(): Promise<ProxyItem[]> {
    const tagged = new Map<string, ProxyItem>();
    const add = (map: Map<string, ProxyItem>, ip: string, port: number) => {
      if (ip && Number.isFinite(port) && port > 0) map.set(keyOf(ip, port), { ip, port });
    };

    // Source: Geonode (CO, paginated JSON).
    for (const page of [1, 2, 3]) {
      try {
        const data = await this.fetchJson(
          `https://proxylist.geonode.com/api/proxy-list?limit=100&page=${page}&sort_by=lastChecked&sort_type=desc&country=CO&protocols=http`
        );
        if (Array.isArray(data?.data)) {
          for (const item of data.data) add(tagged, String(item.ip), Number(item.port));
        }
      } catch (err: any) {
        console.warn(`[ProxyManager] Geonode p${page} failed: ${err.message}`);
      }
    }

    // Source: ProxyScrape (CO).
    try {
      const text = await this.fetchText(
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=CO&ssl=all&anonymity=all'
      );
      for (const [ip, port] of this.parsePairs(text)) add(tagged, ip, port);
    } catch (err: any) {
      console.warn(`[ProxyManager] ProxyScrape failed: ${err.message}`);
    }

    // Source: proxy-list.download (CO).
    try {
      const text = await this.fetchText('https://www.proxy-list.download/api/v1/get?type=http&country=CO');
      for (const [ip, port] of this.parsePairs(text)) add(tagged, ip, port);
    } catch (err: any) {
      console.warn(`[ProxyManager] proxy-list.download failed: ${err.message}`);
    }

    return [...tagged.values()].slice(0, MAX_TEST_CANDIDATES);
  }

  /**
   * Resolves with round-trip latency (ms) if the proxy reaches the live API from
   * CO, else null. The live host is the only usable filter — see the note above
   * `MAX_TEST_CANDIDATES` for the cheaper pre-filter that was tried and
   * measured worse.
   */
  private probeLiveHost(ip: string, port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const started = Date.now();
      let done = false;
      const finish = (value: number | null) => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };

      const agent = new SimpleProxyAgent(ip, port);
      const req = https.request(
        {
          hostname: LIVE_TEST_HOST,
          port: 443,
          path: '/location/ruta?ruta=111',
          method: 'POST',
          headers: {
            'Content-Length': 0,
            'Accept-Encoding': 'identity',
            ...LIVE_HOST_HEADERS,
          },
          agent,
          timeout: TEST_TIMEOUT_MS,
        },
        (res) => {
          let body = '';
          // The proxy under test is untrusted: cap what we buffer. The probe only
          // needs to see whether coordinates come back.
          res.on('data', (chunk) => {
            if (body.length > PROBE_MAX_BODY_CHARS) {
              res.destroy();
              return finish(null);
            }
            body += chunk;
          });
          res.on('error', () => finish(null));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              if (isIdRefusal(LIVE_TEST_HOST, res.statusCode, body.length)) markIdRefused();
              return finish(null);
            }
            try {
              const parsed = JSON.parse(body);
              if (parsed?.status === 401 || parsed?.title === 'Unauthorized') return finish(null);
            } catch {
              // not JSON → fall through to the coord check below
            }
            finish(body.includes('latitude') && body.includes('longitude') ? Date.now() - started : null);
          });
        }
      );

      req.on('error', () => finish(null));
      req.on('timeout', () => {
        req.destroy();
        finish(null);
      });
      req.end();
    });
  }

  /**
   * `ip:port` pairs from a scraped list. The lists are third-party text, and each
   * pair becomes a CONNECT target, so loopback/private/link-local ranges are
   * dropped: a poisoned or careless list must not make this server probe hosts
   * inside its own network. Octets are validated too (`999.1.1.1` is not an IP).
   */
  private parsePairs(text: string): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    const re = /(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const port = Number(m[2]);
      if (this.isRoutableIp(m[1]) && port > 0 && port <= 65535) out.push([m[1], port]);
    }
    return out;
  }

  private isRoutableIp(ip: string): boolean {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;      // this/private/loopback/multicast
    if (a === 169 && b === 254) return false;                            // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;                   // private
    if (a === 192 && b === 168) return false;                            // private
    if (a === 100 && b >= 64 && b <= 127) return false;                  // CGNAT
    return true;
  }

  private fetchJson(url: string): Promise<any> {
    return this.fetchText(url).then((data) => JSON.parse(data));
  }

  /**
   * Reads a scraped proxy list.
   *
   * The sources are third-party text hosts that reset connections routinely, and
   * the response stream needs its own `error` listener: an aborted or reset
   * response with none is an unhandled `'error'` event, i.e. a **process-level
   * crash**, not a rejected promise (spec §5.2.5). `req.on('error')` does not
   * cover it — a body that dies after the headers arrived errors on `res`. The
   * promise also has to settle, or the refresh pass hangs on a dead socket.
   *
   * Bounded for the same reason every other upstream read is: this is untrusted
   * third-party text on a 460 MB heap, and a list is a few hundred KB.
   */
  private fetchText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https
        .get(url, { timeout: 10_000 }, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
            if (data.length > MAX_PROXY_LIST_CHARS) {
              res.destroy();
              reject(new Error(`${url}: proxy list exceeded ${MAX_PROXY_LIST_CHARS} chars`));
            }
          });
          res.on('error', reject);
          res.on('end', () => resolve(data));
        })
        .on('error', reject)
        .on('timeout', function (this: http.ClientRequest) {
          this.destroy(new Error('timeout'));
        });
    });
  }
}

export const ProxyManager = new ProxyManagerClass();
