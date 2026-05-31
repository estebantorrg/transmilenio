# TransMilenio Explorer Specification

## 1. Purpose

TransMilenio Explorer exists to become the best web application for exploring
TransMilenio, SITP Zonal, dual, and alimentador service in Bogota.

The product goal is not only to draw routes on a map. The goal is to make the
most reliable public-facing transit intelligence layer possible by combining:

- Official TransMi mobile app route, stop, wagon, schedule, trace, and live bus
  data where available.
- Official TransMilenio ArcGIS FeatureServer geometry and public GIS metadata.
- Local normalization, reconciliation, validation, and provenance tracking so
  the app can explain where each displayed fact came from.

The app should feel fast, polished, mobile-friendly, and trustworthy. Accuracy,
freshness, and data provenance are core product features.

## 2. Product Vision

The target experience is a premium transit explorer for Bogota:

- A user can search any route code, destination, station, stop, trunk corridor,
  or service type and get the right result quickly.
- A selected route shows the official route shape, ordered stops, service type,
  schedule, origin, destination, route color, and live vehicles when available.
- A selected troncal station shows the official wagon/platform route
  assignments, including complex split stations and terminal platform clusters.
- A selected zonal stop shows the official routes serving that stop, with route
  colors and click-through route navigation.
- Live vehicle positions are shown only when fetched through a reliable,
  Colombia-origin path that the backend can diagnose.
- The UI remains useful during partial outages: cached catalog data opens the
  app, ArcGIS layers may degrade, and live tracking reports its own status.
- The app makes data quality visible to developers through health checks,
  audits, stale flags, diagnostics, and reproducible sync commands.

## 3. Current Repository Shape

This repository is a Node.js monorepo with npm workspaces:

- `client/`: Vite, TypeScript, MapLibre GL JS frontend.
- `server/`: Express, TypeScript backend and data sync services.
- `server/src/data/master_catalog.json`: checked-in cached master catalog.
- `scripts/dev.ps1`: starts server and client in development.
- `assets/`: visual assets used by the README.
- `scratch/`: local experiments and investigation scripts.

Root scripts:

```json
{
  "dev": "powershell -ExecutionPolicy Bypass -File ./scripts/dev.ps1",
  "dev:client": "npm --prefix client run dev",
  "dev:server": "npm --prefix server run dev",
  "build": "npm --prefix server run build && npm --prefix client run build",
  "start": "node --max-old-space-size=2048 server/dist/index.js"
}
```

Server scripts:

```json
{
  "dev": "tsx watch src/index.ts",
  "relay:co": "tsx src/colombia_live_relay.ts",
  "build": "tsc && node --input-type=module -e \"import fs from 'fs'; fs.cpSync('src/data', 'dist/data', { recursive: true });\"",
  "start": "node dist/index.js"
}
```

Client scripts:

```json
{
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview"
}
```

## 4. Current Data Inventory

The checked-in master catalog currently contains:

- 7,472 station/stop records.
- 140 troncal station-like app stops using `TM####` codes.
- 7,332 zonal or non-troncal stop records.
- 772 route codes.
- 1,197 route variants.
- 55,299 station/stop-to-route wagon mappings.

Observed route variant families:

- `TransMiZonal | URBANO`: 927 variants.
- `TransMilenio | TRONCAL`: 100 variants.
- `TransMilenio | ALIMENTADOR`: 80 variants.
- `TransMilenio | ALIMENTADOR_V`: 57 variants.
- `TransMilenio | PADRON`: 20 variants.
- `TransMiZonal | COMPLEMENTARIO`: 7 variants.
- `TransMiZonal | ESPECIAL`: 6 variants.

The catalog is the main product dataset. ArcGIS is used to enrich map layers,
station metadata, corridor geometry, and zonal stop metadata.

## 5. Data Source Priority

The app should use this priority order:

1. Official TransMi mobile app API for route lists, route details, stop order,
   wagon assignments, schedules, official route colors, official route traces,
   and live tracking.
