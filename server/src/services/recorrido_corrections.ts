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
interface RetiredVariant {
  codigo: string;
  id: string;
  nombre?: string;
  note?: string;
}

function load(): { dropStops: DropStop[]; retiredRoutes: RetiredRoute[]; retiredVariants: RetiredVariant[] } {
  try {
    const file = path.resolve(__dirname, '..', 'data', 'recorrido_corrections.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return {
      dropStops: parsed.dropStops ?? [],
      retiredRoutes: parsed.retiredRoutes ?? [],
      retiredVariants: parsed.retiredVariants ?? [],
    };
  } catch {
    // Missing file = no corrections. The catalog is then exactly what upstream
    // says, which is the honest fallback.
    return { dropStops: [], retiredRoutes: [], retiredVariants: [] };
  }
}

const CORRECTIONS = load();
const key = (codigo: unknown, stop: unknown): string =>
  `${String(codigo ?? '').trim().toUpperCase()}|${String(stop ?? '').trim().toUpperCase()}`;
const DROPPED = new Set(CORRECTIONS.dropStops.map((entry) => key(entry.codigo, entry.stop)));
const RETIRED = new Set(CORRECTIONS.retiredRoutes.map((entry) => String(entry.codigo).trim().toUpperCase()));
const RETIRED_VARIANTS = new Set(CORRECTIONS.retiredVariants.map((entry) => key(entry.codigo, entry.id)));

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
 * Whether this (código, id) names a *variant* the network has replaced.
 *
 * The gap this fills: upstream can re-issue a route under a NEW id while keeping
 * its código — A60's `Calle 76` run became id 5711 `Calle 72` when Calle 76 shut
 * for the Metro works, leaving id 1187 delisted. The rename purge in
 * `mergeCatalogs` is id→código and sees nothing (the código did not change), the
 * variant key is the route's name so the old name is retained as if it were a
 * second service, and `pruneUnservedStationRoutes` reads that retained variant's
 * own recorrido as corroboration — so the closed station keeps its platform tags
 * for the whole retention window. A variant is dropped here only when the file
 * says so, with the evidence recorded beside it (§1 Certainty).
 */
export function isRetiredVariant(codigo: unknown, id: unknown): boolean {
  if (RETIRED_VARIANTS.size === 0) return false;
  const entry = key(codigo, id);
  if (!RETIRED_VARIANTS.has(entry)) return false;
  used.add(`variant|${entry}`);
  return true;
}

/**
 * Names the corrections that did nothing this run.
 *
 * A stop correction that no longer matches means upstream dropped the stop
 * itself; a retirement that never fired means the código is gone from the
 * catalog too. Either way the entry has outlived its cause and should be deleted
 * — which is the whole reason this file is allowed to exist.
 *
 * `healthy` is the same gate `expireUnseenVariants` runs behind: a route
 * retirement fires either from the fetch loop (the código is still listed) or
 * from the expiry pass (it is still in the catalog), so "fired nowhere" only
 * means "gone from both" on a run that plainly saw the whole listing. On a short
 * fetch it means nothing, and naming an entry for deletion there is exactly the
 * absence retention exists to ignore (§5.1.3).
 */
export function reportUnusedCorrections(seenCodigos: Set<string>, healthy = false): string[] {
  const stale: string[] = [];
  for (const entry of CORRECTIONS.dropStops) {
    const id = key(entry.codigo, entry.stop);
    // Only judge a correction whose route was actually fetched this run.
    if (!seenCodigos.has(String(entry.codigo).trim().toUpperCase())) continue;
    if (!used.has(id)) stale.push(`${entry.codigo} no longer lists ${entry.stop}`);
  }
  // Route retirements are re-checked too — the `retired|` bookkeeping was being
  // written and never read, so a código upstream had itself stopped listing kept
  // a hand-filed retirement alive indefinitely, which is the same stale fact the
  // entry was filed to remove.
  if (healthy) {
    for (const entry of CORRECTIONS.retiredRoutes) {
      const id = String(entry.codigo).trim().toUpperCase();
      if (!used.has(`retired|${id}`)) stale.push(`${entry.codigo} is no longer listed upstream`);
    }
  }
  // A variant retirement fires against the *previous* catalog, not against the
  // fetch, so there is no seen-this-run gate to apply: once the ghost it names
  // is out of the catalog the entry has done its work and has nothing left to
  // match. Keeping it would leave a permanent veto on a (código, id) pair
  // upstream is free to re-use.
  for (const entry of CORRECTIONS.retiredVariants) {
    if (!used.has(`variant|${key(entry.codigo, entry.id)}`)) {
      stale.push(`${entry.codigo} #${entry.id} is no longer in the catalog`);
    }
  }
  return stale;
}
