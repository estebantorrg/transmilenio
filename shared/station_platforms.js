/**
 * Stations the official catalog files as ONE stop and that are two stations on
 * the ground, and the pedestrian tunnels that join stations to each other.
 *
 * Avenida Jiménez and Ricaurte are each a trunk platform and a Calle 13
 * platform, published by the operator as two separate planos, joined
 * underground and nothing else. The app's own catalog gives them one código
 * apiece, so every surface that keyed on the código showed one merged station:
 * a rider standing on Ricaurte's NQS platform was told about six vagones, three
 * of which are across a tunnel on a different troncal with no service in common.
 *
 * The map has always drawn them as two points — ArcGIS exposes each platform
 * separately and `stationCatalogResolver.VERIFIED_SPLITS` partitions the merged
 * stop by wagon. This module is that same partition, in the one place both the
 * server (which prerenders the pages) and the browser can read it, so a platform
 * can have its own URL rather than borrowing the merged stop's.
 *
 * The código of a platform page is the parent's plus a short suffix. It is not a
 * code the operator issues; it exists so `/estacion/<slug>-<codigo>/` can name
 * one platform, and it is deliberately built FROM the parent so anyone reading a
 * URL or a log line can see which stop it belongs to.
 */

/**
 * @typedef {object} StationPlatform
 * @property {string} codigo      Page código, e.g. `TM0069NQS`.
 * @property {string} parent      The merged catalog stop, e.g. `TM0069`.
 * @property {string} nombre      What the platform is called on the map.
 * @property {string[]} wagones   The parent's wagon letters this platform holds.
 * @property {string} corridor    The troncal this platform is actually on.
 * @property {string} [matchMethod] The map resolver's id for the same platform.
 * @property {string} [tunelA]    Station or platform código the tunnel leads to.
 * @property {string} [nodo]      The register's node id for THIS platform, so a
 *                                platform page reports its own ridership rather
 *                                than the merged stop's.
 */

/** @type {StationPlatform[]} */
export const STATION_PLATFORMS = [
  {
    codigo: 'TM0013CAR',
    parent: 'TM0013',
    nombre: 'AV. Jiménez - Caracas',
    wagones: ['A', 'B', 'C'],
    corridor: 'Caracas',
    matchMethod: 'verified-split:av-jimenez-caracas',
    nodo: '9110',
    // NO `tunelA`. There is a tunnel, and its own plano strikes it through in
    // red — CIERRE. A closed crossing is not a way to the other platform, and
    // offering it as one would be the confident wrong answer this dataset
    // exists to avoid.
  },
  {
    codigo: 'TM0013C13',
    parent: 'TM0013',
    nombre: 'AV. Jiménez - CL 13',
    wagones: ['D', 'E'],
    corridor: 'Américas',
    matchMethod: 'verified-split:av-jimenez-cl13',
    nodo: '14003',
  },
  {
    codigo: 'TM0069NQS',
    parent: 'TM0069',
    nombre: 'Ricaurte - NQS',
    wagones: ['A', 'B', 'C'],
    corridor: 'NQS Central',
    matchMethod: 'verified-split:ricaurte-nqs',
    nodo: '7111',
    tunelA: 'TM0069C13',
  },
  {
    codigo: 'TM0069C13',
    parent: 'TM0069',
    nombre: 'Ricaurte - CL 13',
    wagones: ['D', 'E', 'F'],
    corridor: 'Américas',
    matchMethod: 'verified-split:ricaurte-cl13',
    nodo: '12003',
    tunelA: 'TM0069NQS',
  },
];

/**
 * Pedestrian tunnels between two stations the catalog keeps apart — the same
 * fact as a platform's `tunelA`, for pairs that are already separate stops.
 *
 * Las Aguas and Universidades are joined by one; Las Aguas draws its mouth on
 * its own plano in platform styling, with a `Vagón 1` plate on it, which is why
 * the plate scanner had to be taught it is not a platform. It is a way to the
 * next station, and saying so is more use to a rider than hiding it.
 */
export const STATION_TUNNELS = {
  TM0121: 'TM0122',
  TM0122: 'TM0121',
};

const BY_CODE = new Map(STATION_PLATFORMS.map((p) => [p.codigo, p]));
const BY_METHOD = new Map(
  STATION_PLATFORMS.filter((p) => p.matchMethod).map((p) => [p.matchMethod, p])
);

/** The platform a page código names, or undefined for an ordinary station. */
export function stationPlatform(codigo) {
  return BY_CODE.get(String(codigo ?? '').trim().toUpperCase());
}

/** The platform the map resolver's `matchMethod` names, if it is a split. */
export function platformForMatchMethod(matchMethod) {
  return BY_METHOD.get(String(matchMethod ?? ''));
}

/** Every platform of a merged stop, in page order. */
export function platformsOf(parentCodigo) {
  const parent = String(parentCodigo ?? '').trim().toUpperCase();
  return STATION_PLATFORMS.filter((p) => p.parent === parent);
}

/** The station or platform a tunnel from here leads to, if any. */
export function tunnelFrom(codigo) {
  const code = String(codigo ?? '').trim().toUpperCase();
  return stationPlatform(code)?.tunelA ?? STATION_TUNNELS[code];
}

/**
 * One platform as a station in its own right: the parent stop narrowed to the
 * wagons that platform holds, its own name and troncal, and only the drawn rows
 * belonging to it.
 *
 * Narrowing by WAGON and not by route code, because the codes do not separate
 * cleanly: route 5 terminates at Av. Jiménez, the catalog files it under a
 * Caracas wagon, and the Calle 13 plano also prints it on Vagón 5. Keyed on
 * codes, the Caracas platform would claim a vagón from across the tunnel.
 *
 * Returns null when the parent is not the platform's stop, so a caller cannot
 * quietly build a platform out of the wrong station.
 */
export function platformStation(platform, parentStation) {
  if (!platform || !parentStation) return null;
  if (String(parentStation.codigo ?? '').trim().toUpperCase() !== platform.parent) return null;

  const keep = new Set(platform.wagones.map((w) => w.toUpperCase()));
  const wagons = {};
  for (const [key, routes] of Object.entries(parentStation.wagons ?? {})) {
    if (keep.has(key.trim().toUpperCase())) wagons[key] = routes;
  }

  const vagonLabels = {};
  for (const [key, label] of Object.entries(parentStation.vagonLabels ?? {})) {
    if (keep.has(key.trim().toUpperCase())) vagonLabels[key] = label;
  }

  const wagonPlan = {};
  for (const [key, groups] of Object.entries(parentStation.wagonPlan ?? {})) {
    if (keep.has(key.trim().toUpperCase())) wagonPlan[key] = groups;
  }

  const layout = parentStation.planoLayout;
  const rows = (layout?.rows ?? []).filter((row) =>
    !row.wagones?.length ? true : row.wagones.some((w) => keep.has(String(w).trim().toUpperCase()))
  );

  return {
    ...parentStation,
    codigo: platform.codigo,
    nombre: platform.nombre,
    corridor: { ...(parentStation.corridor ?? {}), nombre: platform.corridor },
    wagons,
    vagonLabels,
    wagonPlan,
    ...(layout && rows.length ? { planoLayout: { ...layout, rows } } : { planoLayout: undefined }),
  };
}
