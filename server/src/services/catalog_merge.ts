/**
 * What survives a catalog sync (spec §5.1.3).
 *
 * The upstream listing is a snapshot that drifts from run to run, so a sync
 * merges into the previous catalog instead of replacing it — and everything
 * that decides which routes, variants and platform tags are kept, expired or
 * dropped lives here. It is the one place where a wrong answer silently deletes
 * a real service or keeps a retired one, which is why it is its own module:
 * pure functions over a catalog object, with none of `tm_api.ts`’s HTTP, disk
 * or live-tracking state, and a spec that can load it
 * (`tests/catalog-merge.spec.mts`).
 */

import { plateWagon } from './plano_vagones.js';
import { isRetiredRoute, isRetiredVariant } from './recorrido_corrections.js';

export type RouteTrace = number[][] | number[][][];

export interface CatalogRoute {
  id?: string;
  codigo: string;
  nombre: string;
  color: string;
  sistema?: string;
  tipoServicio?: string;
  horarios?: { data?: Array<{ convencion: string; hora_inicio: string; hora_fin: string }> };
}

export interface CatalogWagons {
  [wagonLabel: string]: CatalogRoute[];
}

export interface CatalogStation {
  id: string;
  codigo: string;
  nombre: string;
  direccion: string;
  coordenada: string;
  sistema?: string;
  tipoServicio?: string;
  wagons: CatalogWagons;
}

export interface CatalogRouteDetail {
  id: string;
  codigo: string;
  nombre: string;
  color: string;
  sistema: string;
  tipoServicio: string;
  horarios?: CatalogRoute['horarios'];
  origin?: string;
  destination?: string;
  stops?: Array<{
    nombre: string;
    codigo: string;
    coordenada: string;
    posicion: number;
    direccion?: string;
  }>;
  trazado?: RouteTrace;
  /**
   * Epoch ms of the last sync that saw this variant in the upstream listing.
   *
   * Retention keeps everything a fetch missed (§5.1.3), which is right for a
   * listing that drifts and wrong forever after: a route TransMi actually
   * retires has no way out of the catalog, and the id-keyed rename purge only
   * catches the case where the same id comes back under a new código. This is
   * the clock that lets a genuinely delisted route expire. Absent on entries
   * that predate it — those are stamped on the next sync and get the full
   * window from there, so nothing is dropped for having no stamp.
   */
  seenAt?: number;
}

export interface MasterCatalog {
  stations: { [stationCode: string]: CatalogStation };
  routes: { [routeCode: string]: CatalogRouteDetail[] };
  /** Epoch ms of the last successful sync. Drives content-based staleness so
   *  the catalog keeps refreshing in production, where each deploy is a fresh
   *  checkout and the file mtime would otherwise always look "new". */
  syncedAt?: number;
}

/**
 * How long a route may go unlisted before the catalog lets it go.
 *
 * Long enough that day-dependent services survive: Ciclovía routes are listed
 * on Sundays and festivos, so three weeks covers three of each plus a missed
 * sync. Short enough that a retired route does not outlive the network by a
 * season.
 */
export const ROUTE_RETENTION_DAYS = Number(process.env.TM_ROUTE_RETENTION_DAYS || 21);

export function cleanRouteName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\bCICLOVIA\b/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

export function isDuplicateRoute(a: { codigo: string; nombre: string }, b: { codigo: string; nombre: string }): boolean {
  if (a.codigo.toUpperCase().trim() !== b.codigo.toUpperCase().trim()) return false;
  return cleanRouteName(a.nombre) === cleanRouteName(b.nombre);
}

function hasTrace(trace: RouteTrace | undefined): trace is RouteTrace {
  return Array.isArray(trace) && trace.length > 0;
}

/**
 * Non-destructively merges a freshly fetched catalog over the previous one.
 *
 * The TransMi API is a live snapshot: the listing drifts between runs and a
 * partial fetch can miss routes, so a blind full replace would delete real
 * services. `fresh` is authoritative for everything it returns (updates win by
 * id), and anything present only in `previous` — routes, variants,
 * station-wagon mappings — is retained. The single field-level exception is
 * `trazado`, which falls back to the previous trace when fresh has none.
 */