2. Official TransMilenio ArcGIS FeatureServer for GIS layers, station points,
   zonal stop points, corridor geometry, route traces when app traces are
   missing, and public station metadata.
3. Local reconciliation logic for route variants, station splits, route colors,
   code normalization, and fallback matching.
4. Local cached catalog as the offline/stale fallback.

The app should avoid inventing transit facts. If a fact is inferred, merged, or
fallback-derived, the code should retain enough provenance to debug it.

## 6. TransMi Mobile App API

### 6.1 Catalog Host

The current catalog client calls:

```text
https://api.buscador-rutas.transmilenio.gov.co/loader.php
```

Implemented in:

```text
server/src/services/tm_api.ts
```

### 6.2 Required Headers

The catalog fetcher sends mobile-app-like headers:

```text
Accept-Encoding: gzip
Connection: Keep-Alive
Host: api.buscador-rutas.transmilenio.gov.co
User-Agent: okhttp/4.12.0
uuid: fd1be953-d85e-4c63-8c23-234f143f445d
version: 2.9.5
```

These headers are part of the current compatibility contract. If the upstream
mobile app changes its version, UUID behavior, or required headers, the fetcher
must be revalidated.

### 6.3 Route Search

Route discovery uses:

```text
lServicio=Rutas
lTipo=api
lFuncion=searchRutaByTipo
tipo_ruta=TIPORUTA
search=<seed>
```

The current seed set is:

```text
["", "A".."Z", "0".."9"]
```

Each response is expected to include:

```text
lista_rutas[]
```

Each route item can include:

- `id`
- `codigo`
- `nombre`
- `color`
- `sistema`
- `tipoServicio`

The sync deduplicates routes by `id`.

### 6.4 Route Detail

Route details use:

```text
lServicio=Rutas
lTipo=api
lFuncion=infoRuta
idRuta=<route id>
nombre=<route name>
codigo=<route code>
```

The current code extracts:

- `recorrido.data[]`: ordered route stops.
- `0.color`: official color.
- `0.horarios`: schedule payload.
- `0.sistema`: service system.
- `0.tipoServicio`: service type.
- `0.trazado`: GeoJSON string containing `LineString` or `MultiLineString`.

Each `recorrido.data[]` stop can include:

- `id`
- `codigo`
- `nombre`
- `direccion`
- `coordenada` as `"lat,lng"`
- `sistema`
- `tipoServicio`
- `vagon`
- `parada`
- `posicion`

### 6.5 Catalog Sync Flow

The current sync is `syncMasterCatalog()`:

1. Search all routes using the route search seed set.
2. Filter to app-supported service families:
   - `TransMilenio`
   - `TransMiZonal`
   - `TRONCAL`
   - `PADRON`
3. Fetch `infoRuta` for every selected route.
4. Build `stations` keyed by stop/station code.
5. Group route assignments under `station.wagons[wagonLabel]`.
6. Build `routes` keyed by route code, preserving route variants.
7. Store ordered stops and parsed `trazado` geometry per route variant.
8. Write the catalog atomically to `server/src/data/master_catalog.json`.
9. Replace the in-memory catalog only after the file write completes.
10. Invalidate the lightweight catalog cache.

Current sync safeguards:

- Random delay between route detail calls: 800 to 1,500 ms.
- Retry count: 3.
- Retry base delay: 3,000 ms.
- Catalog stale threshold: 7 days.
- Atomic write through a process/timestamp temp file plus rename.

### 6.6 Lightweight Catalog

`getCatalogLight()` creates a smaller response for the browser:

- Keeps full route detail for troncal station records.
- Compresses zonal stop wagon routes to code and color only.
- Simplifies route trace geometry to at most 160 points per route or split
  across paths.
- Exposes `stations` and `routes`.

This is necessary because the full catalog is large and expensive to ship.

## 7. Live Tracking

### 7.1 Official Live Host

Live tracking currently targets:

```text
https://tmsa-transmiapp-shvpc.uc.r.appspot.com
```

Implemented in:

```text
server/src/services/tm_api.ts
server/src/colombia_live_relay.ts
client/src/layers/buses.ts
```

### 7.2 Colombia-Origin Requirement

Live bus tracking is treated as Colombia-origin only. The main server should not
pretend to be in Colombia using `X-Forwarded-For` headers. It should route live
requests through a small relay running on a Colombian network.

Required main-server environment:

```text
TRANSMILENIO_COLOMBIA_RELAY_URL=https://your-relay.example.com
TRANSMILENIO_COLOMBIA_RELAY_SECRET=change-me
```

Relay command:

```text
npm --prefix server run relay:co
```

Suggested relay exposure:

```text
cloudflared tunnel --url http://localhost:8787
```

### 7.3 Relay Health Check

The relay checks its egress country through:

```text
https://www.cloudflare.com/cdn-cgi/trace
```

It caches the egress result for 30 seconds.

`GET /health` returns:

- `200` when `egress.country === "CO"`.
- `451` when the relay is reachable but not exiting from Colombia.
- `503` when the egress check fails.

### 7.4 Relay Auth

If `TRANSMILENIO_COLOMBIA_RELAY_SECRET` is set, relay requests must include one
of:

```text
Authorization: Bearer <secret>
x-relay-secret: <secret>
```

### 7.5 Troncal Live Request

For troncal routes, the relay calls:

```text
POST /buses
```

Body:

```json
{
  "ruta": "B75",
  "Nombre": "Portal Norte - Unicervantes"
}
```

Headers:

```text
Accept-Encoding: identity
Appid: 9a2c3b48f0c24ae9bfba38e94f27c3ea
Connection: Keep-Alive
Host: tmsa-transmiapp-shvpc.uc.r.appspot.com
User-Agent: okhttp/4.12.0
uuid: fd1be953-d85e-4c63-8c23-234f143f445d
version: 2.9.5
Content-Type: application/json; charset=UTF-8
Content-Length: <body length>
```

### 7.6 Zonal Live Request

For zonal routes, the relay calls:

```text
POST /location/ruta?ruta=<route code>
```

The request body is empty. `Content-Length` is `0`.

### 7.7 Live Payload Normalization

The backend and frontend both normalize several possible response shapes:

- Raw array.
- `data`.
- `buses`.
- `result`.
- `results`.
- `vehiculos`.
- `vehicles`.
- Object values that look like live bus records.

A live bus-like object must include finite latitude and longitude values through
one of:

- `latitude` / `longitude`
- `lat` / `lng`
- `lat` / `lon`

The frontend normalizes each bus to:

- `id`
- `label`
- `latitude`
- `longitude`
- `route_id`
- `lasttime`
- `ruta_extraida`
- `destino_limpio`
- `posicion`
- `angulo`
- `nombre_sistema`

### 7.8 Live Polling

When a user selects a route:

1. The previous live tracking session stops.
2. The route detail panel enters `loading`.
3. The client requests `/api/buses`.
4. Markers are rendered as MapLibre HTML markers.
5. The request repeats every 15 seconds.
6. A session id prevents stale responses from updating the wrong selected route.
7. A `fetchInFlight` flag prevents overlapping live polls.

Status values shown to the user:

- `loading`: connecting.
- `success`: tracking N buses.
- `empty`: no active buses.
- `error`: live tracking failed.

### 7.9 Live Name Candidate Strategy

Troncal live requests may be sensitive to the destination name. The frontend
builds candidate names from:

- Route destination.
- Catalog route name.
- Display route name.
- Route origin.
- First stop name.
- Last stop name.

The backend tries each candidate against the Colombia relay before failing.

## 8. ArcGIS FeatureServer Integration

### 8.1 Base URL

ArcGIS queries use:

```text
https://gis.transmilenio.gov.co/arcgis/rest/services
```

Implemented in:

```text
server/src/services/arcgis.ts
```

### 8.2 Query Behavior

`queryFeatureLayer()` builds a FeatureServer query with:

- `where`: default `1=1`.
- `outFields`: default `*`.
- `outSR`: default `4326`.
- `f`: `json`.
- `resultRecordCount`: default `2000`.
- `resultOffset`: increments until pagination is complete.
- `returnGeometry`: default `true`.

The function keeps fetching while:

```text
exceededTransferLimit === true && features.length > 0
```

### 8.3 Current ArcGIS Queries

Troncal:

- `Troncal/consulta_rutas_troncales`
- `Troncal/consulta_estaciones_troncales`
- `Troncal/consulta_esquemas_estaciones`
- `Troncal/consulta_trazados_troncales`

Zonal:

- `Zonal/consulta_rutas_zonales`
- `Zonal/consulta_paraderos_zonales`
- `Zonal/consulta_paraderos_rutas`

Known additional troncal services observed in repository data:

- `Troncal/consulta_conexiones_troncales`
- `Troncal/consulta_patios_troncales`
- `Troncal/consulta_trazados_troncales_estaciones`
- `Troncal/consultaEquivalenciaEstaciones`

These should be evaluated for future data enrichment.

## 9. Backend API Contract

The Express server mounts all API routes at:

```text
/api
```

Current endpoints:

- `GET /api`
- `GET /api/health`
- `GET /api/debug-buses`
- `GET /api/troncal/routes`
- `GET /api/troncal/stations`
- `GET /api/troncal/corridors`
- `GET /api/troncal/master-catalog`
- `GET /api/troncal/route/:code`
- `GET /api/troncal/station/:code`
- `POST /api/troncal/sync`
- `GET /api/zonal/routes`
- `GET /api/zonal/stops`
- `GET /api/zonal/stop-routes`
- `POST /api/buses`

### 9.1 API Cache

ArcGIS-backed route/station endpoints use an in-memory TTL cache:

```text
TTL: 10 minutes
```

The master catalog uses the local JSON file and in-memory cache from
`tm_api.ts`.

### 9.2 Health Response

`GET /api/health` returns:

- `status`
- `cacheEntries`
- `catalogStations`
- `catalogStale`
- `liveTrackingVersion`
- `syncInProgress`
- `uptime`

This endpoint is also used by the frontend as a wake-up ping before heavy data
loads.

### 9.3 Debug Buses Response

`GET /api/debug-buses` exposes relevant live tracking environment settings and
attempts a test request for route `1` / `Universidades`.

The endpoint should remain safe for public environments. It should not leak
secrets.

## 10. Frontend Architecture

### 10.1 Main Boot Flow

Implemented in:

```text
client/src/main.ts
```

Current startup:

1. Wake the backend with `/health`.
2. Initialize MapLibre.
3. Load custom marker images.
4. Fetch required and optional data.
5. Require the master catalog.
6. Allow ArcGIS layers to degrade if unavailable.
7. Build the unified route list.
8. Add corridor, route, station, zonal route, and stop layers.
9. Initialize sidebar interactions.
10. Hide the loading overlay.
11. Load zonal stops and stop-route mappings in the background.
12. Enrich the map after background zonal data arrives.

### 10.2 Client API Wrapper

Implemented in:

```text
client/src/services/api.ts
```

Default timeout:

```text
60 seconds
```

Master catalog timeout:

```text
300 seconds
```

Retry behavior:

- Default maximum retries: 4.
- Initial delay: 2 seconds.
- Exponential delays: 2, 4, 8, 16 seconds.
- Retries apply to network errors and `502`, `503`, `504`.
- Live bus requests use 0 retries to avoid stale vehicle data.

### 10.3 Route List Construction

The route list is catalog-first. The app:

1. Builds route list items from `catalog.routes`.
2. Classifies each variant as `troncal`, `zonal`, `dual`, or `alimentador`.
3. Parses ordered stops from `coordenada`.
4. Deduplicates stops by code and coordinate.
5. Converts app `trazado` into MapLibre `paths`.
6. Deduplicates route variants by base code, type, normalized origin, and
   normalized destination.
7. Enriches matching troncal items with ArcGIS route geometry and length.
8. Enriches zonal routes with ArcGIS stop-route mappings when catalog stops are
   incomplete.

