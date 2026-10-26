/**
 * A page's own head on the app shell (spec §5.5.4): title, description,
 * canonical, robots, and the Open Graph / Twitter tags a link preview reads.
 * Used by the prerender for every static page, and by the server for the pages
 * it answers live (`/viaje`, §5.6.7) — one rewrite, so both say the same tags.
 */

export const ORIGIN = 'https://mitrasto.app';

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

export function withHead(shell: string, page: PageHead): string {
  // Escaped: a `/viaje` address carries a query anyone can write. A slug has nothing to escape.
  const absolute = escapeHtml(`${ORIGIN}${page.url}`);
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);

  let html = shell;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  if (page.noindex) {
    html = html.replace(/<meta name="robots" content="[^"]*"\s*\/?>/, '<meta name="robots" content="noindex, follow" />');
  }
  html = html.replace(
    /<meta name="description" content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${description}" />`
  );
  html = html.replace(
    /<link rel="canonical" href="[^"]*"\s*\/?>/,
    `<link rel="canonical" href="${absolute}" />`
  );
  html = html.replace(
    /<meta property="og:url" content="[^"]*"\s*\/?>/,
    `<meta property="og:url" content="${absolute}" />`
  );
  for (const [attr, key] of [['property', 'og:title'], ['name', 'twitter:title']] as const) {
    html = html.replace(
      new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\s*/?>`),
      `<meta ${attr}="${key}" content="${title}" />`
    );
  }
  for (const [attr, key] of [['property', 'og:description'], ['name', 'twitter:description']] as const) {
    html = html.replace(
      new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\s*/?>`),
      `<meta ${attr}="${key}" content="${description}" />`
    );
  }
  // Per-page social card. A WhatsApp forward is how these pages actually spread
  // (spec §5.5.4), and every page sharing one generic logo reads as spam.
  if (page.ogImage) {
    const card = `${ORIGIN}${page.ogImage}`;
    html = html.replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${card}" />`);
    html = html.replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${card}" />`);
    html = html.replace(
      /<meta property="og:image:alt" content="[^"]*"\s*\/?>/,
      `<meta property="og:image:alt" content="${escapeHtml(page.title)}" />`
    );
  }
  return html;
}
