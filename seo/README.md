# `seo/` — crawler-facing root files

Everything a search engine fetches from the **site root** but that is not client
build output. Single source of truth; nothing here is copied or generated.

| File | Public URL | Purpose |
|---|---|---|
| `robots.txt` | `/robots.txt` | Crawl policy + sitemap pointer. Disallows `/api/`, `/models/`, `/draco/`. |
| `googlebb8cb92194ccf198.html` | `/googlebb8cb92194ccf198.html` | Google Search Console site-ownership token. Google fetches this exact root path — never move it into a subdirectory or rename it. |

## The sitemaps are **not** here

They used to be — a single hand-written `/` entry, back when hash routing made `/`
the only indexable URL. `server/src/prerender_seo.ts` now emits a real page per
route and estación (`/ruta/<code>/`, `/estacion/<slug>-<codigo>/`, spec §5.5.4),
so the sitemaps are build output and are written into **`client/dist`**:

| Generated file | Public URL |
|---|---|
| `sitemap.xml` | index over the four below |
| `sitemap-paginas.xml` | `/` and the indexable legal pages |
| `sitemap-rutas.xml` | TransMilenio route pages |
| `sitemap-estaciones.xml` | troncal estación pages (the noindex choosers left out) |
| `sitemap-zonales.xml` | the zonal route pages released so far (`server/src/seo_zonal.ts`) |
| `sitemap-lastmod.json` | `/sitemap-lastmod.json` — URL → content hash + the day it last changed; the next build reads it to keep each page's `lastmod` (`server/src/seo_lastmod.ts`) |
| `llms.txt` | `/llms.txt` — the site described for language models (llmstxt.org), listing the same pages as the sitemaps (`server/src/llms_txt.ts`) |

They still answer at the site root because the `client/dist` mount comes *before*
this folder's mount in `server/src/index.ts`. Keeping them out of `seo/` preserves
the rule below: nothing in this directory is generated.

## How they reach the root

`server/src/index.ts` mounts this folder with `express.static` right after the
client `dist` mount, so the files are served at `/` without being duplicated into
`client/public` (spec §5.5.4). `Cache-Control: public, max-age=3600`.

They are therefore served by the **Express server only** — `vite dev` (5173)
proxies just `/api`, so `http://localhost:5173/robots.txt` 404s. Verify against
the built server (`npm run build && npm start`) or production.

## Canonical origin

`https://mitrasto.app` — in code once, as `WEB_ORIGIN` in `shared/viaje_link.js`
(the server's `ORIGIN` and `CANONICAL_HOST` are derived from it). The static files
hardcode it: `robots.txt` here and `client/index.html`. So does the
`RELAY_CLIENT_ORIGINS` setting (README). Changing the domain means changing all of them.

Until 2026-10 it was `https://transmilenio.onrender.com`. Pages there answer
`301` to this origin (`server/src/retired_host.ts`); `/api` and files, this
folder's included, still answer in place.

## Checklist when the domain changes

1. `shared/viaje_link.js` → `WEB_ORIGIN`. It stamps every canonical, `og:url`,
   JSON-LD `url`, sitemap `<loc>` and `llms.txt` link, the old-host redirect
   target, and the links the website and the app share (the app's ship with the
   next APK tag).
2. `robots.txt` → `Sitemap:` line + header comment.
3. `client/index.html` → `canonical`, `og:url`, `og:image`, JSON-LD `url`.
4. `server/src/retired_host.ts` → add the host being left to `RETIRED_HOSTS`.
5. Re-verify the property in Search Console and resubmit the sitemap.