export function mergeCatalogs(previous: MasterCatalog, fresh: MasterCatalog): MasterCatalog {
  // Merge `previous` INTO `fresh` in place and return `fresh`. The caller passes
  // a disposable fresh catalog, so mutating it avoids allocating a third full
  // ~220 MB structure during sync — cutting the peak that OOM-kills a small host
  // (spec §1.1 R2). Only entries the fresh sync missed are grafted on; fresh
  // always wins on conflict, so the published data is identical to before.

  // Upstream route id → the código(s) fresh files it under. A route that is
  // *renamed* — A61/F61 becoming A61/Z61 — keeps its id and changes código, so
  // without this the old código is retained forever by the rule below and the
  // catalog grows a ghost service running the retired code. Retention exists for
  // a listing that drifts (a route missing from one run is not a route that
  // ended); an id answering to a different código now is positive evidence that
  // this entry is the *same* route under its old name, which is the one case
  // where absence means gone (§5.1.3).
  const freshCodesById = new Map<string, Set<string>>();
  for (const [code, variants] of Object.entries(fresh.routes || {})) {
    for (const variant of variants) {
      const id = String(variant?.id ?? '').trim();
      if (!id) continue;
      const codes = freshCodesById.get(id) ?? new Set<string>();
      codes.add(code.toUpperCase().trim());
      freshCodesById.set(id, codes);
    }
  }
  const isRenamedAway = (variant: { id?: string }, code: string): boolean => {
    const codes = freshCodesById.get(String(variant?.id ?? '').trim());
    return Boolean(codes && !codes.has(code.toUpperCase().trim()));
  };
  let renamedAway = 0;

  // The purge above reads id → código, so it is blind to the mirror case:
  // upstream re-issuing a route under a NEW id while keeping the código. Nothing
  // in the fresh listing then mentions the old id at all, absence is all there
  // is, and absence is exactly what retention refuses to act on. That variant is
  // therefore retired by hand, with its evidence, in
  // `recorrido_corrections.json` (`retiredVariants`).
  const isRetiredTwin = (variant: { id?: string }, code: string): boolean =>
    isRetiredVariant(code, variant?.id);
  let retiredTwins = 0;

  // Routes: union by code; within a code, union variants by normalized name (fresh wins).
  let tracesCarried = 0;
  for (const [code, oldVariants] of Object.entries(previous.routes || {})) {
    const freshVariants = fresh.routes[code];
    if (!freshVariants) {
      const alive = oldVariants.filter((v) => !isRetiredTwin(v, code));
      retiredTwins += oldVariants.length - alive.length;
      const survivors = alive.filter((v) => !isRenamedAway(v, code));
      renamedAway += alive.length - survivors.length;
      if (survivors.length > 0) fresh.routes[code] = survivors;
      continue;
    }

    // `trazado` is the one field where fresh does NOT win on absence. Upstream
    // `infoRuta` intermittently answers with no trazado at all for a route it
    // previously traced (66 variants lost a good trace that way on 2026-08-17,
    // verified against the live endpoint), and a variant-level overwrite takes
    // the trace down with it. A missing trace is never evidence a route has no
    // geometry (spec §1 Certainty), and the planner charges ride distance along
    // it (§5.1.4, §5.6.3), so it falls back to the previous trace instead.
    const oldByName = new Map(oldVariants.map((v) => [cleanRouteName(v.nombre), v]));
    for (const variant of freshVariants) {
      if (hasTrace(variant.trazado)) continue;
      const previousTrace = oldByName.get(cleanRouteName(variant.nombre))?.trazado;
      if (!hasTrace(previousTrace)) continue;
      variant.trazado = previousTrace;
      tracesCarried++;
    }

    // An id the fresh listing carries under THIS código has been re-listed, so
    // whatever name it used to have is superseded. Variants are keyed by name,
    // so without this a rename in place leaves the old name behind as a second
    // service that never existed: M86 #1185 was re-listed as `KR 7 - CLL 107A`
    // and its former `KR 7 - CLL 116` went on printing a phantom chip at 44
    // stations, 19-9 #2253 at 28 more. The id-keyed purge above cannot see it
    // because the código did not change.
    const freshIds = new Set(freshVariants.map((v) => String(v.id ?? '').trim()).filter(Boolean));
    const renamedInPlace = oldVariants.filter((v) => freshIds.has(String(v.id ?? '').trim()));

    const freshKeys = new Set(freshVariants.map((v) => cleanRouteName(v.nombre)));
    const retained = oldVariants.filter(
      (v) => !freshKeys.has(cleanRouteName(v.nombre)) && !renamedInPlace.includes(v)
    );
    renamedAway += renamedInPlace.length;
    const alive = retained.filter((v) => !isRetiredTwin(v, code));
    retiredTwins += retained.length - alive.length;
    const survivors = alive.filter((v) => !isRenamedAway(v, code));
    renamedAway += alive.length - survivors.length;
    if (survivors.length > 0) freshVariants.push(...survivors);
  }

  // Never re-attach a mapping for a route that has been renamed away or whose
  // variant is an answered twin: its recorrido now rides under the new código or
  // the new id, so keeping the old one tags the platform with a service that no
  // longer exists. Applied on every path a previous mapping can travel back in
  // by — including the two wholesale copies below, which is precisely where a
  // *closed* station's tags live: nothing fresh calls there, so fresh has no
  // station and no wagon to merge into.
  const keepMapping = (r: CatalogRoute): boolean =>
    !isRenamedAway(r, r.codigo || '') && !isRetiredTwin(r, r.codigo || '');
  const keptWagons = (wagons: CatalogWagons): CatalogWagons => {
    const out: CatalogWagons = {};
    for (const [wagon, routes] of Object.entries(wagons || {})) {
      const kept = routes.filter(keepMapping);
      if (kept.length > 0) out[wagon] = kept;
    }
    return out;
  };

  // Stations: union by code; union wagons; within a wagon, union route refs by normalized code+name.
  for (const [stationCode, oldStation] of Object.entries(previous.stations || {})) {
    const freshStation = fresh.stations[stationCode];
    if (!freshStation) {
      oldStation.wagons = keptWagons(oldStation.wagons || {});
      fresh.stations[stationCode] = oldStation;
      continue;
    }
    const freshWagons = freshStation.wagons || (freshStation.wagons = {});
    for (const [wagon, oldRoutes] of Object.entries(oldStation.wagons || {})) {
      const freshRoutes = freshWagons[wagon];
      if (!freshRoutes) {
        const kept = oldRoutes.filter(keepMapping);
        if (kept.length > 0) freshWagons[wagon] = kept;
        continue;
      }
      const freshKeys = new Set(freshRoutes.map((r) => `${r.codigo.toUpperCase().trim()}|${cleanRouteName(r.nombre)}`));
      const retained = oldRoutes
        .filter((r) => !freshKeys.has(`${r.codigo.toUpperCase().trim()}|${cleanRouteName(r.nombre)}`))
        .filter(keepMapping);
      if (retained.length > 0) freshRoutes.push(...retained);
    }
  }

  if (tracesCarried > 0) {
    console.log(`[TM API] Kept ${tracesCarried} previous trazado(s) upstream returned no geometry for.`);
  }
  if (renamedAway > 0) {
    console.log(`[TM API] Dropped ${renamedAway} previous entr(ies) whose route id now answers to a different código.`);
  }
  if (retiredTwins > 0) {
    console.log(
      `[TM API] Dropped ${retiredTwins} previous entr(ies) filed as replaced in recorrido_corrections.json.`
    );
  }

  return fresh;
}

