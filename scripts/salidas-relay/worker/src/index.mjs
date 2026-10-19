// Relays TRANSMILENIO's daily Salidas files to the station-demand sync
// (`server/src/sync_demand.ts`, spec §5.8) — a Cloudflare Worker.
//
// The files moved to validaciones.datosabiertos.transmilenio.gov.co on
// 2026-10-13, and that host answers 403 to GitHub's Actions runners from the
// first request while it serves the same files to a browser or a home
// connection. The daily workflow therefore downloads through here.
//
// One exact path and GET only, so it relays these files and nothing else: it
// is not a proxy anyone can point elsewhere. A day's file never changes once
// published, so a hit is kept at the edge for a day and repeat runs do not ask
// upstream again; a 404 (not published yet) only for five minutes.

const UPSTREAM = 'https://validaciones.datosabiertos.transmilenio.gov.co/Salidas/';
const FILE = /^\/Salidas\/(salidas\d{8}\.zip)$/;

export default {
  async fetch(request) {
    const file = FILE.exec(new URL(request.url).pathname)?.[1];
    if (request.method !== 'GET' || !file) return new Response('Not found', { status: 404 });

    const upstream = await fetch(UPSTREAM + file, {
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400, 404: 300, '400-599': 0 } },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/zip' },
    });
  },
};
