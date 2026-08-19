/**
 * Builds the troncal station registry (`data/troncal_stations.json`).
 *
 * Source: ArcGIS `Troncal/consulta_estaciones_troncales` — the official register
 * of TransMilenio estaciones (name, corridor, vagón count, position) — joined to
 * the catalog stop code that actually carries each station's routes.
 *
 * Why this file exists: "is this node an estación or a street paradero?" used to
 * be answered by the shape of the catalog code (`/^TM\d+$/`) in nine separate
 * places. That test is a proxy, not the fact, and it fails the moment TransMi
 * opens a station before assigning it a TM code — which is exactly what happened
 * with Tibanica - Primavera / Los Laureles / Islandia (catalog codes 90009,
 * 90010, 90011): three real estaciones that every surface rendered as zonal
 * paraderos, with no estación page, no vagón plan and no station popup. The
 * registry answers it from the register instead, so a station opening is picked
 * up by re-running this script plus a catalog sync — no code change (spec
 * §5.1.3, §5.5.6).
 *
 * The join is recorded per station (`match`, `distanceM`) so a wrong pairing is
 * visible in the file rather than silently shipped.
 *
 * Run from anywhere: `npm run sync:stations`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LAYER_URL =
  'https://gis.transmilenio.gov.co/arcgis/rest/services/Troncal/consulta_estaciones_troncales/FeatureServer/0/query' +
  '?where=1=1&outFields=numero_estacion,nombre_estacion,troncal_estacion,numero_vagones_estacion,' +
  'codigo_nodo_estacion,latitud_estacion,longitud_estacion,tipo_estacion,id_trazado_troncal' +
  '&returnGeometry=false&f=json&resultRecordCount=2000';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const OUT = join(DATA_DIR, 'troncal_stations.json');
const CATALOG = join(DATA_DIR, 'master_catalog.json');

/** Same shape test the registry falls back to — a catalog code that is already a station. */
const TM_CODE = /^TM\d+$/i;

/** Beyond this a name match is a coincidence, not the same station. */
const NAME_MATCH_RADIUS_M = 450;
/** Without a name match, only near-touching points may pair ("Los Laureles" vs "Laureles"). */
const PROXIMITY_RADIUS_M = 200;
/**
 * A candidate the catalog does NOT already code as a station must be much
 * closer than one it does. Zonal paraderos are named after the station they
 * stand at ("SENA - NQS", 342 m from the SENA platform), so the loose radius
 * that safely re-finds a renamed TM stop would hand a street stop the estación.
 */
const UNCODED_STATION_RADIUS_M = 150;

export interface RegistryStation {
  /** `numero_estacion` — the register's own id, zero-padded. */
  numero: string;
  /** `codigo_nodo_estacion`, normalized. Empty when the register has none. */
  nodo: string;
  nombre: string;
  /** Corridor label as filed. New corridors arrive as a bare `TZnnn` code. */
  troncal: string;
  vagones: number | null;
  lat: number;
  lon: number;
  /** How the catalog code was resolved, and how far apart the two points sit. */
  match: 'node-id' | 'name-and-distance' | 'proximity';
  distanceM: number | null;
}

interface CatalogStation {
  id?: string;
  codigo?: string;
  nombre?: string;
  direccion?: string;
  coordenada?: string;
  wagons?: Record<string, Array<{ sistema?: string }>>;
}

function normalizeId(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? text.replace(/^0+/, '') || '0' : text.toUpperCase();
}

function normalizeName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** "Los Laureles" and "Laureles" are the same station; so are "Estación X" and "X". */
function nameVariants(value: unknown): string[] {
  const full = normalizeName(value);
  const base = normalizeName(String(value ?? '').split('-')[0].replace(/^ESTACI[OÓ]N\s+/i, ''));
  const stripped = full.replace(/^(LOS|LAS|EL|LA)/, '');
  return Array.from(new Set([full, base, stripped].filter(Boolean)));
}