Route traces should come from official app `trazado` where available. ArcGIS
route geometry is a fallback or enrichment source, not the only source of truth.

### 10.4 Route Selection

When selecting a route:

1. Stop live tracking for the prior route.
2. If the route is missing geometry or stops, fetch `/troncal/route/:code`.
3. Match the returned variant by generated catalog id.
4. Update route geometry and stops.
5. Refresh the route detail panel.
6. Highlight the route.
7. Show selected-route stops.
8. Build live name candidates.
9. Start live tracking.
10. Fit the map to the selected route bounds.

### 10.5 Map Layers

Map initialization:

- Style: Carto dark matter GL style.
- Center: `[-74.1071, 4.6486]`.
- Initial zoom: `12`.
- Min zoom: `9`.
- Max zoom: `18`.

Layer modules:

- `client/src/layers/routes.ts`
- `client/src/layers/stations.ts`
- `client/src/layers/stops.ts`
- `client/src/layers/buses.ts`
- `client/src/layers/popup.ts`

Current layers:

- Troncal corridor casing.
- Troncal corridor line.
- Troncal corridor labels.
- Zonal route casing.
- Zonal route glow.
- Zonal route line.
- Highlight route casing.
- Highlight route glow.
- Highlight route line.
- Station markers.
- Station hitboxes.
- Station labels.
- Zonal stop markers.
- Zonal stop hitboxes.
- Zonal stop labels.
- Selected route stop markers.
- Live bus markers.

The layer order intentionally keeps troncal corridors and selected/highlight
layers readable above zonal route lines.

### 10.6 Station Intelligence

Implemented in:

```text
client/src/layers/stationCatalogResolver.ts
client/src/layers/stations.ts
```

The station resolver reconciles ArcGIS station points with TransMi app catalog
stops.

Resolution order:

1. Terminal platform cluster special handling.
2. Verified split station mappings.
3. Exact app stop id.
4. Name and distance.
5. Unmatched fallback.

Verified splits:

- Avenida Jimenez Caracas maps to app stop `TM0013` wagons `A`, `B`, `C`.
- Avenida Jimenez Calle 13 maps to app stop `TM0013` wagons `D`, `E`.
- Ricaurte NQS maps to app stop `TM0069` wagons `A`, `B`, `C`.
- Ricaurte Calle 13 maps to app stop `TM0069` wagons `D`, `E`, `F`.

Terminal handling:

- Merges the core terminal app stop and nearby terminal platform fragments
  within 180 meters.

Audit output:

- `window.__tmStationAudit`
- Console summary of matched, verified split, platform cluster, and unmatched
  stations.

The resolver is critical because wagon assignments are only trustworthy when
the station point and app stop are correctly matched.

### 10.7 Zonal Stop Intelligence

Implemented in:

```text
client/src/layers/stops.ts
```

Zonal stop route tags are built from:

1. ArcGIS `consulta_paraderos_rutas` mappings.
2. Catalog stop-route assignments from `master_catalog.json`.
3. Catalog route colors where available.
4. Local color fallback by route code.

The app deduplicates route tags by normalized route code.

### 10.8 Route Colors

Implemented in:

```text
client/src/utils/routeColors.ts
```

The app uses trunk-letter colors for troncal services:

- `A`: `#0C3A95`
- `B`: `#75C347`
- `C`: `#FFB741`
- `D`: `#6867B4`
- `E`: `#B76416`
- `F`: `#FB2C17`
- `G`: `#00B0E8`
- `H`: `#FF8525`
- `J`: `#E49DAA`
- `K`: `#D3AA78`
- `L`: `#00B0A9`
- `M`: `#852D89`
- `P`: `#25206F`
- `T`: `#808000`
- `RF`: `#000000`
- `Z`: `#EAB308`

Special cases:

- Alimentador: `#009944`.
- Ruta Facil codes 1 through 8: `#000000`.
- Zonal default: `#00608B`.
- Troncal default: `#FB2C17`.

