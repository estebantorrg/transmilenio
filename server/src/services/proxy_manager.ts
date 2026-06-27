import http from 'http';
import https from 'https';
import tls from 'tls';
import type { Duplex } from 'stream';

// Cap on how long the proxy CONNECT tunnel may take to establish before we
// give up. Without this, an unresponsive proxy leaves the tunnel hanging
// because the per-request timeout only covers the post-connect phase.
const PROXY_CONNECT_TIMEOUT_MS = 8000;

// Verification budget. Real free CO proxies observed at 4.5–14s latency, so the
// test must be patient enough to keep the slow-but-working ones.
const TEST_TIMEOUT_MS = 12_000;
const TEST_BATCH = 50;

// Pool maintenance.
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // full re-scrape cadence
const TOP_UP_INTERVAL_MS = 90 * 1000; // keep-warm check
const TARGET_POOL_SIZE = 12; // re-scrape eagerly below this
const MAX_TEST_CANDIDATES = 500; // bound work per refresh
const MAX_GLOBAL_FILL = 200; // non-CO-tagged candidates to top up with

const LIVE_TEST_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';

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

  constructor() {
    this.refreshPromise = this.refresh().catch((err) => console.error('[ProxyManager] Init error:', err));
    setInterval(() => this.refreshInBackground('scheduled'), REFRESH_INTERVAL_MS);
    setInterval(() => {
      // Keep-warm: re-scrape eagerly whenever the verified pool runs low.
      if (this.pool.size < TARGET_POOL_SIZE) this.refreshInBackground('top-up');
    }, TOP_UP_INTERVAL_MS);
  }

  public getVerifiedCount(): number {
    return this.pool.size;
  }

  public getStats(): { verifiedCount: number; refreshing: boolean; top: Array<{ proxy: string; latencyMs: number; success: number; failure: number }> } {
    const top = [...this.pool.values()]
      .sort((a, b) => this.score(b) - this.score(a))
      .slice(0, 5)
      .map((p) => ({ proxy: keyOf(p.ip, p.port), latencyMs: p.latencyMs, success: p.success, failure: p.failure }));
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
    if (this.pool.size < TARGET_POOL_SIZE) this.refreshInBackground('failure-top-up');
  }

  private refreshInBackground(reason: string): void {
    this.refresh().catch((error) => {
      console.error(`[ProxyManager] Background refresh failed (${reason}):`, error);
    });
  }

  public async waitForReady(timeoutMs = 12_000): Promise<number> {
    if (this.pool.size > 0) return this.pool.size;

    const refresh = this.isTesting ? this.refreshPromise : this.refresh();
    if (refresh) {
      await Promise.race([
        refresh.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
    return this.pool.size;
  }

  public refresh(): Promise<void> {
    if (this.isTesting) return this.refreshPromise ?? Promise.resolve();
    this.isTesting = true;

    this.refreshPromise = (async () => {
      console.log('[ProxyManager] Refreshing Colombian proxy pool...');
      try {
        const candidates = await this.fetchCandidates();
        console.log(`[ProxyManager] ${candidates.length} candidates. Verifying against live API (geofence filters to CO)...`);

        let verified = 0;
        for (let i = 0; i < candidates.length; i += TEST_BATCH) {
          const batch = candidates.slice(i, i + TEST_BATCH);
          const results = await Promise.all(batch.map((p) => this.testProxy(p.ip, p.port)));
          results.forEach((latency, idx) => {
            if (latency !== null) {
              // Add to the pool immediately so waitForReady() can return early.
              this.reportSuccess(batch[idx].ip, batch[idx].port, latency);
              verified++;
            }
          });
        }
        console.log(`[ProxyManager] Refresh complete. ${verified} newly verified; pool size ${this.pool.size}.`);
      } catch (err: any) {
        console.error('[ProxyManager] Refresh failed:', err.message);
      } finally {
        this.isTesting = false;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Gathers candidates from several free sources. CO-tagged sources go first
   * (highest hit rate); a bounded slice of a global list tops up to catch CO
   * proxies the tagged lists miss. The live-API test is the real CO filter.
   */
  private async fetchCandidates(): Promise<ProxyItem[]> {
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

    // Global top-up (bounded, shuffled) — geofence test keeps only CO exits.
    const global = new Map<string, ProxyItem>();
    try {
      const text = await this.fetchText('https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt');
      for (const [ip, port] of this.parsePairs(text)) {
        const k = keyOf(ip, port);
        if (!tagged.has(k)) add(global, ip, port);
      }
    } catch (err: any) {
      console.warn(`[ProxyManager] Global list failed: ${err.message}`);
    }

    const fill = this.shuffle([...global.values()]).slice(0, MAX_GLOBAL_FILL);
    const all = [...tagged.values(), ...fill];
    return all.slice(0, MAX_TEST_CANDIDATES);
  }

  /** Resolves with round-trip latency (ms) if the proxy reaches the live API from CO, else null. */
  private testProxy(ip: string, port: number): Promise<number | null> {
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
            Appid: '9a2c3b48f0c24ae9bfba38e94f27c3ea',
            'User-Agent': 'okhttp/4.12.0',
            uuid: 'fd1be953-d85e-4c63-8c23-234f143f445d',
            version: '2.9.5',
          },
          agent,
          timeout: TEST_TIMEOUT_MS,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) return finish(null);
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

  private parsePairs(text: string): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    const re = /(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push([m[1], Number(m[2])]);
    return out;
  }

  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      https
        .get(url, { timeout: 10_000 }, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject)
        .on('timeout', function (this: http.ClientRequest) {
          this.destroy(new Error('timeout'));
        });
    });
  }

  private fetchText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https
        .get(url, { timeout: 10_000 }, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
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
