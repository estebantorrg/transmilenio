/**
 * Upstream recorrido facts this project overrides (`data/recorrido_corrections.json`).
 *
 * The operator's data lags its own network. When A61 was extended down the Av.
 * Ciudad de Cali corridor its old cabecera was left on the recorrido — Portal
 * Américas filed at `posicion` 0, the same chainage as the new head at Tibanica,
 * while every other stop increases from Tibanica. Two stops at the same metre is
 * not a sequence, and the service does not call there; published as-is it puts a
 * parada on the route page that no bus stops at, and hands the planner a 4 km
 * leg measured as zero.
 *
 * Corrections are **data with evidence**, not code: each entry records what the
 * operator's own numbers say, and each is re-checked on every sync so it can be
 * deleted the moment upstream fixes itself (`reportUnusedCorrections`). A
 * correction that quietly outlives its cause is the same kind of stale fact it
 * was filed to remove.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface DropStop {
  codigo: string;
  stop: string;
  nombre?: string;
  note?: string;
}
interface RetiredRoute {
  codigo: string;
  note?: string;
}

function load(): { dropStops: DropStop[]; retiredRoutes: RetiredRoute[] } {
  try {
    const file = path.resolve(__dirname, '..', 'data', 'recorrido_corrections.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return { dropStops: parsed.dropStops ?? [], retiredRoutes: parsed.retiredRoutes ?? [] };
  } catch {
    // Missing file = no corrections. The catalog is then exactly what upstream
    // says, which is the honest fallback.
    return { dropStops: [], retiredRoutes: [] };
  }
}

const CORRECTIONS = load();
const key = (codigo: unknown, stop: unknown): string =>
  `${String(codigo ?? '').trim().toUpperCase()}|${String(stop ?? '').trim().toUpperCase()}`;
const DROPPED = new Set(CORRECTIONS.dropStops.map((entry) => key(entry.codigo, entry.stop)));
const RETIRED = new Set(CORRECTIONS.retiredRoutes.map((entry) => String(entry.codigo).trim().toUpperCase()));

/** Corrections that fired at least once this run — the rest are candidates for deletion. */
const used = new Set<string>();

/** The recorrido without the stops this route does not actually make. */
export function correctRecorrido<T extends { codigo?: string }>(codigo: string, stops: T[]): T[] {
  if (DROPPED.size === 0) return stops;
  return stops.filter((stop) => {
    const id = key(codigo, stop?.codigo);
    if (!DROPPED.has(id)) return true;
    used.add(id);
    return false;
  });
}

/** Whether this código names a route the network has retired (answered, not inferred). */
export function isRetiredRoute(codigo: unknown): boolean {
  const id = String(codigo ?? '').trim().toUpperCase();
  if (!RETIRED.has(id)) return false;
  used.add(`retired|${id}`);
  return true;
}

export function retiredRouteCodes(): string[] {
  return Array.from(RETIRED);
}

/**
 * Names the corrections that did nothing this run.
 *
 * A stop correction that no longer matches means upstream dropped the stop
 * itself; a retirement that never fired means the código is gone from the
 * catalog too. Either way the entry has outlived its cause and should be deleted
 * — which is the whole reason this file is allowed to exist.
 */
export function reportUnusedCorrections(seenCodigos: Set<string>): string[] {
  const stale: string[] = [];
  for (const entry of CORRECTIONS.dropStops) {
    const id = key(entry.codigo, entry.stop);
    // Only judge a correction whose route was actually fetched this run.
    if (!seenCodigos.has(String(entry.codigo).trim().toUpperCase())) continue;
    if (!used.has(id)) stale.push(`${entry.codigo} no longer lists ${entry.stop}`);
  }
  return stale;
}