Catalog colors are accepted only when they are valid non-white hex colors.

## 11. UI Requirements

### 11.1 Current UI

The current UI is a full-screen map with a fixed sidebar.

Existing controls:

- Search input.
- Layer toggles.
- Route list.
- Route detail panel.
- Collapsible sidebar.
- Map navigation controls.
- Scale control.
- Station popups.
- Zonal stop popups.
- Live bus popups.

### 11.2 Target UI Quality

The application should feel like an operational transit tool, not a marketing
page. It should optimize for:

- Fast scanning.
- Precise route search.
- Dense but legible information.
- Smooth map interaction.
- Stable layout on mobile and desktop.
- Clear loading, empty, stale, partial, and error states.
- Accessible controls and keyboard navigation.
- Reliable text escaping for every external data field.

### 11.3 Route Detail Requirements

A selected route should show:

- Route code.
- Route type.
- Origin.
- Destination.
- Official route name.
- Ordered stop timeline.
- Schedule.
- Service system.
- Vehicle/service class.
- Route length when reliable.
- Live tracking status.
- Live vehicle markers when available.
- Source/freshness indicators in future iterations.

### 11.4 Station Detail Requirements

A station popup should show:

- Station name.
- Corridor/trunk.
- Location/address.
- Wagon/platform groupings.
- Route tags per wagon.
- Bike parking and Wi-Fi metadata where available.
- Clickable route tags.
- Source match method in developer diagnostics.

### 11.5 Stop Detail Requirements

A zonal stop popup should show:

- Stop name.
- Cenefa/stop code.
- Address.
- Locality/zone where available.
- Route tags.
- Clickable route tags.

## 12. Reliability Requirements

### 12.1 Catalog Reliability

The app must be able to open from cached catalog data even if live upstream APIs
are unavailable.

Required behavior:

- Load catalog from disk at server startup.
- Mark catalog stale after 7 days.
- Allow background sync when stale or missing.
- Keep serving the previous catalog during sync.
- Publish the new catalog only after atomic write succeeds.
- Expose `syncInProgress` and `catalogStale` through `/health`.

### 12.2 Partial Outage Behavior

The frontend should consider the master catalog required. ArcGIS layers are
optional enrichment:

- If catalog fails, show a blocking load error.
- If ArcGIS troncal routes fail, still open using catalog route geometry.
- If ArcGIS corridors fail, still open without corridor background lines.
- If ArcGIS stations fail, route search can still work from catalog.
- If ArcGIS zonal stops fail, route selection should still use catalog stops.
- If live tracking fails, route detail should remain useful.

### 12.3 Request Timeouts

Current server timeouts:

- Catalog API request: 15 seconds.
- Official live API request: 9 seconds.
- Colombia relay request from main server: 12 seconds.
- Public Colombian proxy readiness wait: 18 seconds.
- Relay egress check: 5 seconds.

Current frontend timeouts:

- Normal API request: 60 seconds.
- Master catalog request: 300 seconds.

These values should be revisited after production telemetry is available.

### 12.4 Public Proxy Fallback

The app contains an optional public Colombian proxy fallback gated by:

```text
TRANSMILENIO_ALLOW_PUBLIC_CO_PROXY=1
```

This should remain off by default because public proxies are unreliable,
opaque, and may fail suddenly. The Colombia relay is the preferred production
path.

## 13. Performance Requirements

### 13.1 Backend Performance

- Gzip compression is required because the catalog response is large.
- ArcGIS endpoint responses are cached in memory for 10 minutes.
- Master catalog light response should stay meaningfully smaller than the full
  catalog.
- Catalog sync should be backgrounded and never block existing reads.

### 13.2 Frontend Performance

- Initial render should prioritize catalog, corridors, station points, and route
  list construction.
- Zonal stop details load in the background after initial render.
- Route list rendering is capped at 200 visible results.
- Route search narrows the list instead of rendering thousands of items.
- Map layers should use GeoJSON sources and native line/symbol layers where
  possible.
