# Third-party notices

The project's own source code is MIT-licensed ([`LICENSE.md`](LICENSE.md)).
**Nothing listed here is covered by that license.** Each item belongs to its
owner and is used under the terms given, or, where no terms are known, as
stated. npm dependencies carry their own licenses in their packages and are not
repeated here.

## Data

| What | Owner | Where it is used | Terms |
|---|---|---|---|
| Route and stop catalog, live bus positions, arrivals, card balances | TRANSMILENIO S.A. | `server/src/data/master_catalog.json`, live features | Published by TRANSMILENIO S.A. through its public systems and applications. Shown for information; no ownership claimed. |
| Stations, TransMiBici, recharge and personalisation points, map layers | TRANSMILENIO S.A. (`gis.transmilenio.gov.co`) | `server/src/data/*.json`, map layers | Public GIS services of TRANSMILENIO S.A. |
| Station ridership (validaciones) | TRANSMILENIO S.A. | `server/src/data/station_demand.json` | Published open data. |
| Station plans (planos de ubicación) | TRANSMILENIO S.A. | `server/src/data/plano_*.json` (facts read from the sheets) | Facts extracted; the sheets themselves are not redistributed. |
| Printed ruteros of the zonal routes | TRANSMILENIO S.A. | `server/src/data/ruteros_tradicionales.json` | Facts read from the final artwork TRANSMILENIO S.A. delivered for radicado 2026-ER-47262. The artwork is not redistributed; TRANSMILENIO S.A. stated its delivery is not an authorisation of use. |
| Map data | © OpenStreetMap contributors | Basemap, address search, walking routes | [Open Database License (ODbL)](https://www.openstreetmap.org/copyright) |

## Maps and online services

| What | Owner | Terms |
|---|---|---|
| Basemap style and tiles (`dark-matter`) | © CARTO | [CARTO attribution and basemap terms](https://carto.com/attributions) |
| Address search (Photon) | Komoot GmbH, on OpenStreetMap data | Service terms of photon.komoot.io |
| Address search (Nominatim) | OpenStreetMap Foundation | [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) |
| Address search (ArcGIS geocoder) | Esri | Esri service terms |
| Walking routes | FOSSGIS e.V. (`routing.openstreetmap.de`) | FOSSGIS service terms |

## Shipped assets

| File(s) | What | Author / owner | License |
|---|---|---|---|
| `client/public/models/bus.glb`, `client/public/models/bus_lod.glb` | 3D bus model, re-pivoted for the map | **Satyr** — "Busscar - Urbanuss Pluss S5 (Padrão Colômbia)", a *Cities: Skylines* asset published on the Steam Workshop (item 2012382772, 2 March 2020; [author's profile](https://steamcommunity.com/id/Satyr7)) | **None stated.** The Workshop page gives no license or reuse permission, and the item has since been taken down. Credited here; used without an explicit license. |
| `client/public/fonts/inter-latin-var.woff2` | Inter typeface (latin subset) | The Inter Project Authors (Rasmus Andersson) | [SIL Open Font License 1.1](https://openfontlicense.org) |
| `client/public/fonts/sora-latin-var.woff2` | Sora typeface (latin subset) | The Sora Project Authors | [SIL Open Font License 1.1](https://openfontlicense.org) |
| `client/public/draco/*` | Draco mesh decoder | Google LLC | [Apache License 2.0](https://github.com/google/draco/blob/main/LICENSE) |

## Referenced, not shipped

| What | Author | License | Use |
|---|---|---|---|
| "2019 Bogotá – Estación Parque Tercer Milenio – Buses de Transmilenio en la avenida Caracas" | Felipe Restrepo Acosta, Wikimedia Commons | CC BY-SA 4.0 | LED dot pitch and glyph shapes measured from it (`shared/rutero.js`); the photo is not in the repository. |
| "Bog - Bus TransMileni dando la curva Avenida 30" | Wikimedia Commons | CC BY-SA 3.0 | Sign casing and layout observed (`shared/rutero.js`); not in the repository. |

## Trademarks

TransMilenio, SITP, tu llave, Busscar, Urbanuss and Cities: Skylines are
trademarks of their respective owners. They are mentioned only to identify what
the project describes or uses.
