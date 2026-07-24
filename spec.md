# TransMilenio Explorer — Technical Specification

Authoritative spec for TransMilenio Explorer transit intelligence platform, governs all architecture, security, compliance. Follow precisely.

---

## 1. Priorities (Strict Order)

1. **Certainty** — Don't assume, don't guess. Verify facts via upstream APIs or ArcGIS query interfaces.
2. **Performance** — Sub-5s initial map load. Sub-100ms route search. Sub-250ms route selection response.
3. **Stability** — Resilient catalog fallback. App opens even if live tracking or ArcGIS layers degrade.
4. **Accuracy & Freshness** — Combine official app data, ArcGIS feature geometry, local normalization.
5. **Simplicity** — Minimize code complexity. No duplicated logic. Direct, predictable data pipelines.
6. **User Experience** — Seamless map-based exploration. Dense, glanceable info. Smooth sidebar/map flows.

### 1.1 Engineering Rules (Non-Negotiable)

These rules govern every change. Violations block merge.

| Rule | Mandate |
|---|---|
| **R1 — Zero band-aid fixes** | Every defect fixed at root cause. No try/catch swallowing symptoms. No commented-out code, no `// TODO: revisit`, no `eslint-disable` silencing warnings. If proper fix too large for current change, open tracked issue. |
| **R2 — Clean, performant, maintainable** | Every change preserves: (a) **cleanliness** — no dead code, no duplicated logic; (b) **performance** — no blocking ops on Node event loop, optimized client-side MapLibre render; (c) **maintainability** — clean function signatures, clear naming, config documented in this spec. |
| **R3 — Conventional Commits, never auto-commit** | The agent NEVER runs `git commit` or `git push` unless the user explicitly asks for it in that request. Instead, for every change the agent produces a Conventional Commit message and includes it in its output for the user to use. When the user does ask to commit/push, default target is `main` unless a different branch, pull request, or release flow is requested. Commits are **title-only** — a single `type(scope): subject` line (≤72 chars), no body, with valid types (feat, fix, docs, style, refactor, perf, test, chore). |

---

## 2. Technology Stack & Architecture

### 2.1 Stack Definition

| Layer | Technology |
|---|---|
| **Frontend Client** | Vite 5 + TypeScript + MapLibre GL JS + three.js (3D bus layer, §5.2.6) |
| **Backend API** | Node.js + Express + TypeScript (compiled to ESModule) |
| **Data Sync / Exec** | tsx (TypeScript Execute) + PowerShell scripts |
| **Data / Cache** | Local JSON (`master_catalog.json`) + In-memory TTL caches |
| **Mobile Shell** | Capacitor 6 (Android, `mobile/`) bundling a dedicated app UI; native HTTP **direct to the official TransMi / public hosts** for all data, catalog + POI bundled in the APK — no web server of ours in the path (§5.2.1b) |

### 2.2 System Flow

```
Browser (MapLibre GL JS) → Express API (Node.js) → Master Catalog (Local JSON)
        │                          ↓             ↓
        │                    ArcGIS Server   Colombia Live Relay / public CO proxy
        └─ live (§5.2.1a): Live Bridge extension / CO relay direct → TransMi live API
```

### 2.3 Architecture Rules

* **Client Isolation**: Vite client is presentation layer only. Manages MapLibre layers, search states, timeline renderings. Requests `/api/*` from backend, never calls external transit APIs directly. **Exception — live tracking (§5.2):** when the Live Bridge extension is present, the client routes live-bus requests through it so they originate from the *user's* Colombian connection; the page itself still never `fetch`es the live API (browser CORS forbids it), and absent the extension it falls back to `/api/buses`.
* **Express Engine**: Backend Express API is data aggregator and query cache. Sole component reading master catalog JSON or calling external ArcGIS/TransMi endpoints.
* **Relay Separation**: Live vehicle positions routed through a separate Colombia-based relay for geographic API constraints. The main Express backend authorizes server→relay requests with a secret (§3.1); in browser-direct mode the relay instead trusts allow-listed origins via CORS (§5.2.2).

---

## 3. Security & Isolation

### 3.1 Relay Secret Verification
When `TRANSMILENIO_COLOMBIA_RELAY_SECRET` set in environment, main Express server signs/authorizes relay requests. Relay verifies secret by inspecting headers:
```text
Authorization: Bearer <secret>
x-relay-secret: <secret>
```

### 3.2 CORS & Origins
* **Production**: Express server allows origins matching `CLIENT_ORIGINS` env var (comma-separated).
* **Development**: Allows `localhost` and `127.0.0.1` by default.

### 3.3 Safe Data Processing
* **Text Escaping**: All external string data from official/ArcGIS APIs treated as untrusted. Escape before inserting into UI popups or DOM.
* **Zero PII Storage**: No user personal data, account info, or credentials stored. Geolocation permissions processed client-side only.

