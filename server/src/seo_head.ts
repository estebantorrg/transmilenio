/**
 * A page's own head on the app shell (spec §5.5.4): title, description,
 * canonical, robots, and the Open Graph / Twitter tags a link preview reads.
 * Used by the prerender for every static page, and by the server for the pages
 * it answers live (`/viaje`, §5.6.7) — one rewrite, so both say the same tags.
 */

import { WEB_ORIGIN } from '../../shared/viaje_link.js';

/** The canonical origin, the one the app's share links use. */
export const ORIGIN = WEB_ORIGIN;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PageHead {
  /** Path on ORIGIN, "/ruta/g47/". */
  url: string;
  title: string;
  description: string;
  /** Path of the page's own social card, when it has one. */
  ogImage?: string;
  noindex?: boolean;
}

/**
 * `html` with the one tag `pattern` finds replaced by `tag`. A shell edit that
 * reformats a tag throws here — failing the build — instead of every page
 * silently keeping the home page's. A function replacement, so a `$` in a title
 * is text, not a pattern (`$'` would paste the rest of the document there).
 */
export function swap(html: string, pattern: RegExp, tag: string): string {
  if (!pattern.test(html)) throw new Error(`The app shell has no ${pattern.source}`);
  return html.replace(pattern, () => tag);
}

/** `<meta attr="key" content="…">`, as the shell writes it. */
const meta = (attr: string, key: string) => new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\s*/?>`);

export function withHead(shell: string, page: PageHead): string {
  // Escaped: a `/viaje` address carries a query anyone can write. A slug has nothing to escape.
  const absolute = escapeHtml(`${ORIGIN}${page.url}`);
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);

  let html = shell;
  html = swap(html, /<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  if (page.noindex) html = swap(html, meta('name', 'robots'), '<meta name="robots" content="noindex, follow" />');
  html = swap(html, meta('name', 'description'), `<meta name="description" content="${description}" />`);
  html = swap(html, /<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${absolute}" />`);
  html = swap(html, meta('property', 'og:url'), `<meta property="og:url" content="${absolute}" />`);
  for (const [attr, key] of [['property', 'og:title'], ['name', 'twitter:title']] as const) {
    html = swap(html, meta(attr, key), `<meta ${attr}="${key}" content="${title}" />`);
  }
  for (const [attr, key] of [['property', 'og:description'], ['name', 'twitter:description']] as const) {
    html = swap(html, meta(attr, key), `<meta ${attr}="${key}" content="${description}" />`);
  }
  // Per-page social card. A WhatsApp forward is how these pages actually spread
  // (spec §5.5.4), and every page sharing one generic logo reads as spam.
  if (page.ogImage) {
    const card = `${ORIGIN}${page.ogImage}`;
    html = swap(html, meta('property', 'og:image'), `<meta property="og:image" content="${card}" />`);
    html = swap(html, meta('name', 'twitter:image'), `<meta name="twitter:image" content="${card}" />`);
    html = swap(html, meta('property', 'og:image:alt'), `<meta property="og:image:alt" content="${title}" />`);
  }
  return html;
}
