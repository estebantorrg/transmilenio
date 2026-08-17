/**
 * Is this catalog node an estación, or a street paradero?
 *
 * Answered from the official register (`data/troncal_stations.json`, refreshed
 * by `npm run sync:stations`), not from the shape of the code. `/^TM\d+$/` was
 * the test in nine places, and it is a proxy: TransMi opens stations before it
 * assigns them a TM code, so Tibanica - Primavera, Los Laureles and Islandia
 * (catalog codes 90009/90010/90011) arrived as real estaciones that every
 * surface drew as zonal paraderos — no estación page, no station popup, no
 * vagón plan, a cyan pin on the map and a second pin from the ArcGIS layer
 * beside it.
 *
 * The code shape stays as a fallback rather than a rule: it is right for the
 * 140 stations that have one, and it keeps the answer sane if the registry file
 * is ever missing. The answer travels to both clients on the light catalog
 * (`estacion: true`, §5.1.4) so the browser, the app and the prerenderer read
 * one answer instead of deriving three (§1.1 R2).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** A catalog code of this shape is an estación whatever the registry says. */
const TM_CODE = /^TM\d+$/i;

export interface RegistryEntry {
  numero: string;
  nodo: string;
  nombre: string;
  troncal: string;
  vagones: number | null;
  lat: number;
  lon: number;
  match: string;
  distanceM: number | null;
}

function loadRegistry(): Record<string, RegistryEntry> {
  try {
    const file = path.resolve(__dirname, '..', 'data', 'troncal_stations.json');
    return JSON.parse(readFileSync(file, 'utf-8')).stations ?? {};
  } catch {
    // Missing file → the TM-code fallback below still answers for every station
    // that has a code, which is how this behaved before the registry existed.
    console.warn('[stations] troncal_stations.json unreadable — falling back to TM-coded stations only.');
    return {};
  }
}

const REGISTRY: Record<string, RegistryEntry> = loadRegistry();
const REGISTERED = new Set(Object.keys(REGISTRY).map((code) => code.trim().toUpperCase()));

/** True when this catalog stop code is a TransMilenio estación. */
export function isTroncalStationCode(code: string | null | undefined): boolean {
  const key = String(code ?? '').trim();
  if (!key) return false;
  return TM_CODE.test(key) || REGISTERED.has(key.toUpperCase());
}

/** The register's own row for a station, when it has one. */
export function troncalStationEntry(code: string | null | undefined): RegistryEntry | undefined {
  return REGISTRY[String(code ?? '').trim()] ?? REGISTRY[String(code ?? '').trim().toUpperCase()];
}

/** How many stations the registry pairs with a catalog stop — for logging. */
export function registeredStationCount(): number {
  return REGISTERED.size;
}