### 3.4 Rate Limiting & Flow Control
* Client enforces 15-second polling window on live bus tracking.
* Network retries rate-limited via exponential backoff (2s, 4s, 8s, 16s) up to 4 retries for standard endpoints, **1 retry for ArcGIS-backed map layers** (they are fetched in parallel at boot and must not stall first paint — deeper recovery is §4.2's background pass), 0 retries for live bus requests.
* **Retryable = every `5xx` + every transport failure** (`isRetryable`, `client/src/services/api.ts`). Singling out `502/503/504` made a plain `500` terminal, so the ladder never ran for the failure it exists for; `4xx` stays non-retryable.

---

## 4. Error Handling & Resilience

### 4.1 Express API
* **No Silent Failures**: Unhandled exceptions are caught and logged server-side; clients never receive stack traces.
* **Structured Responses**: Routing/unknown-endpoint errors return `{ status: "error", message: string }`; data endpoints return `{ success: false, error: string }`.
* **Resilient Upstream Handling**: If ArcGIS/TransMi APIs timeout or error, API returns a structured HTTP fallback status — no crashes, no leaked stack traces. The ArcGIS-backed feature endpoints answer **`503` + `Retry-After`**, never `500`: the layer is momentarily unreachable, not broken, and the distinction is what keeps the client's backoff ladder alive (§3.4). All eight share one handler (`featureEndpoint`, `routes/api.ts`).

### 4.2 Vite Client (Graceful Degradation)
* **Outage Fallback**: Master catalog is critical. If loading fails, blocking UI overlay shown.
* **ArcGIS Failure — no layer is ever lost for a session.** Every ArcGIS-backed layer is fetched once, in parallel, at page open. A transient upstream failure there used to be permanent: the layer rendered empty and nothing retried, so a random default-on layer (trunk trazado, station pins) was simply missing until the user reloaded. Three mechanisms make that impossible:
  1. **Substitute immediately from the catalog.** Stations rebuild from the (required) master catalog (`catalogStationsToFeatures`, `stations.ts`); trunk corridors rebuild from the official `trazado` of the routes that ride them, merged per trunk letter (`catalogCorridorsToFeatures`, `routes.ts`) — the ArcGIS centreline is survey geometry with no catalog twin, so the routes' own traces are the substitute. Troncal route lines already come from catalog `trazado` (ArcGIS only enriches them), so `/troncal/routes` failing is invisible. ArcGIS-only metadata (wifi, biciestación) is simply absent in that mode. TransMiCable has no catalog twin at all and can only be recovered.
  2. **Recover in the background** (`recoverLayer`, `main.ts`). Whatever opened degraded is retried after first paint on a widening schedule (4s, 12s, 30s, 60s) and applied in place through the layers' own update paths (`updateStationsLayer`, `updateTroncalCorridors`, `updateCableLayers`, `updateStopsLayer`). Every `add*Layer` is idempotent so a recovered payload re-enters the same pipeline instead of throwing on a live source.
  3. **Never lose the pins to a missing icon.** A symbol layer whose `icon-image` is unregistered renders *nothing*. `map.ts` registers the three pin icons up front **and** answers `styleimagemissing`, so a pin cannot be lost to ordering or a style reload.
  * Covered by `tests/arcgis-layers.spec.ts` (healthy boot renders every default layer; a simulated ArcGIS outage still draws corridors + stations and then recovers them).
* **Live Outage**: If live tracking fails, route detail panel continues displaying static timeline stops. If a recent fix is cached (§5.2.5), the server serves it tagged `stale`/`asOf` and the client shows the last positions with a "datos de HH:MM" indicator rather than blanking the map.

### 4.3 Database & Catalog Writes
* **Atomic Writing**: `syncMasterCatalog()` writes to temp file (`master_catalog.json.tmp`), atomic rename once successful.
* **Read Continuity**: During catalog sync, Express backend serves previous catalog from memory. In-memory catalog replaced only after atomic write finishes.

---

## 5. Core Features & Data Flow

### 5.1 Catalog Sync & TransMi API

#### 5.1.1 Catalog Loader Endpoint
* **Base URL**: `https://api.buscador-rutas.transmilenio.gov.co/loader.php`
* **Sync Client File**: `server/src/services/tm_api.ts`
* **Required Headers**:
  ```text
  Accept-Encoding: gzip
  Connection: Keep-Alive
  Host: api.buscador-rutas.transmilenio.gov.co
  User-Agent: okhttp/4.12.0
  uuid: fd1be953-d85e-4c63-8c23-234f143f445d
  version: 2.9.5
  ```

#### 5.1.2 API Functions
* **Route Search**:
  `lServicio=Rutas & lTipo=api & lFuncion=searchRutaByTipo & tipo_ruta=TIPORUTA & search=<seed>`
  * Seed set: `["", "A".."Z", "0".."9"]`
* **Route Detail**:
  `lServicio=Rutas & lTipo=api & lFuncion=infoRuta & idRuta=<id> & nombre=<name> & codigo=<code>`
  * Extracts: `recorrido.data[]` (ordered stops), `0.color`, `0.horarios`, `0.sistema`, `0.tipoServicio`, `0.trazado` (GeoJSON LineString/MultiLineString).

#### 5.1.3 Catalog Sync Algorithm
1. Search routes using complete seed set.
2. Filter to `TransMilenio` and `TransMiZonal` families.
3. Fetch detail payload (`infoRuta`) for each distinct route.
4. Normalize stop/station mappings under `stations.wagons`.
5. Write catalog atomically to `server/src/data/master_catalog.json`.
* **Sync Safeguards**:
  * Random delay 800ms–1500ms between calls.
  * Max retries: 3. Retry delay: 3000ms.
  * Stale catalog limit: 7 days.
  * **Memory**: a full sync briefly holds the previous + freshly-fetched catalogs at once; `mergeCatalogs` grafts the previous INTO the fresh catalog **in place** (no third ~220 MB copy). Boot **auto-sync is OFF by default** — it OOM-kills a small web instance and would overwrite the curated Git-LFS catalog with a partial fetch. Production serves the committed catalog read-only (§4.3); refresh it offline via `npm run sync` (its own process) and redeploy. Opt into boot auto-sync with `TM_ENABLE_AUTO_SYNC=1` only on a host with ≥1 GB headroom.
  * **Heap sizing**: the web process caps V8 old-space to fit its container (`node --max-old-space-size=460`, root `start`) so GC runs before the platform OOM-kills — never `2048` on a 512 MB instance. `GET /api/health` exposes `memory` (`rssMB`, `heapUsedMB`, …) for monitoring.

#### 5.1.4 Lightweight Catalog
`getCatalogLight()` formats condensed payload for browser transport:
* Compresses zonal stops to basic codes and color tags.
* Simplifies trace coordinate arrays to max 160 coordinates per route variant.

---

### 5.2 Live Tracking & Colombia Relay

#### 5.2.1 Target API Host
* **Base Host**: `https://tmsa-transmiapp-shvpc.uc.r.appspot.com`
* **Constraints (verified)**: The host is **CO-IP geofenced** (non-CO egress → `401`/`451`) and serves **no CORS** — `OPTIONS` preflight → `403 Invalid CORS request`, response carries no `Access-Control-Allow-Origin`. A normal page `fetch` therefore cannot read it; only `Appid` is a required request header (`User-Agent`/`uuid`/`version` are not).

#### 5.2.1a Client-Direct Bridge (preferred)
* Live requests are made from the **user's own browser** via the optional **Live Bridge** extension (`extension/`). Its background fetch is exempt from page CORS and egresses from the user's Colombian IP, satisfying both constraints with no server in the live path.
* Transport: private `window.postMessage` channel `tm-live-bridge/v1` (page ⇄ content script ⇄ background worker). Client module: `client/src/services/liveBridge.ts`; the background worker only ever contacts the live host with fixed request shapes (no page-supplied URLs).
* **Fallback chain** (`client/src/services/api.ts` → `getLiveBuses`): native app HTTP (§5.2.1b) → Live Bridge extension → direct CO relay (`VITE_LIVE_RELAY_URL`, §5.2.2 browser-direct) → `/api/buses` (main server relay). Each tier degrades gracefully to the next (spec §4.2); absent both the extension and a configured relay, behavior is unchanged.

#### 5.2.1b Native Android App (`mobile/`)
* Capacitor 6 shell bundling a **dedicated app UI** ("TransMi Go", `client/mobile/`) — a ground-up bottom-tab front-end that must look nothing like the website but reuses ONLY the website's data/service layer via the `@shared` alias (→ `client/src`), so the two clients never drift (spec §1.1 R2). Built by `client`'s `build:mobile`/`dev:mobile` scripts (Vite `--config mobile/vite.config.ts`); `mobile/scripts/build-web.mjs` runs `build:mobile` → `mobile/www` (website `client/dist` untouched). Runtime-only Capacitor detection (`window.Capacitor`), so the web build gains no dependency.
* **No server of ours in the path** — the app is a native peer of the official TransMi app, not a client of our website. It talks to the official government / public hosts **directly** via native HTTP (`CapacitorHttp`, exempt from webview CORS, egressing from the phone's own Colombian IP), and reads the two payloads with no single official endpoint from **APK-bundled assets**. This is the mobile exception to §2.3 (the browser client still calls `/api/*`); `CLIENT_ORIGINS` needs no app entry because the app never calls our server. The switch is one branch in the shared `api.ts` (`isNativeLiveAvailable()` → `client/src/services/officialApi.ts`), so the two clients stay in sync (spec §1.1 R2).
* **Bundled offline data**: the master catalog and the offline-aggregated POI/demand datasets (recharge points §5.5.1, TransMiBici §5.3, station-demand §5.8) have no single official endpoint, so they ship **inside the APK** — generated from the committed server data by `npm run bundle:mobile` (`server/src/bundle_mobile_data.ts` → `client/mobile/src/generated/`, regenerated on every `mobile` build:web, gitignored). `data.ts` reads them from local assets (`?url`, served by Capacitor with no network), so boot is instant and fully offline; they refresh only on app update. The catalog uses the exact `getCatalogLight()` transform the API serves, so the two clients never drift (spec §1.1 R2).
* **Direct hosts** (native, gated by `isNativeLiveAvailable()` in `api.ts` → `officialApi.ts`): **ArcGIS** troncal/zonal layers → `gis.transmilenio.gov.co` (§5.3, same pagination as the server); **live tier 0** troncal/zonal buses → the live host (`CapacitorHttp`, same name-candidate loop as the extension worker); **arrivals** → `POST /paradero/buses`; **card ledger** → `POST /lectura_tarjeta` (§5.5.1a — the phone's CO IP satisfies the geofence natively, no proxy); **walking geometry** → public OSRM foot (§5.6). Outside CO the geofence rejects the live/card calls and they degrade exactly as the web tiers do.
* **Service worker**: not registered inside the app (main-entry guard) — assets ship in the APK, and the bundled catalog above replaces any need for SW caching (which would only risk stale catalogs).
* **Permissions**: `INTERNET`, `ACCESS_COARSE_LOCATION`/`ACCESS_FINE_LOCATION` (webview geolocation for "mi ubicación").

#### 5.2.2 Relay Setup
* Live tracking requires Colombia egress IP. Relay file: `server/src/colombia_live_relay.ts`. Recommended host: an always-on CO box or an **Oracle Cloud Always Free** VM in the **Bogotá** region, exposed over **HTTPS** (Tailscale Funnel / Cloudflare Tunnel — required, the app is https and mixed content is blocked).
* Relay checks egress country using `https://www.cloudflare.com/cdn-cgi/trace` (cached 30s).
* Egress `/health` responses: `200` (Colombia), `451` (outside CO), `503` (check error).
* **Browser-direct mode (preferred, PC + mobile, no install):** set `RELAY_CLIENT_ORIGINS` (comma-separated app origins). The relay serves CORS for those origins and the browser calls it straight (`VITE_LIVE_RELAY_URL` on the client). Allow-listed browser origins need no secret; the relay returns only public, CO-gated bus positions. The relay runs the troncal name-candidate loop itself.
* **Server-relay mode (fallback):** `TRANSMILENIO_COLOMBIA_RELAY_URL` + `TRANSMILENIO_COLOMBIA_RELAY_SECRET` — the main server signs and forwards (spec §3.1). The implemented, recommended backend for this mode is the serverless OCI Function relay (§5.2.2a).

#### 5.2.2a OCI Function Relay (serverless CO egress — implemented)

The reliable Colombia egress backing `TRANSMILENIO_COLOMBIA_RELAY_URL` is an **Oracle Cloud Always-Free Function** in the **Bogotá** region (`sa-bogota-1`), fronted by an **OCI API Gateway** — chosen over an always-on VM because the Always-Free A1.Flex compute pool in Bogotá is chronically capacity-exhausted (`Out of host capacity`), while Functions egress from a Colombian datacenter IP the live host accepts (verified with real bus data). It replaces the flaky free public proxy pool (§5.2.5) as the primary CO egress.

* **Egress path**: the Function runs in a **private subnet** whose only route out is a **NAT gateway**, so its egress IP is Colombian and satisfies the §5.2.1 geofence. The **API Gateway** (public subnet + internet gateway, NSG allowing `443`) is the sole public surface; gateway→Function is authorized by an IAM resource-principal policy.
* **Function** (`scripts/oci-func/func.js`, Node 20 FDK) — a **controlled forwarder, not an open proxy**. Both request shapes are `RELAY_SECRET`-gated and restricted to the fixed live host (§5.2.1) plus an **allowlisted path set** (`/buses`, `/location/ruta`, `/paradero/buses`, `/lectura_tarjeta`) so it cannot be turned into an SSRF pivot:
  * `POST <gateway>/relay/buses` — buses convenience shape `{action:'zonal'|'troncal', ruta, Nombre}` → `{ruta, action, upstreamStatus, buses}`; backs the live-bus `co-relay` tier (§5.2.1a fallback chain).
  * `POST <gateway>/relay/forward` — generic `{path, method, body}` → `{upstreamStatus, payload}`. The caller inspects `upstreamStatus` (the Function returns HTTP 200 whenever the upstream was *reached*, so a service-window `400` is surfaced as data, not a transport error).
* **Auth**: server→gateway sends `Authorization: Bearer <TRANSMILENIO_COLOMBIA_RELAY_SECRET>`, verified against the Function's `RELAY_SECRET` config (§3.1). Absent the secret the Function refuses (`403`).
* **Server client** (`server/src/services/co_relay.ts` → `relayForward`): **every CO-IP-geofenced endpoint prefers this relay ahead of the public proxy pool** — cascade **direct → CO relay → public CO proxy**: live buses (`fetchLiveBuses`), arrivals (`fetchArrivals`, §5.5.1), and card balance (`fetchCardBalance`, §5.5.1a). Card reads work 24/7; buses/arrivals need the live service window (below).
* **Live service window**: outside ~05:00–23:00 Bogotá the live host answers `400 {"detail":"Service Not Available"}` to *any* CO client (verified by direct in-country request that bypasses the relay), a few night routes aside. Empty overnight bus/arrival results are the upstream being closed, **not** a relay fault.
* **CI/CD** (`.github/workflows/deploy-relay.yml`): the maintainer's local Docker is unavailable, so the Function auto-deploys from **GitHub Actions** on any push touching `scripts/oci-func/**` — build the image (`scripts/oci-func/Dockerfile`, base pinned to `fnproject/node:20`; an untagged base is pre-ES2020 and crashes the Function on load → gateway `502`), push to OCIR, update the Function via the OCI CLI (image tagged with the commit SHA). A dedicated **least-privilege** OCI user (`transmi-ci`; group `transmi-ci`; policy `transmi-ci-deploy` = manage repos + functions-family) authenticates via repo secrets: `OCI_PRIVATE_KEY_B64` (base64 so the multi-line PEM survives paste intact), `OCI_USER_OCID`, `OCI_FINGERPRINT`, `OCI_TENANCY_OCID`, `OCIR_USERNAME`, `OCIR_TOKEN`, `OCIR_NAMESPACE`. No Cloud Shell in the loop; server/client changes still deploy via the normal host (e.g. Render), untouched by this workflow.
* **Config**: `TRANSMILENIO_COLOMBIA_RELAY_URL` = the gateway deployment base (`https://<gateway-host>.apigateway.sa-bogota-1.oci.customer-oci.com/relay`; the tiers append `/buses` or `/forward`); `TRANSMILENIO_COLOMBIA_RELAY_SECRET` = the shared Bearer, also set as the Function's `RELAY_SECRET`.

#### 5.2.2b Cold-start budget (first fix of a tracking session)
Steady-state polling is bounded by the 15 s window (§3.4); what the user *feels* is the **first** fix after selecting a route, and every serial step in front of it is dead time. The rule: nothing that can run in parallel with the live request may run before it.

* **Client — request starts at selection** (`prefetchLiveBuses`, `client/src/services/api.ts`): route selection fires the live request immediately, then does the full-trace fetch (`/troncal/route/:code`), the lazy `layers/buses` import and the map work *while it is in flight*. `getLiveBuses` shares an in-flight (or <5 s settled) request for the same route, so `startBusTracking`'s first poll consumes the prefetch instead of starting a second request. The share key includes the **name candidates**: a prefetch made before the detail loaded is only reused when the tracking layer asks for exactly the same candidate set (a missing candidate can be the matching one, §5.2.4). Wired in `main.ts` → `onRouteSelect` and `client/mobile/src/map/mapController.ts` → `showRoute`.
* **Client — bridge probe never blocks**: the live cascade reads Live Bridge availability from cache only (`isLiveBridgeReady`); the content script announces itself at `document_start`, so an installed bridge is already known. Probing on the hot path would have put the 600 ms ping timeout in front of every request made by users without the extension; the probe now runs in the background for the *next* poll.
* **Client — 3D assets preloaded**: the `buses` chunk (three.js) and the Draco-decoded `bus_lod.glb` are warmed once the map is up (`preloadBusModels`), instead of downloading only after the first fix has already arrived.
* **Server — doomed tiers are skipped**: a `401`/`451` from the live host is an egress-wide verdict, so it is memoised (`TM_DIRECT_GEOFENCE_MEMO_MS`, default 10 min) and the direct tier is skipped for live buses and arrivals until it expires — a success clears it immediately.
* **Server — candidate fan-out resolves on first hit**: `runLiveStrategy` settles the moment a candidate returns buses and aborts the stragglers. Waiting for every candidate to settle pinned each response to the slowest one (the live host answers between ~0.3 s and its 9 s timeout). A valid empty result still requires all candidates, since only a non-empty hit proves the name matched. The native app (`nativeLive.ts`) and the extension worker (`extension/background.js`) do the same instead of their old sequential loops.
* **Server — connections and egress kept warm**: keep-alive agents for the live host and the relay (`tm_api.ts`, `co_relay.ts`) remove a TLS handshake per poll, and `startLiveWarmup()` (`TM_LIVE_WARMUP_MS`, default 240 s, `0` disables) probes the CO relay — the OCI Function drops its container when idle (§5.2.2a) — so the first real poll hits a hot Function over an open socket.

#### 5.2.3 Endpoint Requests
* **Troncal**: `POST /buses` with body `{"ruta": "<code-e.g.-B75>", "Nombre": "<name>"}`.
  * Headers: `Appid: 9a2c3b48f0c24ae9bfba38e94f27c3ea` (only required one — §5.2.1), plus `User-Agent: okhttp/4.12.0`, `version: 2.9.5`, `uuid` sent by the server/proxy paths for parity. Browser-based paths (extension/relay-direct) send `Appid` + `Content-Type` only.
* **Zonal**: `POST /location/ruta?ruta=<route_code>` with empty body.

#### 5.2.4 Normalization & Polling
* Normalizes response keys (`data`, `buses`, `vehiculos`, `lat`/`lng`) into unified model.
* Polling triggered in 15s intervals. Overlapping requests avoided via `fetchInFlight` locks.
* **Name Candidates**: Backend tries destination/origin candidate strings for troncal **in parallel**, resolving on the first **non-empty** hit and aborting the rest (a wrong name returns empty, not an error); falls through only when every candidate's transport throws. Every client-side transport (native, extension) races them the same way — see §5.2.2b.
* **Direction filter (client)**: The live API returns **both directions** of a route whenever the requested `Nombre` doesn't exactly match a destination — common for rutas duales/fáciles (number-only codes) whose catalog name differs from the API `destino_limpio` (e.g. "Portal El Dorado" vs "Portal Eldorado"). `buses.ts` → `filterBusesByDirection` keeps only buses whose `destino_limpio` loosely matches the **selected trip's** destination(s), so the opposite trip is not shown. Falls back to all buses if nothing matches (never blanks the map).

#### 5.2.5 Public CO Proxy Resilience (no card / host / install)
When no CO egress is otherwise available, set `TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY=1` and the main server reaches the live API through free public Colombian proxies. Hardened for the inherent flakiness of free proxies:
* **Pool** (`proxy_manager.ts`): scrapes multiple sources (Geonode CO pages, ProxyScrape CO, proxy-list.download CO, + a bounded global top-up). Every candidate is verified against the live API — the **geofence is the filter** (only CO exits return coordinates). Verified proxies are scored by success rate, latency, and recency; the pool is kept warm (10-min full refresh + 90-s top-up below `TARGET_POOL_SIZE`) and failing proxies are evicted.
* **Race**: each live request fires the best `CO_PROXY_RACE_WIDTH` (default 5) proxies in parallel and takes the fastest valid response; slower in-flight proxies are aborted. Per-proxy timeout `LIVE_PROXY_TIMEOUT_MS` (default 14 s; observed proxies 3–14 s).
* **Wave fallback**: when an entire wave dies (every raced proxy reset/timed out — routine for free proxies), the request falls through to the next-best, non-overlapping wave instead of failing, up to `CO_PROXY_MAX_WAVES` (default 3) waves or until the overall live budget (`LIVE_OVERALL_TIMEOUT_MS`, 14.5 s) is hit. A valid empty result (a working proxy, no buses on that name) resolves immediately and consumes no further waves.
* **Last-known cache** (`/api/buses`): the most recent non-empty fix per `routeType:ruta` is cached (10-min TTL). If every upstream path is momentarily down, the server serves it tagged `stale: true` + `asOf` instead of a blank map; the client renders it with a "datos de HH:MM" indicator (spec §4.2).
* **Observability**: `GET /api/health` exposes `proxyPool` (verified count, top proxies w/ latency) and `liveCacheEntries` when the fallback is enabled.
* **Now the last-resort tier**: with the OCI Function relay deployed (§5.2.2a) the public proxy pool sits **below** it in every cascade (direct → CO relay → public proxy) and is only reached if the relay is unset or momentarily down.
* **Honest limitation**: free proxies are best-effort; live tracking through them is intermittent. Reliable CO egress comes from the serverless OCI relay (§5.2.2a), a CO device, or a per-user install (extension/native) — see §5.2.1a / §5.2.2 / §5.2.2a.

#### 5.2.6 3D Bus Models
Every live bus renders as a 3D model in a single MapLibre custom WebGL layer (three.js).
* **Asset**: source `buscar.glb` (Draco-compressed geometry + webp texture). `scripts/bake-bus-pivot.mjs` bakes the node translation so the pivot is the **exact bottom-center of the wheels** (world `centerX = 0`, `minY = 0`, `centerZ = 0` — never the front), emitting `client/public/models/bus.glb`. The Draco buffer is never decoded server-side; the mandatory POSITION `min/max` + node TRS give the bbox.
* **Renderer**: `client/src/layers/busModelLayer.ts` — a `CustomLayerInterface` (`type:'custom'`, `renderingMode:'3d'`) that places one clone per bus at its `MercatorCoordinate` (altitude 0 → wheels on ground). **One model family is used for all bus types** (troncal / zonal / alimentador).
* **LOD**: `bus_lod.glb` (also pivot-baked from `busscar_LOD.glb`) loads immediately and renders when zoomed out; the full `bus.glb` is **lazy-loaded** the first time the user zooms in past `LOD_ZOOM` and shown from then on at close range.
* **Motion**: positions tween from the previous fix to the new one across the poll interval (glide, no snapping). Heading uses the telemetry `angulo` (compass bearing; nose is +Z → `rotation.z = angulo`).
* **Opaque**: model materials forced opaque on load (`transparent=false`, `depthWrite=true`) so buses are never see-through; max texture anisotropy.
* **Declump**: buses sharing a spot are fanned out in a small ring (`declump()`) so a cluster doesn't render as one blob.
* **Precision**: rendered relative to a per-frame local origin (map centre) → no mercator float jitter while panning.
* **Pivot rule (non-negotiable)**: bottom-center of the wheels. Placement uses the pivot directly — no front offset.
* **Interaction**: click pixel-picks the nearest bus → info popup. The popup **follows its bus every frame** (`setFollow`) and its route badge is tinted with the route's own color (`getRouteAccentColor`), not a fixed red.
* **Tunables** (`busModelLayer.ts`): `MODEL_SCALE`, `SCALE_REF_ZOOM` + `MAX_ZOOM_BOOST` (stay visible zoomed out), `LOD_ZOOM`, `DECLUMP_RING`, `BASE_TILT` (glTF Y-up → mercator Z-up).
* **Dependency**: `three` (client). Draco decoder files copied to `client/public/draco/`.

---

### 5.3 ArcGIS FeatureServer Integration

#### 5.3.1 ArcGIS Query Specifications
* **Base URL**: `https://gis.transmilenio.gov.co/arcgis/rest/services`
* **Query Params**: `where=1=1`, `outFields=*`, `outSR=4326`, `f=json`, `returnGeometry=true`.
* Uses cursor pagination based on `exceededTransferLimit === true`.
* **Per-page retries** (`arcgis.ts`): a failed page is retried up to 3 times (600 ms, 1200 ms) before the query gives up, so one blip on one page of a multi-page layer cannot cost the whole layer. Failures ArcGIS attributes to the *caller* — HTTP `4xx`, or its `200`-with-`error.code` envelope in the 400s — are not retried. Exhaustion raises `ArcGISUnavailableError` → `503` (§4.1).
* **Server cache** (10-min TTL, `routes/api.ts`): concurrent first-hits share one in-flight query; on failure the last good payload keeps being served and the next upstream attempt is paced 30 s apart, so a down ArcGIS never puts the full retry budget in front of every request.
* **Boot prewarm**: the two default-on layers (`consulta_estaciones_troncales`, `consulta_trazados_troncales`, ~190 KB combined) are cached right after `listen` (`prewarmArcgisLayers`). The first visitor after a cold start would otherwise trigger five concurrent ArcGIS queries on a 0.1-CPU instance — the burst that made a random layer time out. Deliberately excludes the heavy layers so boot memory is untouched (§5.1.3).

#### 5.3.2 Queried Layers
* **Troncal**: `Troncal/consulta_rutas_troncales`, `consulta_estaciones_troncales`, `consulta_esquemas_estaciones`, `consulta_trazados_troncales`.
* **Zonal**: `Zonal/consulta_rutas_zonales`, `consulta_paraderos_zonales`, `consulta_paraderos_rutas`.
* **Additional**: `consulta_conexiones_troncales`, `consultaEquivalenciaEstaciones`.

---

### 5.4 Station & Zonal Stop Intelligence

#### 5.4.1 Station Resolver
Reconciles ArcGIS points with TransMi catalog stops.
* **Match Order**:
  1. Terminal platform clusters (merging fragments within 180m).
  2. Verified platform splits (`VERIFIED_SPLITS`, see below).
  3. Exact ID match.
  4. Name and distance proximity.
* **Verified platform splits**: Avenida Jiménez (`TM0013`) and Ricaurte (`TM0069`) are each physically **two separate stations** — a Caracas/NQS trunk platform and a Calle 13 platform. The official app files each pair under **one merged stop code**, but ArcGIS exposes each platform as its own point. `VERIFIED_SPLITS` (`stationCatalogResolver.ts`) splits the merged catalog stop back into its platforms **by wagon**, so both stations render distinctly with their own name and route set: Av. Jiménez → Caracas (`TM0013` wagons `A,B,C`, node `9110`) + CL 13 (wagons `D,E`, node `14003`); Ricaurte → NQS (`TM0069` wagons `A,B,C`, node `7111`) + CL 13 (wagons `D,E,F`, node `12003`). The two ArcGIS platform points are matched by node id / normalized name; wagon partitions are kept in sync with the catalog.
* **Both-direction route tags** (`groupCatalogRoutesByDirection`, `stations.ts`): A TransMilenio route serves a station in **both directions**, so each direction is shown as its own tag. Wagon route tags are grouped by **código + destination name** — so a ruta fácil like `3` shows `3 → Portal Tunal` AND `3 → Corferias` (both directions; data carries both as distinct ids/nombres), and lettered pairs `B72`/`H72` show as their two codes. Only genuine duplicates (same código **and** destination) collapse into one tag; the tooltip lists the destination(s). Wagons are left exactly as the catalog files them (no merging across platforms).
* **Audit**: Diagnostic output exposed via `window.__tmStationAudit`.

#### 5.4.2 Zonal Stop Resolver
Aggregates route tags from ArcGIS `consulta_paraderos_rutas` and catalog fallbacks. Deduplicates by normalized route code.

#### 5.4.1a Estación vs Paradero split (mobile)
The API serves the **light** catalog, whose `stations` map merges troncal estaciones and zonal paraderos and carries no `sistema`. The mobile app therefore classifies purely by CODE (`client/mobile/src/data.ts` → `catalogPointRecords`): `TM…`-coded nodes (~140) are estaciones (red), everything else is a paradero (~7400, cyan). This drives the map's station/paradero layers + the Cerca kind badges + filters, so the two are never conflated.

#### 5.4.2a SITP Zone Browse (`consulta_rutas_zonales`)
The zonal-routes layer assigns every zonal route to **numeric SITP zones** (1–13; `0` = portal/troncal terminus) via `zona_origen_ruta_zonal` + `zona_destino_ruta_zonal` — authoritative even for numeric-coded routes that carry no zone letter (e.g. `661`, `139`). The mobile app's "Zonas SITP" browse builds a `code → zones[]` map from this feed (`client/mobile/src/data.ts` → `buildZonalAreas` / `variantBase`, which collapses catalog zero-padding `F019`→`F19` and direction/variant suffixes so both spellings match). This is separate from the troncal "líneas" (corridor letters A–P, a different taxonomy). `/api/zonal/routes` is served **attributes-only** (`returnGeometry=false`) — the route geometries are unused (zonal lines come from catalog trazado) and returning them timed the endpoint out.

#### 5.4.3 Route Color Palette
* **Trunk Corridors**:
  * `A`: `#0C3A95` | `B`: `#75C347` | `C`: `#FFB741` | `D`: `#6867B4`
  * `E`: `#B76416` | `F`: `#FB2C17` | `G`: `#00B0E8` | `H`: `#FF8525`
  * `J`: `#E49DAA` | `K`: `#D3AA78` | `L`: `#00B0A9` | `M`: `#852D89`
  * `P`: `#25206F` | `T`: `#808000` | `RF`: `#000000` | `Z`: `#EAB308`
* **Special Cases**: Alimentador `#009944`. Zonal default `#00608B`. Troncal default `#FB2C17`.

---

### 5.5 Backend API Contract & Local Dev Configuration

#### 5.5.1 API Endpoints
All mounted on `/api`. These serve the **browser client**; the native app does not call them — it hits the official hosts directly and reads the catalog/POIs from bundled assets (§5.2.1b).
* `GET /api/health`: Exposes catalog status (`catalogStale`, `syncInProgress`, `catalogStations`), ArcGIS + live cache entry counts (`cacheEntries`, `liveCacheEntries`), `liveTrackingVersion`, uptime, and — when the public-proxy fallback is enabled — `proxyPool` stats (§5.2.5).
* `GET /api/debug-buses`: Test payload endpoint (tests route `1` / `Universidades`).
* `GET /api/geoip`: Approximate client location from IP (fallback when native geolocation is blocked; zero PII stored — §3.3).
* `GET /api/troncal/routes`, `/api/troncal/stations`, `/api/troncal/corridors`, `/api/troncal/master-catalog`, `/api/troncal/route/:code`, `/api/troncal/station/:code`, `POST /api/troncal/sync`, `/api/zonal/routes`, `/api/zonal/stops`, `/api/zonal/stop-routes`, `POST /api/buses`, `POST /api/card/read`.
* `POST /api/arrivals`: real-time arrivals/ETAs at a paradero (`{paradero:"<cenefa>"}` → `{arrivals:[...]}`), reusing the live-bus transport cascade (direct → CO relay §5.2.2a → public CO proxy). Never hard-fails — empty list on outage (§5.8 Host 2).
* `GET /api/walking-route`: real pedestrian route geometry between two points (OSRM foot profile), consumed by the planner's `enrichWalkingGeometries()` to replace straight-line walk-leg estimates with real distance/time/path (§5.6).
* `GET /api/recarga-points`: static tullave recharge-point catalog (name/address/hours), committed from a Colombian egress like the master catalog — see `server/src/sync_recarga.ts` (§5.8 Host 2).
* `GET /api/station-demand`: mean weekday entry/exit (validation) counts per troncal station, aggregated offline from the open **Salidas** dataset and committed — see `server/src/sync_demand.ts` (§5.8 Validaciones). Powers the "Demanda" heat overlay on both clients (website `client/src/layers/demandLayer.ts`; app `tm-demand` layer in `client/mobile/src/map/mapController.ts`, tap → toast) — an independent graduated-circle layer keyed on its own coordinates so it never couples to the station resolver.
* `GET /api/transmibici`: static TransMiBici bike-parking POI catalog (name/capacity/occupancy) from ArcGIS `Consulta_Planificacion_SITP` layer 12 — see `server/src/sync_transmibici.ts` (§5.3). Surfaced as the Cerca "Bici" kind on both clients.

#### 5.5.1a Lectura de saldo
* **Upstream host**: `https://tmsa-transmiapp-shvpc.uc.r.appspot.com`.
* **Endpoint**: `POST /lectura_tarjeta`.
* **Request body**: `{"numero_tarjeta":"<digits>","consultar":"false"}`. `consultar` is a string (`"true"` / `"false"`), not a boolean.
* **Required observed headers**:
  ```text
  Accept-Encoding: gzip
  Appid: 9a2c3b48f0c24ae9bfba38e94f27c3ea
  Connection: Keep-Alive
  Content-Type: application/json; charset=UTF-8
  Host: tmsa-transmiapp-shvpc.uc.r.appspot.com
  User-Agent: okhttp/4.12.0
  uuid: fd1be953-d85e-4c63-8c23-234f143f445d
  version: 2.9.5
  ```
  `Content-Length` must be computed from the exact JSON body bytes.
* **Server contract**: `/api/card/read` validates the card number, sends the exact upstream shape, decodes gzip, does not cache, and never logs or stores the full card number. Because the host is CO-IP geofenced, the read follows the same egress cascade as live buses — **direct → CO relay (§5.2.2a, forwards `/lectura_tarjeta`) → public CO proxy** (`fetchCardRowsViaColombianEgress`, `card_balance.ts`); unlike live buses the card endpoint is not service-window-gated, so it resolves 24/7 given any working CO egress.
* **Source separation**: `/lectura_tarjeta` returns the server ledger only. The official mobile UI can show newer balance and multiple movements after a phone tap because it reads NFC card memory locally. Web/server code must not infer or fabricate those hidden card movements from the server response. Any future NFC/native bridge must merge as `source:"card"` with provenance distinct from `source:"server"`.
* **App NFC read (`client/mobile/src/services/nfc.ts`)**: three runtime-detected backends, so the web bundle keeps no hard dependency and needs no code import — detection is runtime-only. Android's System WebView **disables Web NFC** (`NDEFReader` → "NFC permission request denied"), so inside the APK a **native plugin is mandatory**; the app tries them in order: (1) **`phonegap-nfc`** (free/MIT, `window.nfc`) — a declared `mobile/` dependency, so it registers automatically on `npm install` + `npm run apk` (which runs `cap sync`), no manual plugin install (patched for Android 12+/14 — see [[apk-nfc-beam-api34]]); (2) **`@capawesome-team/capacitor-nfc`** (`Capacitor.Plugins.Nfc`, sponsorware); (3) **Web NFC** (`NDEFReader`) only outside the APK. With no plugin present in the APK the read fails with an explicit "install the NFC plugin and rebuild" message. **Correction (verified §5.5.1b):** the tullave chip is a **Calypso** card, NOT an unreadable encrypted DESFire. Its balance + last 10 movements + 16-digit card number are readable with **plain, unauthenticated ISO-7816 APDUs (no keys)** via `phonegap-nfc` `transceive()`. NFC therefore yields a real `source:"card"` balance and movement history on-device — the earlier "UID only, balance is server-only" claim was wrong.

#### 5.5.1b tullave Calypso NFC protocol (reverse-engineered, validated)
Decoded from the official app **v2.9.6** (`com.nexura.transmilenio`, `MainActivity.ndefReadTag`) and **validated live on-device** (Frida hook on `IsoDep.transceive`, real card). All reads are **unauthenticated** — no DESFire/Calypso session, no keys. Use `IsoDep` (tech `IsoDep`/`NfcA`/`NfcB`), `setTimeout(20000)`, then transceive in order (hex):

```text
1. SELECT AID     00 A4 04 00 07 D4 10 00 00 03 00 01   → FCI 6F31…  (Calypso transit app)
2. GET balance    90 4C 00 00 04                         → respA  (e.g. 0000 98EE 9000)
3. READ BINARY    00 B0 86 00 42                         → respB  (66 B; may be all-zero)
4. SELECT EF 4200 00 A4 00 00 02 42 00                   → respC  (FCI; card # inside)
5. READ RECORD    00 B2 <rec> 24 2E    rec = 0x01..0x0A  → 46-byte movement records
```

Parsing (all multi-byte fields **big-endian**; strip the trailing `9000` SW before indexing):
* **Balance (COP)** = `BE(respA[0:4]) + BE(respA[5:8])`. If `hex(respB[0:4])` starts with `01`, adjust: `balance = reversedA − BE(respB[4:8])` (signed).
* **Card number** (16-digit BCD) = `hex(respC[8:16])`.
* **Movement** (per 46-byte record): `type = rec[0]` (`01`=Viaje en bus, `02`=Recarga, `04`=Cancelación recarga); `saldoFinal = BE(rec[3:6])`; `monto = BE(rec[11:14])`; datetime = `DD/MM/YYYY HH:MM:SS` from `rec[29] rec[28] rec[26]rec[27] rec[30] rec[31] rec[32]` (hex-as-decimal). Records with no valid response end the loop.
* Provenance stays `source:"card"`; the server ledger (`/lectura_tarjeta`, §5.5.1a) remains `source:"server"`. The card read is authoritative for live balance since it is the chip itself.

#### 5.5.2 Caching & Timeouts
* **Caching**:
  * ArcGIS endpoints cached in-memory with 10-minute TTL.
  * **Master catalog (memory-critical)**: `/api/troncal/master-catalog` is served from a **precomputed gzip buffer** built once per catalog version (`getCatalogLightGzip`, `tm_api.ts`) and streamed verbatim (`Content-Encoding: gzip`) — never re-`JSON.stringify`d or re-gzipped per request. The light catalog is NOT retained as a live object; only the ~5 MB buffer + the full catalog stay resident. This removes the transient per-request allocations that OOM-killed the 512 MB host under concurrency (§4.3). ETag `W/"catalog-<loadedAt>"` → `304`; concurrent first-hits share one build; identity fallback for clients that refuse gzip.
  * **Static assets** (`server/src/index.ts`): fingerprinted `/assets/*` served `Cache-Control: public, max-age=31536000, immutable`; `index.html` `no-cache` (so new asset hashes are picked up on deploy); other public files (models, draco, icons) `max-age=86400`.
  * **Service worker** (`client/public/sw.js`, registered in `main.ts`): cache-first for hashed assets + models/draco/fonts, stale-while-revalidate for `/api/troncal/master-catalog`, network-first for the HTML shell. Live `/api/*` is never cached. Versioned cache (`tm-cache-v1`); old versions purged on `activate`.
* **Timeouts**:
  * Catalog API request: 15s.
  * Official live API request (direct): 9s.
  * Colombia relay query: 12s.
  * Public live proxy request: 14s (`LIVE_PROXY_TIMEOUT_MS`), raced across the best `CO_PROXY_RACE_WIDTH` (5) proxies.
  * Public proxy pool readiness wait: 18s; per-proxy verification test: 12s.
  * Relay health checks: 5s.

#### 5.5.3 Port Standardization
* **Server Target**: Port `3002`.
* **Vite Proxy Target**: Proxies `/api` to `http://localhost:3002`.
* **Config Files**: `.env.example` in both client and server directories default to `3002`.
* **Scripts**: `scripts/dev.ps1` runs Vite on default `5173` and API on `3002`.

#### 5.5.4 SEO & Crawler Surface
Canonical public origin: **`https://transmilenio.onrender.com`** (same origin allow-listed in `RELAY_CLIENT_ORIGINS`, §5.2.2).
* **Dedicated folder**: every crawler-facing root file lives in **`seo/`** — `robots.txt`, `sitemap.xml`, and the Google Search Console ownership token `googlebb8cb92194ccf198.html` (Google fetches that exact root path; it must never be renamed or nested). They are **not** client build output, so they are not copied into `client/public`; `server/src/index.ts` mounts the folder with `express.static` (`index:false`, `Cache-Control: public, max-age=3600`) after the `client/dist` mount, which puts them at `/robots.txt`, `/sitemap.xml`, `/googlebb8cb92194ccf198.html` with one source of truth and no build step. Consequence: they are served by the Express server only — `vite dev` (5173) proxies just `/api` and 404s them.
* **Sitemap is a single URL** (`/`). All in-app deep links are **hash** fragments (`#/r/<code>`, `#/plan?…`, §5.6 planner state), and crawlers discard fragments, so no other URL is indexable. Listing invented paths would only produce soft 404s, since the SPA fallback (`app.get('*')`) answers unknown paths with the shell at `200`.
* **Canonical tag**: `client/index.html` carries `<link rel="canonical" href="https://transmilenio.onrender.com/">`, so any shell served for an unknown path consolidates onto `/` instead of being indexed as a duplicate. Same file carries `robots`, Open Graph / Twitter cards, and a `WebApplication` JSON-LD block.
* **`robots.txt` disallows** `/api/` (JSON for the app, and `/api/troncal/master-catalog` is a multi-MB payload — crawling it burns the 512 MB instance, §5.1.3) plus `/models/` and `/draco/` (binary 3D assets, not needed to render the page).
* **Domain change checklist** (`seo/README.md`): sitemap `<loc>`/`<lastmod>`, `robots.txt` `Sitemap:` line, and the `canonical`/`og:url`/`og:image`/JSON-LD `url` in `client/index.html` — then re-verify in Search Console and resubmit the sitemap.

---

### 5.6 Data Models

```typescript
interface MasterCatalog {
  stations: { [stationCode: string]: CatalogStation };
  routes: { [routeCode: string]: CatalogRouteDetail[] };
}

interface CatalogStation {
  id: string;
  codigo: string;
  nombre: string;
  direccion: string;
  coordenada: string;
  sistema?: string;
  tipoServicio?: string;
  wagons: CatalogWagons;
}

interface CatalogRouteDetail {
  id: string;
  codigo: string;
  nombre: string;
  color: string;
  sistema: string;
  tipoServicio: string;
  horarios?: any;
  origin?: string;
  destination?: string;
  stops?: Array<{
    nombre: string;
    codigo: string;
    coordenada: string;
    posicion: number;
    direccion?: string;
  }>;
  trazado?: number[][] | number[][][];
}

interface RouteListItem {
  id: string;
  code: string;
  name: string;
  origin: string;
  destination: string;
  type: "troncal" | "zonal";
  subType?: string;
  source?: "arcgis" | "catalog";
  busType?: string;
  schedule?: string;
  operator?: string;
  length?: number;
  color?: string;
  geometry?: { paths: number[][][] };
  stops?: Array<{
    nombre: string;
    codigo: string;
    coordinate: [number, number];
    direccion?: string;
    kind?: "station" | "stop";
  }>;
  catalogNombre?: string;
  liveNameCandidates?: string[];
}
```

---

### 5.7 Acceptance Criteria

System aligns with spec when:
1. **Catalog Fallback**: Client loads and initiates search from local master catalog.
2. **Interactive Search**: Users search/select routes, showing correct traces, schedules, timelines.
3. **Layer Integration**: Station popups render wagon assignments. Zonal stops map correct routes.
4. **Live Operations**: Live tracking resolves through the cascade (Live Bridge extension → CO relay direct → server `/api/buses` → public CO proxy), showing loading/tracking/empty/error/stale states.
5. **Card Balance**: Lectura de saldo reproduces the observed `/lectura_tarjeta` request, labels server-only data as such, and never presents missing NFC card-memory movements as verified data.
6. **Stability Guidelines**: App loads properly even when live relay or ArcGIS endpoints fail.

---

### 5.8 Official App API Surface (reverse-engineered)

Full backend inventory decoded from the official app **v2.9.6** (`com.nexura.transmilenio`, `Client/APIServiceInterface.java` + the `ApiClient*` Retrofit builders). Six hosts. `loader.php` calls use the `lServicio`/`lTipo`/`lFuncion` query pattern (§5.1.2).

**Host 1 — Catalog** `https://api.buscador-rutas.transmilenio.gov.co/` (no auth; `okhttp` UA; `loader.php?lServicio=Rutas&lTipo=api&lFuncion=<fn>`). We **use**: `searchRutaByTipo` (route search, §5.1.2) + `infoRuta` (route detail). **Unused, worth mining** (exact `lFuncion` values from the app): **`getParaderosList`** (full paraderos list — alt to ArcGIS zonal stops), **`searchRutasByEstacionTroncales`** (`&estacion=` → routes serving a troncal station), plus `getRutasDeUnaEstacionZonal` (`&parada=`), `getZonasOperacionales` (`&tipo_ruta=`), `getPortalesEstacionesAlimentadoras`, `getRutasAlimentadoras` (`&estacion_portal=`), `getEstacionesDeUnTroncal` (`&troncal=`), `searchStations` (`&search=`), `searchRoutesbyStop` (`&parada=`), `searchRoutesbyZoneOperational` (`&tipo_ruta=&zona=`). Plus `twitter/hashtags.php` + `twitter/timeline.php` (service alerts).

**Host 2 — Live/Bodega** `https://tmsa-transmiapp-shvpc.uc.r.appspot.com/` (CO-IP geofenced; headers `Appid: 9a2c3b48f0c24ae9bfba38e94f27c3ea` + `uuid` + `version`). We **use**: `POST /buses` (troncal live), `POST /location/ruta` (zonal live), `POST /lectura_tarjeta` (card ledger), **`POST /paradero/buses`** (`getLlegadas`) → real-time arrivals/ETA at a paradero, now served as `POST /api/arrivals` (§5.5.1). Response (`LlegadasItem[]`) per approaching bus: `ruta_extraida` (código), `color_ruta`, `ruta_sae` (id), `destino_limpio` (destino), `distancia`, **`labeltiempo`** (ETA label), `labelparadero`. **`GET /puntos_recarga`** (recharge POIs, `TuLlave` model) is now served as `GET /api/recarga-points` (§5.5.1). Still **unused**: `GET /puntos_personalizacion`; `POST /getServicios`, `POST /consultar_programacion` (schedules — already covered via `infoRuta`'s `horarios`, §5.1.2). Out of scope: `911denuncias`, `guardar_reporte`.

**Host 3 — Journey Planner (OTP)** `https://planeador.transmilenio.gov.co/otp/routers/default/plan2` — a real **OpenTripPlanner** instance (`origen`, `destino`, `transferencias`, `bannedAgencies`, `date`, `time`, `mode`, `lFuncion=consultarCache`). **Unused, and NOT a replacement candidate** — head-to-head tested against our own router (`services/router.ts`) on real troncal↔zonal trips: (1) **mode filtering is a no-op** — Mixto/Solo-TM/Solo-Zonal (`bannedAgencies=1:3` / `1:1,1:4`) returned byte-identical results in every trial, so the official app's own mode toggle doesn't actually work server-side; (2) **it never routes the troncal trunk or trunk↔trunk connections** (e.g. San Façón→Ricaurte→Paloquemao via the Calle 13/NQS connection) — it fragments cross-corridor trips into zonal micro-hops + long terminal walks instead, exactly where "it doesn't handle the tunnels" symptoms come from; raw trip time is roughly comparable (±1–2 min) but the itinerary shape is worse. Its one real strength — accurate street-level pedestrian legs — is already matched by our own OSRM-backed `/api/walking-route` (§5.5.1, §5.6), so there is nothing left to borrow from OTP. Do not integrate it as a routing source; §6.1's original "should replace or cross-check ours" note was wrong and is superseded by this finding.

**Host 4 — SITP** `http://app.sitp.gov.co/api/` (**HTTP**, Basic auth `transmilenio:rtoi33pqApp` = `Basic dHJhbnNtaWxlbmlvOnJ0b2kzM3BxQXBw`) — `places` geocoding/autocomplete. Unused. (Credential is embedded in the public APK; treat as low-trust, not a secret.)

**Host 5 — Firebase Storage** `https://firebasestorage.googleapis.com/` — `info.json` (app config/help) + static map images. Unused (we have our own assets).

**WebView-only** (not JSON APIs): `app.sitp.gov.co/mapa`, `planner.maasapp.co`, `recargatullave.transmilenio.maasapp.co` (card recharge).

**Shipped from this inventory:** real-time arrivals (`POST /api/arrivals`, §5.5.1), the recharge-point POI layer (`GET /api/recarga-points`, §5.5.1), the **station-demand heat overlay** (`GET /api/station-demand`, §5.5.1 — aggregated from the open Google Cloud Storage bucket `gs://validaciones_tmsa`, folder **Salidas**, per-station weekday entries+exits), and the **TransMiBici bike-parking** POIs (`GET /api/transmibici`, §5.5.1). **Ruled out:** the official OTP journey planner — see Host 3 above; the `consulta_desvios_brt` detour layer (empty/low-value on inspection). **Still open:** station↔route lookups straight from `loader.php` (`getParaderosList`, `searchRutasByEstacionTroncales`) instead of re-deriving from ArcGIS. **Correction:** card balance is no longer server-only — read it offline via NFC (§5.5.1b).

**Provenance / reproducing this inventory:** decoded from the official app's APK via jadx decompile (static: `Client/APIServiceInterface.java` for the endpoint surface, `Activity/MainActivity.java` for the NFC protocol) plus a Frida hook on `IsoDep.transceive()` for live on-device validation of the NFC read. The source APK and capture tooling are kept locally (gitignored, not committed — see `research/README.md`) so future sessions can re-derive or re-verify if the app updates past v2.9.6.

## 6. Future Goals & Rules

### 6.1 Platform Goals & Action Items
* **Discovery Expansion**: ✅ Done — see §5.8 for the full reverse-engineered API surface across all six official-app hosts (catalog, live/Bodega, OTP planner, SITP, Firebase Storage, WebView-only), decoded via APK teardown (`research/README.md`).
* **Provenance Tracking**: Log exact source keys for all coordinate shapes and schedules.
* **Relay Panel**: Add monitoring UI dashboard for Colombia Relay health.
* **Test Suites**:
  * Unit tests: code normalization, coordinate simplification, resolver logic.
  * Integration tests: API contracts.
  * Smoke tests: Playwright-based testing for boot flow and search actions. Shipped so far: `tests/visual.spec.ts` (boot snapshot) and `tests/arcgis-layers.spec.ts` (§4.2 layer substitution + recovery).
* **Journey Planning**: Journey planning (origin/destination route calculation) explicitly within project scope.

### 6.2 Architectural Rules
* **Live Tracking Consolidation**: Live tracking must consolidate to bypass individual relay server infrastructure. **In progress (§5.2.1a):** the Live Bridge extension moves the live request onto the user's Colombian connection, removing the server from the live path when installed; the relay remains only as fallback.
* **Sync Separation**: Route variant diff calculations must not be embedded inside Express sync action.
