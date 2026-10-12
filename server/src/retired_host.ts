import path from 'node:path';

/** Where the site lives now (spec §5.5.4). */
export const CANONICAL_HOST = 'mitrasto.app';

/** Hosts the site used to be published on. */
const RETIRED_HOSTS = new Set(['transmilenio.onrender.com']);

/**
 * The permanent redirect a page asked for on a retired host gets, or `null` to
 * serve the request where it was asked.
 *
 * Pages only. `/api` stays put: installed APKs call it on the old host, and a
 * POST does not survive a 301. So does anything with an extension —
 * `robots.txt` and the Search Console token have to keep answering there for
 * Google to crawl the redirects, and a service worker script may not redirect.
 */
export function retiredHostRedirect(method: string, hostname: string, originalUrl: string): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (!RETIRED_HOSTS.has(hostname)) return null;
  const pathname = originalUrl.split('?')[0];
  if (pathname === '/api' || pathname.startsWith('/api/')) return null;
  if (path.posix.extname(pathname)) return null;
  return `https://${CANONICAL_HOST}${originalUrl}`;
}