/**
 * Drops station→wagon route mappings that no route's authoritative recorrido
 * corroborates.
 *
 * `mergeCatalogs` retains a previous catalog's station-wagon mappings so
 * services the upstream listing happens to omit on a given run, and partial
 * fetches, survive. That same retention also preserves mappings for routes
 * upstream has since rerouted *away* from a station — e.g. a troncal
 * "C15 Chapinero" that no longer calls at Nariño, or "M85 Museo Nacional" no
 * longer serving Fucha. Those stale mappings surface as phantom or duplicate
 * route tags in a station popup.
 *
 * The route recorrido (`routes[code][].stops`) is the source of truth for which
 * stations a route serves (spec §5.1.2). A wagon entry is kept only if some
 * variant sharing its código + normalized name lists this station among its
 * stops; retained day-dependent routes keep their own retained recorrido, so
 * they survive. Empty wagons left behind are removed. Returns the count pruned.
 */
export function pruneUnservedStationRoutes(catalog: MasterCatalog): number {
  // código → normalized name → set of station codes the recorrido serves.
  const served = new Map<string, Map<string, Set<string>>>();
  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    const codeKey = code.toUpperCase().trim();
    let byName = served.get(codeKey);
    if (!byName) {
      byName = new Map();
      served.set(codeKey, byName);
    }
    for (const variant of variants) {
      const nameKey = cleanRouteName(variant.nombre);
      let stops = byName.get(nameKey);
      if (!stops) {
        stops = new Set();
        byName.set(nameKey, stops);
      }
      for (const stop of variant.stops || []) {
        if (stop?.codigo) stops.add(String(stop.codigo).toUpperCase().trim());
      }
    }
  }

  let pruned = 0;
  for (const [stationCode, station] of Object.entries(catalog.stations || {})) {
    const stationKey = String(stationCode).toUpperCase().trim();
    for (const [wagon, routes] of Object.entries(station.wagons || {})) {
      const kept = routes.filter((r) => {
        const stops = served.get((r.codigo || '').toUpperCase().trim())?.get(cleanRouteName(r.nombre));
        return stops ? stops.has(stationKey) : false;
      });
      if (kept.length === routes.length) continue;
      pruned += routes.length - kept.length;
      if (kept.length > 0) station.wagons[wagon] = kept;
      else delete station.wagons[wagon];
    }
  }
  return pruned;
}