- Live bus markers should update existing marker positions instead of replacing
  all markers every poll.

### 13.3 Future Performance Targets

Target metrics:

- Time to first usable map on warm backend: under 5 seconds.
- Time to first route search results after catalog load: under 100 ms.
- Route selection visual response: under 250 ms when geometry is already loaded.
- Live polling should never overlap requests for the same selected route.
- Catalog payload should be compressed and eventually chunked or indexed if it
  prevents fast mobile startup.

## 14. Security and Safety Requirements

- Never expose relay secrets in client code or diagnostic responses.
- Treat all upstream text as untrusted and escape it before injecting HTML.
- Keep CORS restricted to configured client origins in production.
- Avoid pretending to be Colombia through forged forwarding headers.
- Avoid storing personal user data.
- Keep the project disclaimer clear: this is independent and unofficial.
- Use source-specific rate limits and retry backoff to avoid hammering upstream
  services.

## 15. Current Configuration Notes

### 15.1 Ports

Current server default in code:

```text
PORT=3002
```

Current `server/.env.example`:

```text
PORT=3001
```

Current Vite proxy target:

```text
http://localhost:3002
```

Current `client/.env.example`:

```text
VITE_API_BASE_URL=http://localhost:3001/api
```

Current `scripts/dev.ps1` prints:

```text
API: http://localhost:3001
Client: http://localhost:5173
```

This mismatch should be resolved. The recommended target is to standardize
local development on one API port and make the Vite proxy, `.env.example`, and
script output match.

### 15.2 CORS

The server accepts:

- `CLIENT_ORIGINS` from environment, comma-separated.
- Default local origins matching `localhost` and `127.0.0.1`.

Production deployments should explicitly set `CLIENT_ORIGINS`.

### 15.3 Static Serving

The server serves:

```text
server/dist/index.js
client/dist
```

Build copies `server/src/data` to `server/dist/data`, which is required because
the server loads `master_catalog.json` relative to the compiled server code.

## 16. Data Model

### 16.1 MasterCatalog

```ts
interface MasterCatalog {
  stations: { [stationCode: string]: CatalogStation };
  routes: { [routeCode: string]: CatalogRouteDetail[] };
}
```

### 16.2 CatalogStation

```ts
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
```

### 16.3 CatalogRouteDetail

```ts
interface CatalogRouteDetail {
  id: string;
  codigo: string;
  nombre: string;
  color: string;
  sistema: string;
  tipoServicio: string;
  horarios?: CatalogRoute["horarios"];
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
```

### 16.4 RouteListItem

