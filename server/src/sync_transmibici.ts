/**
 * Builds the TransMiBici bike-parking catalog (`data/transmibici.json`).
 *
 * Source: ArcGIS `Consulta_Planificacion_SITP` layer 12 ("Transmibici", spec
 * §5.3) — secure bike-parking (cicloparqueadero) facilities at portals/stations,
 * with capacity (`cupos`) and average occupancy (`ocu_prom`). The layer stores a
 * monthly snapshot per station, so we keep only the latest row per station.
 *
 * Committed static like the recharge points (`sync_recarga.ts`): a small POI set
 * that changes rarely, served read-only with no runtime ArcGIS dependency.
 *
 * Run from anywhere: `npm run sync:transmibici`.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LAYER_URL =
  'https://gis.transmilenio.gov.co/arcgis/rest/services/ConsultaSubgerenciaPlanificacionSITP/Consulta_Planificacion_SITP/FeatureServer/12/query' +
  '?where=1=1&outFields=nombre_est,cod_nodo_t,cupos,ocu_prom,fecha,latitud,longitud&returnGeometry=false&f=json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data', 'transmibici.json');

export interface BikeParking {
  nombre: string;
  nodo: number | null;
  cupos: number | null; // capacity (bike slots)
  ocupacion: number | null; // latest average occupancy
  lat: number;
  lon: number;
}

export async function syncTransmibici(): Promise<number> {
  const res = await fetch(LAYER_URL);
  if (!res.ok) throw new Error(`transmibici HTTP ${res.status}`);
  const json = await res.json() as { features?: Array<{ attributes: any }> };
  const features = json.features || [];

  // Keep only the most recent snapshot per station (max `fecha`).
  const latest = new Map<string, { a: any; fecha: number }>();
  for (const feat of features) {
    const a = feat.attributes;
    const nombre = String(a.nombre_est ?? '').trim();
    if (!nombre) continue;
    const fecha = Number(a.fecha) || 0;
    const prev = latest.get(nombre);
    if (!prev || fecha >= prev.fecha) latest.set(nombre, { a, fecha });
  }

  const points: BikeParking[] = [];
  for (const { a } of latest.values()) {
    const lat = Number(a.latitud);
    const lon = Number(a.longitud);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) continue;
    points.push({
      nombre: String(a.nombre_est).trim(),
      nodo: Number.isFinite(Number(a.cod_nodo_t)) ? Number(a.cod_nodo_t) : null,
      cupos: Number.isFinite(Number(a.cupos)) ? Number(a.cupos) : null,
      ocupacion: Number.isFinite(Number(a.ocu_prom)) ? Number(a.ocu_prom) : null,
      lat,
      lon,
    });
  }
  points.sort((x, y) => x.nombre.localeCompare(y.nombre));

  await writeFile(OUT, JSON.stringify(points), 'utf8');
  return points.length;
}

// Run directly (not when imported). Sets `exitCode` instead of calling
// `process.exit()` — a hard exit races libuv handle teardown on Windows
// (assertion in async.c) while the undici pool is still closing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncTransmibici()
    .then((n) => {
      console.log(`[sync:transmibici] Wrote ${n} bike-parking points to ${OUT}`);
    })
    .catch((err) => {
      console.error('[sync:transmibici] Failed:', err?.message || err);
      process.exitCode = 1;
    });
}