/**
 * Drops route variants no sync has seen for `ROUTE_RETENTION_DAYS`.
 *
 * The counterpart to retention. `mergeCatalogs` keeps everything a fetch missed,
 * because the upstream listing drifts and absence from one run proves nothing —
 * but with no clock that rule also keeps routes TransMi has genuinely retired,
 * forever. A variant is dropped only when the catalog has watched it be absent
 * across the whole window, and only after a sync that saw the whole network
 * (the caller's health check): a partial fetch is precisely what retention is
 * for, and must never be read as a retirement.
 *
 * Unstamped variants are stamped rather than judged, so the first sync after
 * this shipped starts everyone's clock instead of expiring the catalog.
 */
export function expireUnseenVariants(catalog: MasterCatalog, now: number): number {
  const cutoff = now - ROUTE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let dropped = 0;

  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    // An answered retirement does not wait out the window. Retention exists
    // because absence from one listing proves nothing; a route the network has
    // actually ended is not an absence, it is a fact on file
    // (`recorrido_corrections.json`) — and upstream can retire a código without
    // ever reusing its id, which is the one case the rename purge cannot see.
    if (isRetiredRoute(code)) {
      dropped += variants.length;
      delete catalog.routes[code];
      continue;
    }
    const kept = variants.filter((variant) => {
      if (typeof variant.seenAt !== 'number') {
        variant.seenAt = now;
        return true;
      }
      return variant.seenAt >= cutoff;
    });
    if (kept.length === variants.length) continue;
    dropped += variants.length - kept.length;
    if (kept.length > 0) catalog.routes[code] = kept;
    else delete catalog.routes[code];
  }

  return dropped;
}

/**
 * Collapses variants that share a código AND an id.
 *
 * One id is one run of one route, so two entries under it are one entry and a
 * stale name — upstream renamed it in place and the name-keyed variant map kept
 * both. The newest `seenAt` is the current name; the rest are phantoms that
 * print a duplicate chip wherever the route calls.
 *
 * `mergeCatalogs` now refuses these on the way in. This is the same answer
 * applied to the catalog already on disk, so the fix does not wait on a
 * seventy-minute re-fetch. Returns the number dropped.
 */
