/**
 * SITP zone index (spec §5.4.2a).
 *
 * The ArcGIS `consulta_rutas_zonales` feed assigns every zonal route to a numeric
 * SITP zone (1–13) via `zona_origen_ruta_zonal` — authoritative even for
 * numeric-coded routes that carry no zone letter (661, 139…). This module builds
 * a `code → zones[]` map so the sidebar can browse zonal routes by zone.
 *
 * Ported from the mobile twin (`client/mobile/src/data.ts`) so the two clients
 * share one taxonomy (spec §1.1 R2).
 */

import type { RouteListItem } from '../types/transmilenio';
import { normalizeRouteCodeForMatch } from '../layers/routes';
import { isAlimentadorRoute } from '../utils/routeColors';

let zonalAreas = new Map<string, number[]>();
let zones: number[] = [];
let zoneLabels = new Map<number, string>();

/**
 * Normalizes a route code to match the ArcGIS zonal-routes feed against the
 * catalog: strips a trailing direction/variant letter and the catalog's
 * zero-padding after the zone letter (`F019` → `F19`). Applied to BOTH sides so
 * the two spellings collapse to the same key.
 */
export function variantBase(code: string): string {
  let s = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  s = s.replace(/[A-Z]$/, ''); // trailing variant letter (…E / …A / …C)
  // Direction suffix "-<n>" only for LETTERED codes (F405-2 → F405). For numeric
  // codes the hyphen is structural (10-12, 6-2) — keep it, or we'd collide route
  // 10-12 onto route 10 and tag the wrong buses.
  if (/^[A-Z]/.test(s)) s = s.replace(/-\d+$/, '');
  s = s.replace(/^([A-Z]+)0+(\d)/, '$1$2'); // drop catalog zero-padding F019 → F19
  return normalizeRouteCodeForMatch(s);
}

/** SITP numeric zones (1–13) a route touches, from the ArcGIS feed. */
export function getZonalAreas(code: string): number[] {
  return zonalAreas.get(variantBase(code)) ?? [];
}

/** Present zones (sorted), for building the browse chips. */
export function getZones(): number[] {
  return zones;
}

/** Recognizable Bogotá area label for a zone, or empty if none inferred. */
export function getZoneLabel(zone: number): string {
  return zoneLabels.get(zone) ?? '';
}

// Recognizable Bogotá areas/portals. A zone's label is whichever of these its
// routes' endpoints mention most — grounded in the real catalog, so no zone
// name is fabricated (the official number→name map is not public).
const ZONE_LANDMARKS = [
  'Ciudad Bolivar', 'Rafael Uribe', 'San Cristobal', 'Antonio Nariño', 'Puente Aranda', 'Barrios Unidos',
  'Portal 20 de Julio', 'Portal Americas', 'Portal Dorado', 'Portal Tunal', 'Portal Suba', 'Portal Norte',
  'Portal Sur', 'Portal Usme', 'Portal 80', 'Patio Bonito',
  'Usaquen', 'Suba', 'Engativa', 'Fontibon', 'Kennedy', 'Bosa', 'Usme', 'Tunjuelito', 'Teusaquillo',
  'Chapinero', 'Santa Fe', 'Candelaria', 'Martires', 'Tintal', 'Britalia', 'Verbenal', 'Tunal',
] as const;
const NORM_LANDMARKS = ZONE_LANDMARKS.map((l) => ({
  raw: l,
  norm: l.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
}));

/** Picks the dominant recognizable area per SITP zone from its routes' endpoints. */
function buildZoneLabels(routes: RouteListItem[]): void {
  const bags = new Map<number, Map<string, number>>();
  for (const r of routes) {
    if (r.type !== 'zonal' || isAlimentadorRoute(r)) continue;
    const zs = getZonalAreas(r.code);
    if (zs.length === 0) continue;
    const hay = `${r.origin} ${r.destination}`.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const lm of NORM_LANDMARKS) {
      if (!hay.includes(lm.norm)) continue;
      for (const z of zs) {
        let bag = bags.get(z);
        if (!bag) bags.set(z, (bag = new Map()));
        bag.set(lm.raw, (bag.get(lm.raw) ?? 0) + 1);
      }
    }
  }
  const labels = new Map<number, string>();
  for (const [z, bag] of bags) {
    let best = '';
    let bestN = 0;
    for (const [name, n] of bag) {
      if (n > bestN) {
        bestN = n;
        best = name;
      }
    }
    if (best) labels.set(z, best);
  }
  zoneLabels = labels;
}

/**
 * Builds the zone index from the ArcGIS `consulta_rutas_zonales` feed. A route is
 * assigned only to its home zone (`zona_origen`, 1–13); `zona_destino` is
 * deliberately ignored — it is frequently 0 (portal) or a corridor the route
 * merely reaches, which leaks non-belonging routes into a zone.
 */
export function buildZonalAreas(features: any[], routes: RouteListItem[]): void {
  const map = new Map<string, Set<number>>();
  const present = new Set<number>();
  for (const f of features) {
    const a = f.attributes ?? {};
    const key = variantBase(a.route_name_ruta_zonal || a.codigo_definitivo_ruta_zonal || '');
    if (!key) continue;
    const zone = Number(a.zona_origen_ruta_zonal);
    if (!Number.isInteger(zone) || zone < 1 || zone > 13) continue;
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(zone);
    present.add(zone);
  }
  zonalAreas = new Map([...map].map(([k, v]) => [k, [...v].sort((x, y) => x - y)]));
  zones = [...present].sort((x, y) => x - y);
  buildZoneLabels(routes);
}
