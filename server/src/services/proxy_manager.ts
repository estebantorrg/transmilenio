import http from 'http';
import https from 'https';
import tls from 'tls';
import type { Duplex } from 'stream';

// Cap on how long the proxy CONNECT tunnel may take to establish before we
// give up. Without this, an unresponsive proxy leaves the tunnel hanging
// because the per-request timeout only covers the post-connect phase.
const PROXY_CONNECT_TIMEOUT_MS = 8000;

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

interface ProxyItem {
  ip: string;
  port: number;
}

class ProxyManagerClass {
  private verifiedProxies: ProxyItem[] = [];
  private isTesting = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor() {
    // Start background refresh immediately
    this.refreshPromise = this.refresh().catch((err) => console.error('[ProxyManager] Init error:', err));
    this.checkInterval = setInterval(() => this.refresh(), 15 * 60 * 1000); // 15 mins
  }

  public getWorkingProxy(): ProxyItem | null {
    if (this.verifiedProxies.length === 0) return null;
    // Pick the first one (round-robin style by shifting and pushing back)
    const proxy = this.verifiedProxies.shift();
    if (proxy) {
      this.verifiedProxies.push(proxy);
      return proxy;
    }
    return null;
  }

  public reportFailure(ip: string, port: number) {
    console.log(`[ProxyManager] Removing failed proxy: ${ip}:${port}`);
    this.verifiedProxies = this.verifiedProxies.filter(p => !(p.ip === ip && p.port === port));
    if (this.verifiedProxies.length === 0) {
      console.warn('[ProxyManager] No working proxies left! Triggering immediate refresh...');
      this.refresh().catch((err) => console.error('[ProxyManager] Immediate refresh error:', err));
    }
  }

  public getVerifiedCount(): number {
    return this.verifiedProxies.length;
  }

  public getStats(): { verifiedCount: number; refreshing: boolean } {
    return {
      verifiedCount: this.verifiedProxies.length,
      refreshing: this.isTesting,
    };
  }

  public async waitForReady(timeoutMs = 12_000): Promise<number> {
    if (this.verifiedProxies.length > 0) return this.verifiedProxies.length;

    const refresh = this.isTesting
      ? this.refreshPromise
      : this.refresh();

    if (refresh) {
      await Promise.race([
        refresh.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }

    return this.verifiedProxies.length;
  }

  public refresh(): Promise<void> {
    if (this.isTesting) return this.refreshPromise ?? Promise.resolve();
    this.isTesting = true;

    this.refreshPromise = (async () => {
      console.log('[ProxyManager] Refreshing Colombian proxy list...');

      try {
        const fetched = await this.fetchColombianProxies();
        console.log(`[ProxyManager] Fetched ${fetched.length} proxies. Verifying...`);
        
        const verified: ProxyItem[] = [];
        const batchSize = 20;
        
        for (let i = 0; i < fetched.length; i += batchSize) {
          const batch = fetched.slice(i, i + batchSize);
          const results = await Promise.all(batch.map(p => this.testProxy(p.ip, p.port)));
          results.forEach((ok, idx) => {
            if (ok) verified.push(batch[idx]);
          });
        }

        this.verifiedProxies = verified;
        console.log(`[ProxyManager] Refresh complete. ${this.verifiedProxies.length} proxies verified and ready.`);
      } catch (err: any) {
        console.error('[ProxyManager] Failed to refresh proxies:', err.message);
      } finally {
        this.isTesting = false;
      }
    })();

    return this.refreshPromise;
  }

  private async fetchColombianProxies(): Promise<ProxyItem[]> {
    const list: ProxyItem[] = [];
    
    // Source 1: Geonode API
    try {
      const geonodeUrl = 'https://proxylist.geonode.com/api/proxy-list?limit=40&page=1&sort_by=lastChecked&sort_type=desc&country=CO&protocols=http';
      const geonodeData = await this.fetchJson(geonodeUrl);
      if (geonodeData?.data && Array.isArray(geonodeData.data)) {
        geonodeData.data.forEach((item: any) => {
          if (item.ip && item.port) {
            list.push({ ip: item.ip, port: Number(item.port) });
          }
        });
      }
    } catch (err: any) {
      console.warn(`[ProxyManager] Source Geonode failed: ${err.message}`);
    }

    // Source 2: ProxyScrape API
    try {
      const scrapeUrl = 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=CO&ssl=all&anonymity=all';
      const text = await this.fetchText(scrapeUrl);
      const lines = text.split('\n');
      lines.forEach(line => {
        const parts = line.trim().split(':');
        if (parts.length === 2) {
          const ip = parts[0];
          const port = Number(parts[1]);
          if (ip && !isNaN(port)) {
            // Avoid duplicates
            if (!list.some(p => p.ip === ip && p.port === port)) {
              list.push({ ip, port });
            }
          }
        }
      });
    } catch (err: any) {
      console.warn(`[ProxyManager] Source ProxyScrape failed: ${err.message}`);
    }

    return list;
  }

  private async testProxy(ip: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const agent = new SimpleProxyAgent(ip, port);
      
      const req = https.request({
        hostname: 'tmsa-transmiapp-shvpc.uc.r.appspot.com',
        port: 443,
        path: '/location/ruta?ruta=111',
        method: 'POST',
        headers: {
          'Content-Length': 0,
          'Accept-Encoding': 'identity',
          'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
          'User-Agent': 'okhttp/4.12.0',
          'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
          'version': '2.9.5',
        },
        agent,
        timeout: 8000, // 8 seconds timeout to allow slow but functional proxies to succeed
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (parsed?.status === 401 || parsed?.title === 'Unauthorized') {
              resolve(false);
            } else if (body.includes('latitude') || body.includes('longitude')) {
              resolve(true);
            } else {
              resolve(false);
            }
          } catch (e) {
            resolve(false);
          }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }

  private fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  private fetchText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }
}

export const ProxyManager = new ProxyManagerClass();