```ts
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

## 17. Roadmap to "Absolute Best" App

### 17.1 Data Completeness

Priority work:

- Expand TransMi mobile app endpoint discovery beyond `Rutas`.
- Catalog all available app functions, required parameters, response shapes, and
  auth/header requirements.
- Add source provenance to every route, stop, schedule, geometry, and live value.
- Preserve both full and light catalog variants.
- Add catalog version metadata: generatedAt, source app version, route count,
  station count, error count, and sync duration.
- Store per-route sync failures and expose them in diagnostics.
- Add a diff report between old and new catalogs before publishing.
- Track removed routes and stops to avoid accidental silent deletion.

### 17.2 Better Fetch Architecture

Recommended backend improvements:

- Move TransMi app endpoint definitions into a typed source adapter layer.
- Separate catalog sync, live tracking, ArcGIS, and normalization modules.
- Add structured logs with route code, source, duration, status, retry count, and
  error class.
- Add a `GET /api/sources` or `GET /api/diagnostics` endpoint for source health.
- Add sync lock metadata so operators know when a sync started and why.
- Add a manual sync dry-run mode.
- Add a safe admin/auth layer before exposing sync in production.
- Add persistent cache metadata instead of relying only on file mtime.

### 17.3 Better Route Matching

Recommended matching improvements:

- Preserve route variant ids all the way through the UI.
- Prefer exact app route ids over code-only matching.
- Keep normalized route code as a derived field, not the primary identity.
- Store route direction explicitly.
- Store origin/destination confidence.
- Add tests for duplicated codes, ciclovia suffixes, dual service, alimentador
  variants, and same-code opposite directions.

### 17.4 Better Station Matching

Recommended station improvements:

- Turn station audit into a visible developer diagnostics screen.
- Persist verified split mappings as data, not hardcoded constants.
- Add a review file for manually verified complex stations.
- Add tests for Terminal, Avenida Jimenez, Ricaurte, and any future split
  stations.
- Compare app stop coordinates against ArcGIS station points and alert on large
  drift.
- Incorporate `consultaEquivalenciaEstaciones` if it provides official
  crosswalk data.

### 17.5 Better Live Tracking

Recommended live improvements:

- Add a relay status panel in `/api/debug-buses`.
- Track last successful live request per route.
- Cache only very short-lived live responses, if needed, to smooth transient
  failures.
- Add route-specific live endpoint fixtures.
- Detect and report "no active buses" separately from "upstream failed".
- Record which live name candidate succeeded for each route.
- Add circuit breaker behavior when relay is unavailable.
- Add deployment instructions for keeping the Colombia relay awake.

### 17.6 Better UX

Recommended product improvements:

- Route search across code, destination, origin, station name, stop code, and
  locality.
- Station search and stop search as first-class entities.
- A route compare mode for variants with the same code.
- Source/freshness chips in route and station detail panels.
- Offline/stale banner when serving old catalog data.
- Shareable URLs for selected route/station/stop.
- Mobile bottom-sheet route detail with stable map padding.
- Keyboard navigation for search results.
- Accessibility labels for toggles, buttons, route tags, and popups.

### 17.7 Testing

Recommended test coverage:

- Unit tests for route code normalization and colors.
- Unit tests for trace parsing and simplification.
- Unit tests for station catalog resolver.
- Unit tests for catalog sync transformation using fixtures.
- Unit tests for live payload normalization.
- Integration tests for backend API response shapes.
- Playwright smoke test for map startup, route search, route selection, station
  popup, stop popup, and live status fallback.
- Golden catalog stats check to detect unexpected large data loss.

## 18. Acceptance Criteria

The current app should be considered aligned with this spec when:

- The app starts from a cached master catalog.
- Users can search and select troncal and zonal routes.
- Route details show ordered stops and schedules where present in app data.
- Troncal route highlights use official app traces or reliable ArcGIS fallback.
- Zonal route lines use official app traces where present.
- Station popups show wagon route assignments from the TransMi app catalog.
- Zonal stop popups show route tags from ArcGIS mappings plus catalog fallback.
- Live bus tracking uses a Colombia relay and reports loading, success, empty,
  and error states.
- `/api/health` exposes catalog freshness and live tracking version.
- Catalog sync writes atomically and does not break serving the old catalog.
- The UI remains usable when ArcGIS or live tracking is temporarily unavailable.

The next milestone should be considered complete when:

- Port configuration is consistent across server, Vite proxy, env examples, and
  dev script output.
- Catalog metadata includes generated time, source app version, counts, errors,
  and sync duration.
- Data provenance is available for route geometry, stops, schedules, station
  wagon assignments, and live tracking.
- Tests cover the normalization and resolver logic that protects data accuracy.

## 19. Open Questions

- Which additional TransMi mobile app services beyond `Rutas` are available and
  stable enough to rely on?
- Does the app expose official service alerts, closures, detours, station access
  status, fares, card recharge locations, or news endpoints?
- Can live tracking be made reliable enough for production without a personal
  Colombia relay?
- Should the app eventually include journey planning, or stay focused on route,
  station, stop, and live vehicle exploration?
- Should the full catalog remain checked into Git, or move to generated release
  artifacts once sync automation is stable?
- Should sync be scheduled externally in production, or controlled by the API
  server itself?

## 20. Guiding Principle

The best TransMilenio web app is not the one with the flashiest map. It is the
one that makes official transit data legible, fast, fresh, and honest about its
sources. Every future feature should make the system more useful, more reliable,
or easier to verify.
