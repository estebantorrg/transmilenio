/**
 * Types for `station_platforms.js` — the platforms of a station the catalog
 * files as one stop, and the tunnels between stations.
 *
 * Hand-written to sit beside the module, the same way `rutero.d.ts` does: the
 * source is plain JS so the server can import it without a build step, and the
 * browser still gets it typed.
 */

export interface StationPlatform {
  /** Page código, e.g. `TM0069NQS` — the parent's plus a short suffix. */
  codigo: string;
  /** The merged catalog stop this platform belongs to, e.g. `TM0069`. */
  parent: string;
  /** What the platform is called on the map and on its own page. */
  nombre: string;
  /** The parent's wagon letters this platform holds. */
  wagones: string[];
  /** The troncal this platform is actually on, which is not always the
   *  parent's: Ricaurte's stop is filed under NQS Central and half of it is on
   *  Américas. */
  corridor: string;
  /** The map resolver's id for the same platform (`verified-split:…`). */
  matchMethod?: string;
  /** Station or platform código a pedestrian tunnel from here leads to. Absent
   *  where the tunnel is closed — Av. Jiménez's plano strikes its own through
   *  in red, and a closed crossing is not a way anywhere. */
  tunelA?: string;
  /** The register's node id for THIS platform. The open ridership dataset is
   *  keyed by node, so without it both halves would report the merged stop. */
  nodo?: string;
}

/** A station shape narrowed to one platform. Structurally the catalog station
 *  it came from, so every caller that takes a catalog station takes this. */
export interface PlatformStation {
  codigo: string;
  nombre: string;
  corridor?: { nombre?: string; letra?: string; sentidos?: { positive: string; negative: string } };
  wagons: Record<string, unknown[]>;
  vagonLabels?: Record<string, string>;
  wagonPlan?: Record<string, unknown[]>;
  planoLayout?: unknown;
  [key: string]: unknown;
}

export declare const STATION_PLATFORMS: StationPlatform[];

/** Pedestrian tunnels between two stations the catalog keeps apart, código →
 *  código, stated from both ends. */
export declare const STATION_TUNNELS: Record<string, string>;

export declare function stationPlatform(codigo: unknown): StationPlatform | undefined;
export declare function platformForMatchMethod(matchMethod: unknown): StationPlatform | undefined;
export declare function platformsOf(parentCodigo: unknown): StationPlatform[];
export declare function tunnelFrom(codigo: unknown): string | undefined;
export declare function platformStation<T extends { codigo?: unknown }>(
  platform: StationPlatform | undefined,
  parentStation: T | undefined
): (T & PlatformStation) | null;