function point(coordenada: unknown): { lat: number; lon: number } | null {
  const [latText, lonText] = String(coordenada ?? '').split(',');
  const lat = Number(latText);
  const lon = Number(lonText);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

export async function syncTroncalStations(): Promise<{ matched: number; unmatched: string[] }> {
  const res = await fetch(LAYER_URL);
  if (!res.ok) throw new Error(`estaciones troncales HTTP ${res.status}`);
  const json = (await res.json()) as { features?: Array<{ attributes: any }> };
  const features = json.features || [];
  if (features.length === 0) throw new Error('estaciones troncales returned no features');

  const catalog = JSON.parse(await readFile(CATALOG, 'utf8')) as {
    stations?: Record<string, CatalogStation>;
  };
  const stations = Object.entries(catalog.stations || {}).map(([key, station]) => ({
    key,
    codigo: String(station.codigo || key).trim(),
    id: normalizeId(station.id),
    names: [...nameVariants(station.nombre), ...nameVariants(station.direccion)],
    point: point(station.coordenada),
    // Does any TransMilenio service actually call here? This is what separates a
    // station the catalog codes zonally from the SITP paradero standing outside
    // it — and those paraderos are named after the station ("Estación Calle 63",
    // "Br. San Bernardo" beside Tercer Milenio), so name and distance alone
    // promote a street stop to an estación. Thirteen register stations have no
    // catalog counterpart at all; leaving them unmatched is the honest answer.
    // Specifically a TRONCAL service, not any TransMilenio one. Padrón routes
    // call at ordinary paraderos between stations (K86 files 78 of them), so
    // "some TransMilenio route stops here" is true of half the street and it
    // paired the register's closed Calle 63 and Calle 45 with the paraderos
    // 130 m away — putting a pin, and K86, back on stations shut for the Metro
    // works. A troncal bus cannot call anywhere but an estación, which is the
    // property this gate is actually looking for.
    troncalServed: Object.values(station.wagons || {}).some((routes) =>
      (routes as Array<{ sistema?: string; tipoServicio?: string }>).some(
        (route) => route?.sistema === 'TransMilenio' && route?.tipoServicio === 'TRONCAL'
      )
    ),
  }));
  const byId = new Map<string, typeof stations>();
  for (const station of stations) {
    if (!station.id) continue;
    const bucket = byId.get(station.id) ?? [];
    bucket.push(station);
    byId.set(station.id, bucket);
  }

  // catalogCode → registry entry, keeping the closest claim when two stations
  // reach for the same stop (Av. Jiménez and Ricaurte each file two platforms
  // against one merged catalog stop — the split is the client's business, and
  // this file must not hand the same code to both).
  const claimed = new Map<string, RegistryStation>();
  const unmatched: string[] = [];

  for (const feature of features) {
    const a = feature.attributes;
    const nombre = String(a.nombre_estacion ?? '').trim();
    const lat = Number(a.latitud_estacion);
    const lon = Number(a.longitud_estacion);
    if (!nombre || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const origin = { lat, lon };
    const nodo = normalizeId(a.codigo_nodo_estacion);
    const numero = String(a.numero_estacion ?? '').trim();

    const scored = stations
      .map((station) => ({
        station,
        distance: station.point ? distanceMeters(origin, station.point) : null,
      }))
      .filter((entry) => entry.distance !== null) as Array<{
      station: (typeof stations)[number];
      distance: number;
    }>;

    const ids = Array.from(new Set([nodo, normalizeId(numero)].filter(Boolean)));
    let chosen: { station: (typeof stations)[number]; distance: number | null; match: RegistryStation['match'] } | null =
      null;

    for (const id of ids) {
      const candidates = (byId.get(id) || []).filter((station) => TM_CODE.test(station.codigo));
      if (candidates.length === 0) continue;
      const best = scored
        .filter((entry) => candidates.includes(entry.station))
        .sort((a2, b2) => a2.distance - b2.distance)[0];
      chosen = { station: best?.station ?? candidates[0], distance: best?.distance ?? null, match: 'node-id' };
      break;
    }

    // A TM-coded stop always outranks a zonal-coded one at the same station: it
    // is already known to be an estación, while a zonal-style code 60 m away is
    // just as likely to be the street paradero outside it. Only where the
    // catalog files an estación under a zonal-style code — which it does for
    // thirteen of them, and for every station opened before its TM code was
    // assigned — does the non-TM candidate win, and then only by being the only
    // one that matched.
    const preferTmCoded = (
      entries: Array<{ station: (typeof stations)[number]; distance: number }>
    ): { station: (typeof stations)[number]; distance: number } | undefined => {
      const sorted = [...entries].sort((a2, b2) => a2.distance - b2.distance);
      return (
        sorted.find((entry) => TM_CODE.test(entry.station.codigo)) ??
        sorted.find((entry) => entry.station.troncalServed && entry.distance <= UNCODED_STATION_RADIUS_M)
      );
    };

    if (!chosen) {
      const wanted = new Set(nameVariants(nombre));
      const byName = preferTmCoded(
        scored.filter(
          (entry) =>
            entry.distance <= NAME_MATCH_RADIUS_M && entry.station.names.some((name) => wanted.has(name))
        )
      );
      if (byName) chosen = { station: byName.station, distance: byName.distance, match: 'name-and-distance' };
    }

    if (!chosen) {
      const near = preferTmCoded(scored.filter((entry) => entry.distance <= PROXIMITY_RADIUS_M));
      if (near) chosen = { station: near.station, distance: near.distance, match: 'proximity' };
    }

    if (!chosen) {
      unmatched.push(`${numero} ${nombre}`);
      continue;
    }

    const entry: RegistryStation = {
      numero,
      nodo,
      nombre,
      troncal: String(a.troncal_estacion ?? '').trim(),
      vagones: Number.isFinite(Number(a.numero_vagones_estacion)) ? Number(a.numero_vagones_estacion) : null,
      lat,
      lon,
      match: chosen.match,
      distanceM: chosen.distance === null ? null : Math.round(chosen.distance),
    };

    const code = chosen.station.codigo;
    const previous = claimed.get(code);
    if (previous && (previous.distanceM ?? Infinity) <= (entry.distanceM ?? Infinity)) {
      unmatched.push(`${numero} ${nombre} (catalog stop ${code} already claimed by ${previous.numero})`);
      continue;
    }
    if (previous) unmatched.push(`${previous.numero} ${previous.nombre} (catalog stop ${code} taken by ${numero})`);
    claimed.set(code, entry);
  }

  const sorted = Object.fromEntries(
    Array.from(claimed.entries()).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  );

  const payload = {
    _meta: {
      what: 'Official troncal estaciones, joined to the catalog stop code that carries their routes.',
      source: 'ArcGIS Troncal/consulta_estaciones_troncales, joined to server/src/data/master_catalog.json.',
      why:
        'A station is an estación because the register says so, not because its catalog code starts with TM — ' +
        'stations open before they are assigned one (Tibanica - Primavera, Los Laureles, Islandia). See spec 5.5.6.',
      generated: new Date().toISOString().slice(0, 10),
      registryStations: features.length,
      matched: claimed.size,
      unmatched,
      match_what:
        'node-id = the register node equals the catalog stop id; name-and-distance = same name within 450 m; ' +
        'proximity = no name match, nearest catalog stop within 200 m. distanceM is register point to catalog point.',
    },
    stations: sorted,
  };

  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  return { matched: claimed.size, unmatched };
}

// Run directly (not when imported). Sets `exitCode` rather than exiting hard,
// for the same reason as `sync_transmibici.ts`: a hard exit races libuv handle
// teardown on Windows while the undici pool is still closing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncTroncalStations()
    .then(({ matched, unmatched }) => {
      console.log(`[sync:stations] ${matched} registry stations joined to catalog stops → ${OUT}`);
      if (unmatched.length > 0) {
        console.log(`[sync:stations] unmatched (${unmatched.length}): ${unmatched.join(' | ')}`);
      }
    })
    .catch((err) => {
      console.error('[sync:stations] Failed:', err?.message || err);
      process.exitCode = 1;
    });
}
