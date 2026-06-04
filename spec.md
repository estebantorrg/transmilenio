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
| **R3 — Conventional Commits mandate** | All codebase changes committed and pushed using Conventional Commits. Titles follow `type(scope): subject` (≤72 chars) with valid types (feat, fix, docs, style, refactor, perf, test, chore). |

---

## 2. Technology Stack & Architecture

### 2.1 Stack Definition

| Layer | Technology |
|---|---|
| **Frontend Client** | Vite 5 + TypeScript + MapLibre GL JS |
| **Backend API** | Node.js + Express + TypeScript (compiled to ESModule) |
| **Data Sync / Exec** | tsx (TypeScript Execute) + PowerShell scripts |
| **Data / Cache** | Local JSON (`master_catalog.json`) + In-memory TTL caches |

### 2.2 System Flow

```
Browser (MapLibre GL JS) → Express API (Node.js) → Master Catalog (Local JSON)
                                ↓             ↓
                          ArcGIS Server   Colombia Live Relay
```

### 2.3 Architecture Rules

* **Client Isolation**: Vite client is presentation layer only. Manages MapLibre layers, search states, timeline renderings. Requests `/api/*` from backend, never calls external transit APIs directly. **Exception — live tracking (§5.2):** when the Live Bridge extension is present, the client routes live-bus requests through it so they originate from the *user's* Colombian connection; the page itself still never `fetch`es the live API (browser CORS forbids it), and absent the extension it falls back to `/api/buses`.
* **Express Engine**: Backend Express API is data aggregator and query cache. Sole component reading master catalog JSON or calling external ArcGIS/TransMi endpoints.
* **Relay Separation**: Live vehicle positions routed through separate Colombia-based relay for geographic API constraints. Main Express backend communicates with relay using authorization secret.

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
* Network retries rate-limited via exponential backoff (2s, 4s, 8s, 16s) up to 4 retries for standard endpoints, 0 retries for live bus requests.

---

## 4. Error Handling & Resilience

### 4.1 Express API
* **No Silent Failures**: Unhandled exceptions caught and logged. Errors written to `error.log`.
* **Structured Responses**: Error endpoints return `{ status: "error", message: string }`.
* **Resilient Upstream Handling**: If ArcGIS/TransMi APIs timeout or error, API returns structured HTTP fallback status — no crashes, no leaked stack traces.

### 4.2 Vite Client (Graceful Degradation)
* **Outage Fallback**: Master catalog is critical. If loading fails, blocking UI overlay shown.
* **ArcGIS Failure**: If ArcGIS troncal routes/corridors fail, map still renders routes using coordinates from catalog traces.
* **Live Outage**: If live tracking fails, route detail panel continues displaying static timeline stops.

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
* **Fallback chain** (`client/src/services/api.ts` → `getLiveBuses`): Live Bridge → `/api/buses` (Colombia relay / direct, §5.2.2). Absent the extension the app degrades gracefully (spec §4.2) with no behavior change.

#### 5.2.2 Relay Setup (server fallback)
* Live tracking requires Colombia egress IP.
* Environment: `TRANSMILENIO_COLOMBIA_RELAY_URL` and `TRANSMILENIO_COLOMBIA_RELAY_SECRET`.
* Relay checks egress country using `https://www.cloudflare.com/cdn-cgi/trace` (cached 30s).
* Egress `/health` responses: `200` (Colombia), `451` (outside CO), `503` (check error).

#### 5.2.3 Endpoint Requests
* **Troncal**: `POST /buses` with body `{"ruta": "<code-e.g.-B75>", "Nombre": "<name>"}`.
  * Headers: `Appid: 9a2c3b48f0c24ae9bfba38e94f27c3ea`, `User-Agent: okhttp/4.12.0`, `version: 2.9.5`.
* **Zonal**: `POST /location/ruta?ruta=<route_code>` with empty body.

