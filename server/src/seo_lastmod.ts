/**
 * Each sitemap page's `lastmod` is the day its CONTENT last changed, not the
 * day of the build (spec §5.5.4).
 *
 * Every deploy used to stamp all 363 URLs with today's date, which is a signal
 * Google learns to ignore — and on a site it crawls 34 times a quarter, an
 * honest "these 4 pages changed" is worth having.
 *
 * The build runs on a fresh box with nothing kept from the last one, so the
 * memory travels with the site: `sitemap-lastmod.json` maps each URL to a hash
 * of what the page says and the day that hash first appeared. Each build reads
 * the live one, keeps a date wherever the hash is unchanged, and publishes the
 * new ledger beside the sitemaps. Where the live ledger cannot be read (the
 * first deploy, the site down) every page gets today — the old behaviour, once.
 */

import { createHash } from 'node:crypto';

export const LEDGER_FILE = 'sitemap-lastmod.json';

/** URL → [content hash, the day that content first appeared]. */
export type Ledger = Record<string, [hash: string, date: string]>;

/** What a page SAYS, hashed: pass its title, description, structured data and
 *  body — never the shell around it, whose asset names change on every build. */
export function contentHash(...parts: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** The home page IS the shell: hashed without the build's hashed asset names
 *  (`index-Bx9f3kQa.js`), which change on every build whatever the page says. */
export function shellHash(shell: string): string {
  return contentHash(shell.replace(/[-.][A-Za-z0-9_-]{8,}\.(js|css|woff2?)/g, '.$1'));
}

/** The new ledger: a page keeps its date where its hash is the one on file. */
export function dateLedger(hashes: Map<string, string>, previous: Ledger | null, today: string): Ledger {
  const ledger: Ledger = {};
  for (const [url, hash] of hashes) {
    const before = previous?.[url];
    ledger[url] = [hash, before && before[0] === hash ? before[1] : today];
  }
  return ledger;
}

/** The ledger the live site publishes, or null when it cannot be read — the
 *  live site answers an unknown path with its HTML shell, so that counts too.
 *  `SEO_LEDGER_URL` reads another copy, e.g. a local server's, to try a build. */
export async function liveLedger(origin: string): Promise<Ledger | null> {
  try {
    const res = await fetch(process.env.SEO_LEDGER_URL || `${origin}/${LEDGER_FILE}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { pages?: Ledger };
    return data.pages && typeof data.pages === 'object' ? data.pages : null;
  } catch (error) {
    console.warn(`[seo] lastmod ledger unreadable (${(error as Error).message}); every page dated today.`);
    return null;
  }
}
