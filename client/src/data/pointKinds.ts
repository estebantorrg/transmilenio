/**
 * The one vocabulary of "places" both clients look things up in.
 *
 * Spec §5.4.2b: the rider chooses what a query looks for, and every place
 * catalogue must be reachable by name — not only by GPS proximity. That means
 * the Cerca chips, the search-scope chips, the row badges and the planner's
 * endpoint suggestions all have to agree on which kinds exist, what they are
 * called, and how a query ranks against them. Kept here, outside either client's
 * UI, so a kind cannot exist in one surface and not the other (spec §1.1 R2).
 */

export type PointKind = 'station' | 'stop' | 'recharge' | 'personalizacion' | 'transmibici' | 'cable';

/** Display order everywhere: the two transit kinds first, then the POIs.
 *  `personalizacion` sits next to `recharge` — both are tullave counters, and a
 *  rider looking for one often wants the other. */
export const POINT_KINDS: PointKind[] = ['station', 'stop', 'recharge', 'personalizacion', 'transmibici', 'cable'];

export interface PointKindMeta {
  /** CSS modifier shared by the dot/badge in both clients. */
  cls: string;
  /** Singular badge label on a row. */
  label: string;
  /** Plural label for a chip or a heading. */
  plural: string;
  /** Sub-line when the point has no address of its own. */
  fallback: string;
  /** This kind carries an `hours`-style extra (opening hours, capacity) that is
   *  worth showing next to the address — for a POI that IS the useful bit.
   *  Data, not a `kind === 'recharge' || kind === '…'` chain repeated in four
   *  render sites that a new kind then silently misses (spec §1.1 R2). */
  carriesExtra?: boolean;
  /** Prefix for that extra when shown as its own pill (a detail sheet). */
  extraPrefix?: string;
}

export const POINT_KIND_META: Record<PointKind, PointKindMeta> = {
  station: { cls: 'is-station', label: 'Estación', plural: 'Estaciones', fallback: 'Estación troncal' },
  stop: { cls: 'is-stop', label: 'Paradero', plural: 'Paraderos', fallback: 'Paradero zonal' },
  recharge: { cls: 'is-recharge', label: 'Recarga', plural: 'Recargas', fallback: 'Punto de recarga tullave', carriesExtra: true, extraPrefix: 'Lun–Vie' },
  personalizacion: { cls: 'is-personalizacion', label: 'Personalización', plural: 'Personalización', fallback: 'Punto de personalización tullave', carriesExtra: true, extraPrefix: 'Lun–Vie' },
  transmibici: { cls: 'is-transmibici', label: 'Bici', plural: 'Bici', fallback: 'Cicloparqueadero TransMiBici', carriesExtra: true },
  cable: { cls: 'is-cable', label: 'Cable', plural: 'Cable', fallback: 'Estación TransMiCable' },
};

/** Derived, not restated: a hand-written copy of the plurals is one more place
 *  a new kind has to be registered, and the two drifted apart silently. */
export const POINT_KIND_LABELS: Record<PointKind, string> = Object.fromEntries(
  POINT_KINDS.map((kind) => [kind, POINT_KIND_META[kind].plural])
) as Record<PointKind, string>;

/** Minimum a point must expose to be searchable. Both clients' record types
 *  structurally satisfy it, so neither has to convert. */
export interface SearchablePoint {
  name: string;
  direccion?: string;
  kind: PointKind;
}

/** Accent/case-insensitive fold — "Jimenez" must find "Jiménez". */
export function normalizePointText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/** Single-character queries match half the network — noise, not results. */
export const MIN_POINT_QUERY = 2;

export type PointMatches<T extends SearchablePoint> = Record<PointKind, T[]>;

export function emptyPointMatches<T extends SearchablePoint>(): PointMatches<T> {
  const out = {} as PointMatches<T>;
  for (const kind of POINT_KINDS) out[kind] = [];
  return out;
}

/**
 * Folded name + secondary text, memoised per point object. This runs over the
 * whole ~12 500-place universe on every debounced keystroke, so re-folding both
 * strings each time is real synchronous work on a phone (the same trap the
 * geocoder's `localIndex` exists for, spec §5.5.1).
 *
 * The cache is keyed on the point object; a client is expected to use one
 * `extraOf` for a given universe (both do — code + address).
 */
const haystacks = new WeakMap<object, { name: string; extra: string }>();

function haystackOf<T extends SearchablePoint>(point: T, extraOf?: (p: T) => string): { name: string; extra: string } {
  let hay = haystacks.get(point);
  if (!hay) {
    hay = {
      name: normalizePointText(point.name),
      extra: normalizePointText(extraOf ? extraOf(point) : point.direccion ?? ''),
    };
    haystacks.set(point, hay);
  }
  return hay;
}

/**
 * Every match for `query`, ranked and split BY KIND.
 *
 * Split rather than blended because that is what lets the scope chips carry a
 * real per-kind count and lets a focused scope show its whole set. Ranking is
 * name-prefix → name-substring → secondary-text, then alphabetical: taking list
 * order instead used to bury the estación a rider typed under the ~7400
 * paraderos whose *address* happened to contain the same words.
 */
export function rankPointsByKind<T extends SearchablePoint>(
  points: readonly T[],
  query: string,
  extraOf?: (p: T) => string
): PointMatches<T> {
  const out = emptyPointMatches<T>();
  const q = normalizePointText(query);
  if (q.length < MIN_POINT_QUERY) return out;

  const scored = {} as Record<PointKind, { p: T; s: number }[]>;
  for (const kind of POINT_KINDS) scored[kind] = [];
  for (const point of points) {
    const hay = haystackOf(point, extraOf);
    let s: number;
    if (hay.name.startsWith(q)) s = 0;
    else if (hay.name.includes(q)) s = 1;
    else if (hay.extra.includes(q)) s = 2;
    else continue;
    scored[point.kind]?.push({ p: point, s });
  }
  for (const kind of POINT_KINDS) {
    scored[kind].sort((a, b) => a.s - b.s || a.p.name.localeCompare(b.p.name, 'es'));
    out[kind] = scored[kind].map((x) => x.p);
  }
  return out;
}

export function countPointMatches<T extends SearchablePoint>(matches: PointMatches<T>): number {
  return POINT_KINDS.reduce((sum, kind) => sum + matches[kind].length, 0);
}

/**
 * Same-named paraderos (opposite platforms, repeated barrio stops) would fill
 * every preview slot with one name. Without a user fix there is no distance to
 * break the tie, so a mixed view caps each name; a focused scope shows them all.
 */
export function dedupePointsByName<T extends SearchablePoint>(points: readonly T[], perNameMax: number): T[] {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const p of points) {
    const key = haystackOf(p).name;
    const count = seen.get(key) ?? 0;
    if (count >= perNameMax) continue;
    seen.set(key, count + 1);
    out.push(p);
  }
  return out;
}

/**
 * The place rows a mixed view shows above the routes: the best hits taken
 * ROUND-ROBIN across kinds, so one crowded kind (paraderos) cannot hide the
 * others — an estación, a paradero, a recarga, a bici, a cable, then the next of
 * each.
 */
export function previewPointsAcrossKinds<T extends SearchablePoint>(
  matches: PointMatches<T>,
  limit: number,
  perNameMax = 2
): T[] {
  const perKind = POINT_KINDS.map((kind) => dedupePointsByName(matches[kind], perNameMax));
  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const list of perKind) {
      if (i >= list.length) continue;
      out.push(list[i]);
      added = true;
      if (out.length === limit) break;
    }
    if (!added) break;
  }
  return out;
}