#### 5.2.4 Normalization & Polling
* Normalizes response keys (`data`, `buses`, `vehiculos`, `lat`/`lng`) into unified model.
* Polling triggered in 15s intervals. Overlapping requests avoided via `fetchInFlight` locks.
* **Name Candidates**: Backend tries multiple destination/origin candidate strings sequentially to hit troncal APIs.

---

### 5.3 ArcGIS FeatureServer Integration

#### 5.3.1 ArcGIS Query Specifications
* **Base URL**: `https://gis.transmilenio.gov.co/arcgis/rest/services`
* **Query Params**: `where=1=1`, `outFields=*`, `outSR=4326`, `f=json`, `returnGeometry=true`.
* Uses cursor pagination based on `exceededTransferLimit === true`.

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
  2. Verified split mappings:
     * Avenida Jimenez Caracas → stop `TM0013` wagons `A`, `B`, `C`.
     * Avenida Jimenez Calle 13 → stop `TM0013` wagons `D`, `E`.
     * Ricaurte NQS → stop `TM0069` wagons `A`, `B`, `C`.
     * Ricaurte Calle 13 → stop `TM0069` wagons `D`, `E`, `F`.
  3. Exact ID match.
  4. Name and distance proximity.
* **Audit**: Diagnostic output exposed via `window.__tmStationAudit`.

#### 5.4.2 Zonal Stop Resolver
Aggregates route tags from ArcGIS `consulta_paraderos_rutas` and catalog fallbacks. Deduplicates by normalized route code.

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
All mounted on `/api`:
* `GET /api/health`: Exposes catalog status (`stale`, `syncInProgress`), cache entry counts, system uptime.
* `GET /api/debug-buses`: Test payload endpoint (tests route `1` / `Universidades`).
* `/api/troncal/routes`, `/api/troncal/stations`, `/api/troncal/route/:code`, `/api/troncal/station/:code`, `/api/zonal/routes`, `/api/zonal/stops`, `/api/zonal/stop-routes`, `POST /api/buses`.

#### 5.5.2 Caching & Timeouts
* **Caching**: ArcGIS endpoints cached in-memory with 10-minute TTL.
* **Timeouts**:
  * Catalog API request: 15s.
  * Official live API request: 9s.
  * Colombia relay query: 12s.
  * Public proxy fallback validation: 18s.
  * Relay health checks: 5s.

#### 5.5.3 Port Standardization
* **Server Target**: Port `3002`.
* **Vite Proxy Target**: Proxies `/api` to `http://localhost:3002`.
* **Config Files**: `.env.example` in both client and server directories default to `3002`.
* **Scripts**: `scripts/dev.ps1` runs Vite on default `5173` and API on `3002`.

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
4. **Relay Operations**: Live tracking routes queries to Colombia relay, showing loading/tracking/empty/error states.
5. **Stability Guidelines**: App loads properly even when live relay or ArcGIS endpoints fail.

## 6. Future Goals & Rules

### 6.1 Platform Goals & Action Items
* **Discovery Expansion**: Identify additional app endpoints beyond `Rutas`.
* **Provenance Tracking**: Log exact source keys for all coordinate shapes and schedules.
* **Relay Panel**: Add monitoring UI dashboard for Colombia Relay health.
* **Test Suites**:
  * Unit tests: code normalization, coordinate simplification, resolver logic.
  * Integration tests: API contracts.
  * Smoke tests: Playwright-based testing for boot flow and search actions.
* **Journey Planning**: Journey planning (origin/destination route calculation) explicitly within project scope.

### 6.2 Architectural Rules
* **Live Tracking Consolidation**: Live tracking must consolidate to bypass individual relay server infrastructure. **In progress (§5.2.1a):** the Live Bridge extension moves the live request onto the user's Colombian connection, removing the server from the live path when installed; the relay remains only as fallback.
* **Sync Separation**: Route variant diff calculations must not be embedded inside Express sync action.