export function dropRenamedInPlace(catalog: MasterCatalog): number {
  let dropped = 0;
  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    const newest = new Map<string, number>();
    for (const v of variants) {
      const id = String(v.id ?? '').trim();
      if (!id) continue;
      newest.set(id, Math.max(newest.get(id) ?? 0, v.seenAt ?? 0));
    }
    const seen = new Set<string>();
    const kept = variants.filter((v) => {
      const id = String(v.id ?? '').trim();
      if (!id) return true;
      if ((v.seenAt ?? 0) < (newest.get(id) ?? 0)) return false;
      // Two entries stamped identically: keep the first, drop the rest.
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (kept.length === variants.length) continue;
    for (const v of variants) {
      if (!kept.includes(v)) console.log(`[TM API]   dropped ${code} #${v.id} "${v.nombre}" (renamed in place)`);
    }
    dropped += variants.length - kept.length;
    catalog.routes[code] = kept;
  }
  return dropped;
}

/**
 * Drops the route variants `recorrido_corrections.json` files as replaced.
 *
 * `mergeCatalogs` refuses them on the way in, but a variant already sitting in
 * the catalog when the entry is filed would otherwise wait out the full 21-day
 * retention window — and a whole re-sync is a ~70-minute round trip to apply a
 * fact that is already answered. Returns the number dropped.
 */
export function dropRetiredVariants(catalog: MasterCatalog): number {
  let dropped = 0;
  for (const [code, variants] of Object.entries(catalog.routes || {})) {
    // A código answered as retired goes the same way, and for the same reason:
    // `expireUnseenVariants` already short-circuits its clock, but that only
    // runs after a healthy sync. Filing a retirement and then waiting seventy
    // minutes to see it is what this repair path exists to avoid.
    if (isRetiredRoute(code)) {
      console.log(`[TM API]   dropped ${code} — retired (recorrido_corrections.json)`);
      dropped += variants.length;
      delete catalog.routes[code];
      continue;
    }
    const kept = variants.filter((variant) => !isRetiredVariant(code, variant.id));
    if (kept.length === variants.length) continue;
    // Named, not just counted. A file entry outlives its cause the moment
    // upstream republishes the route, and this is the one path that would drop
    // it again on the way past — so it says out loud which (código, id) it took.
    for (const variant of variants) {
      if (!kept.includes(variant)) {
        console.log(`[TM API]   dropped ${code} #${variant.id} "${variant.nombre}" (filed as replaced)`);
      }
    }
    dropped += variants.length - kept.length;
    if (kept.length > 0) catalog.routes[code] = kept;
    else delete catalog.routes[code];
  }
  return dropped;
}

/**
 * Moves services out of the unlettered `"0"` pool onto the vagón their station's
 * plano prints (`plateWagon`).
 *
 * The sync applies this at the edge, where the recorrido's empty `vagon` is
 * first read. This is the same answer applied to what is already in the catalog
 * — mappings retained from a previous run, and every station written before the
 * sheet was read — so the two paths converge without a 70-minute re-fetch.
 * Returns the number of mappings moved.
 */
export function applyPlanoWagons(catalog: MasterCatalog): number {
  let moved = 0;
  for (const station of Object.values(catalog.stations || {})) {
    const pool = station.wagons?.['0'];
    if (!pool || pool.length === 0) continue;

    const stayed: CatalogRoute[] = [];
    for (const route of pool) {
      const wagon = plateWagon(station.codigo, route.codigo);
      if (!wagon) {
        stayed.push(route);
        continue;
      }
      const target = station.wagons[wagon] || (station.wagons[wagon] = []);
      const key = `${(route.codigo || '').toUpperCase().trim()}|${cleanRouteName(route.nombre)}`;
      const already = target.some(
        (r) => `${(r.codigo || '').toUpperCase().trim()}|${cleanRouteName(r.nombre)}` === key
      );
      if (!already) target.push(route);
      moved++;
    }

    if (stayed.length === pool.length) continue;
    if (stayed.length > 0) station.wagons['0'] = stayed;
    else delete station.wagons['0'];
  }
  return moved;
}
