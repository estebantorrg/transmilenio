# `seo/` — crawler-facing root files

Everything a search engine fetches from the **site root** but that is not client
build output. Single source of truth; nothing here is copied or generated.

| File | Public URL | Purpose |
|---|---|---|
| `robots.txt` | `/robots.txt` | Crawl policy + sitemap pointer. Disallows `/api/`, `/models/`, `/draco/`. |
| `googlebb8cb92194ccf198.html` | `/googlebb8cb92194ccf198.html` | Google Search Console site-ownership token. Google fetches this exact root path — never move it into a subdirectory or rename it. |

## The sitemaps are **not** here

They used to be — a single hand-written `/` entry, back when hash routing made `/`
the only indexable URL. `server/src/prerender_seo.ts` now emits 352 real pages
(`/ruta/<code>/`, `/estacion/<slug>-<codigo>/`, spec §5.5.4), so the sitemaps are
build output and are written into **`client/dist`**:

| Generated file | Public URL |
|---|---|
| `sitemap.xml` | index over the three below |
| `sitemap-paginas.xml` | `/` |
| `sitemap-rutas.xml` | 213 troncal route pages |
| `sitemap-estaciones.xml` | 139 troncal estación pages |

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

`https://transmilenio.onrender.com` — hardcoded in `robots.txt` here, in the
`ORIGIN` constant of `server/src/prerender_seo.ts`, in the `canonical`/`og:url`
tags in `client/index.html`, and in `RELAY_CLIENT_ORIGINS` (README). Changing the
domain means changing all of them.

## Checklist when the domain changes

1. `server/src/prerender_seo.ts` → the `ORIGIN` constant. It stamps every
   canonical, `og:url`, JSON-LD `url` and sitemap `<loc>` across all 352 pages.
2. `robots.txt` → `Sitemap:` line + header comment.
3. `client/index.html` → `canonical`, `og:url`, `og:image`, JSON-LD `url`.
4. Re-verify the property in Search Console and resubmit the sitemap.
