/**
 * Live buses from TRANSMILENIO's GTFS-Realtime feed (spec §5.2.8), the first
 * tier of the live cascade.
 *
 * `positions.pb` holds the whole fleet, republished about every 21 s as open
 * data (announced 2026-11-04), with no geofence, no app id and no install id —
 * the access path the other tiers lack (§5.2.3, §5.2.5). The tier answers when it
 * can and steps aside, empty, when it cannot: a stale or unreachable feed, a
 * route it does not carry, no bus of that route in it. The tiers below then
 * answer as before. It froze for over a day four days after launch, so it is a
 * tier, not a replacement.
 *
 * The feed names a bus's GTFS route and the stop it last reached, not a código or
 * a direction. `data/gtfs_rt_index.json` (`npm run sync:gtfs-rt`) gives the
 * route's short name and the stop's code, and the catalog does the rest:
 *   - a troncal GTFS route runs one direction, named as the catalog names it;
 *   - every other GTFS route is a ROUND TRIP, often of two códigos at once
 *     (`CA153` = A153 out, C153 back), so a bus runs the variant whose stops
 *     hold the stop it last reached.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isZonalService } from './route_type.js';
import type { CatalogRouteDetail } from './catalog_merge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FEED_URL = 'https://gtfs.transmilenio.gov.co/positions.pb';
/** The feed republishes about every 21 s; asking sooner only gets the same file. */
const REFRESH_MS = 20_000;
/** A feed whose newest fix is older than this has stalled (it froze for a day from 2026-11-05 19:11). */
export const STALE_AFTER_S = 180;
const FETCH_TIMEOUT_MS = 4_000;

// ─── positions.pb ─────────────────────────────────────────

/** One vehicle of `positions.pb`: the fields this tier reads. */
export interface FeedVehicle {
  routeId: string;
  /** The stop the bus last reached — it matches the trip update's stop, whose arrival is already past. */
  stopId: string;
  lat: number;
  lon: number;
  id: string;
  label: string;
  /** Epoch seconds. The feed stamps every vehicle with the batch time, not its own fix. */
  timestamp: number;
}

type Field = number | [start: number, end: number];

/** Each protobuf field of buf[start, end): varints and 32-bit values as numbers, length-delimited ones as their byte range. */
function eachField(buf: Buffer, start: number, end: number, on: (field: number, value: Field) => void): void {
  let i = start;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (i >= end) throw new Error('GTFS-RT: truncated varint');
      const byte = buf[i++];
      value += (byte & 0x7f) * 2 ** shift; // not `<<`: a timestamp's high bits would wrap
      if (byte < 0x80) return value;
    }
  };
  while (i < end) {
    const key = varint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    const width = wire === 0 ? 0 : wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? varint() : -1;
    if (width < 0) throw new Error(`GTFS-RT: wire type ${wire}`);
    if (i + width > end) throw new Error('GTFS-RT: field runs past its message');
    if (wire === 0) on(field, varint());
    else if (wire === 2) on(field, [i, i + width]);
    else if (wire === 5) on(field, buf.readFloatLE(i));
    i += width; // wire 1 (fixed64: odometer) is skipped
  }
}

const text = (buf: Buffer, value: Field): string => (Array.isArray(value) ? buf.toString('utf8', value[0], value[1]) : '');

/** The vehicles of a GTFS-Realtime FeedMessage (gtfs-realtime.proto: entity 2 → vehicle 4). */
export function decodePositions(buf: Buffer): FeedVehicle[] {
  const out: FeedVehicle[] = [];
  eachField(buf, 0, buf.length, (field, entity) => {
    if (field !== 2 || !Array.isArray(entity)) return;
    eachField(buf, entity[0], entity[1], (f, position) => {
      if (f !== 4 || !Array.isArray(position)) return;
      const v: FeedVehicle = { routeId: '', stopId: '', lat: NaN, lon: NaN, id: '', label: '', timestamp: 0 };
      eachField(buf, position[0], position[1], (g, x) => {
        if (g === 1 && Array.isArray(x)) {
          eachField(buf, x[0], x[1], (h, y) => { if (h === 5) v.routeId = text(buf, y); }); // trip.route_id
        } else if (g === 2 && Array.isArray(x)) {
          eachField(buf, x[0], x[1], (h, y) => {
            if (typeof y !== 'number') return;
            if (h === 1) v.lat = y;
            else if (h === 2) v.lon = y;
          });
        } else if (g === 7) v.stopId = text(buf, x);
        else if (g === 5 && typeof x === 'number') v.timestamp = x;
        else if (g === 8 && Array.isArray(x)) {
          eachField(buf, x[0], x[1], (h, y) => {
            if (h === 1) v.id = text(buf, y);
            else if (h === 2) v.label = text(buf, y);
          });
        }
      });
      // 0 is a bus with no fix, not a place (as in the bus log).
      if (v.routeId && v.lat && v.lon && Number.isFinite(v.lat) && Number.isFinite(v.lon)) out.push(v);
    });
  });
  return out;
}

// ─── From GTFS ids to the catalog ─────────────────────────

/** `data/gtfs_rt_index.json`: GTFS route id → [short name, long name, agency id]; stop id → stop code. */
export interface RtIndex {
  routes: Record<string, [short: string, long: string, agency: string]>;
  stops: Record<string, string>;
}

/** A bus as the live tiers hand it on: the live host's field names, which every client reads. */
export interface OfficialBus {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  lasttime: string;
  ruta_extraida: string;
  destino_limpio?: string;
  angulo?: number;
}

/** GTFS agency 1 is Transmilenio-Troncal: one direction per route, its código as written. */
const TRONCAL_AGENCY = '1';
/** Alimentadores, Zonal-Urbano, -Complementario, -Especial: the zonal network as the clients count it
 *  (`isZonalService`); 1 Troncal, 6 Dual and 7 TransMiCable are the troncal one. */
const ZONAL_AGENCIES = new Set(['2', '3', '4', '5']);

/**
 * The códigos a GTFS short name stands for: itself, and outside the troncal the
 * two halves of a round trip written as one — `M86-K86`, or `CA153` for C153 +
 * A153 (letter + letter + number). `8-1` is one feeder código, not two.
 */
export function codigosOf(shortName: string, agency: string): string[] {
  const name = shortName.trim().toUpperCase();
  if (agency === TRONCAL_AGENCY) return [name];
  const pair = /^([A-Z]+\d+[A-Z]?)-([A-Z]+\d+[A-Z]?)$/.exec(name);
  if (pair) return [name, pair[1], pair[2]];
  const merged = /^([A-Z])([A-Z])(\d+[A-Z]?)$/.exec(name);
  return merged ? [name, merged[1] + merged[3], merged[2] + merged[3]] : [name];
}

/** Accent-, case-, space- and punctuation-blind: the catalog's "P ElDorado" is GTFS's "PElDorado". */
const fold = (name: string): string =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** "Unicentro Ciclovía" and "Unicentro Festivo" run Unicentro's stops: one direction, not two. */
const direction = (name: string): string => fold(name).replace(/(ciclovia|festivo)$/, '');

/**
 * The variant running through `stopCode`, and where on it. Variants of one
 * direction (the Ciclovía and Festivo twins) count once, as the plain one; a stop
 * both directions serve (a loop, a terminal) places nothing.
 */
function variantAtStop(variants: CatalogRouteDetail[], stopCode: string): { variant: CatalogRouteDetail; k: number } | null {
  const hits = variants.flatMap((variant) => {
    const k = variant.stops?.findIndex((stop) => stop.codigo === stopCode) ?? -1;
    return k < 0 ? [] : [{ variant, k }];
  });
  if (hits.length === 0 || new Set(hits.map((hit) => direction(hit.variant.nombre))).size > 1) return null;
  return hits.reduce((a, b) => (b.variant.nombre.length < a.variant.nombre.length ? b : a));
}

/** Compass bearing (0 = N, clockwise) between two catalog coordinates ("lat,lng"), as the live host's `angulo`. */
function bearing(from: string, to: string): number | undefined {
  const [la1, lo1] = from.split(',').map(Number);
  const [la2, lo2] = to.split(',').map(Number);
  if (![la1, lo1, la2, lo2].every(Number.isFinite)) return undefined;
  const r = Math.PI / 180;
  const y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
  return Math.round((Math.atan2(y, x) / r + 360) % 360);
}

/** Bogotá wall clock ("07:11:31 PM"), the way the live host writes `lasttime`. Bogotá is UTC−5 all year. */
export function wallClock(epochS: number): string {
  const d = new Date((epochS - 5 * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = d.getUTCHours();
  return `${pad(h % 12 || 12)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The buses of one catalog route in a feed snapshot.
 *
 * Troncal requests name the direction (`names`) and get that direction only. A
 * zonal answer is shared by everyone watching the código (§5.2.4), so it carries
 * every direction, each bus labelled with its own (`destino_limpio`) and pointed
 * along its leg (`angulo`, last stop → next stop) for the client's filters.
 */
export function officialBusesFor(
  byRoute: Map<string, FeedVehicle[]>,
  index: RtIndex,
  ruta: string,
  routeType: 'troncal' | 'zonal',
  names: string[],
  variants: CatalogRouteDetail[]
): OfficialBus[] {
  const code = ruta.trim().toUpperCase();
  const mine = variants.filter((v) => isZonalService(v.sistema, v.tipoServicio) === (routeType === 'zonal'));
  const wanted = new Set(routeType === 'troncal' ? names.map(fold).filter(Boolean) : []);
  const out: OfficialBus[] = [];
  if (mine.length === 0) return out;

  for (const [routeId, [short, long, agency]] of Object.entries(index.routes)) {
    // C25 is a zonal route and a troncal one: the other network's buses are not this rider's.
    if (ZONAL_AGENCIES.has(agency) !== (routeType === 'zonal')) continue;
    if (!codigosOf(short, agency).includes(code)) continue;
    const exact = short.trim().toUpperCase() === code;
    for (const v of byRoute.get(routeId) ?? []) {
      const stopCode = Object.hasOwn(index.stops, v.stopId) ? index.stops[v.stopId] : '';
      const at = stopCode ? variantAtStop(mine, stopCode) : null;
      const variant = at?.variant ?? (exact ? mine.find((m) => fold(m.nombre) === fold(long)) : undefined);
      // A merged route's bus we cannot place may be on the other código's half.
      if (!variant && !exact) continue;
      if (wanted.size > 0 && !(variant && wanted.has(fold(variant.nombre)))) continue;
      const next = at ? at.variant.stops?.[at.k + 1] : undefined;
      const angulo = at && next ? bearing(at.variant.stops![at.k].coordenada, next.coordenada) : undefined;
      out.push({
        id: v.id || v.label,
        label: v.label || v.id,
        latitude: v.lat,
        longitude: v.lon,
        lasttime: wallClock(v.timestamp),
        ruta_extraida: variant?.codigo ?? ruta,
        ...(variant ? { destino_limpio: variant.nombre } : {}),
        ...(angulo !== undefined ? { angulo } : {}),
      });
    }
  }
  return out;
}

// ─── The feed, shared ─────────────────────────────────────

let index: RtIndex | null | undefined;

function loadIndex(): RtIndex | null {
  if (index !== undefined) return index;
  try {
    index = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'data', 'gtfs_rt_index.json'), 'utf-8')) as RtIndex;
  } catch {
    console.warn('[GTFS-RT] gtfs_rt_index.json unreadable; the official feed tier is off.');
    index = null;
  }
  return index;
}

/** Bounded like every upstream read (§5.2.5): the file is ~1 MB. */
const MAX_FEED_BYTES = 8 * 1024 * 1024;

async function fetchFeed(): Promise<Buffer> {
  const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_FEED_BYTES) throw new Error(`response exceeded ${MAX_FEED_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

interface Snapshot {
  /** The newest vehicle timestamp, epoch seconds. */
  newest: number;
  byRoute: Map<string, FeedVehicle[]>;
}

let snapshot: Snapshot | null = null;
let lastTry = 0;
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  try {
    const byRoute = new Map<string, FeedVehicle[]>();
    let newest = 0;
    for (const v of decodePositions(await fetchFeed())) {
      newest = Math.max(newest, v.timestamp);
      const list = byRoute.get(v.routeId);
      if (list) list.push(v);
      else byRoute.set(v.routeId, [v]);
    }
    snapshot = { newest, byRoute };
  } catch (error: any) {
    console.warn('[GTFS-RT] feed unreadable:', error?.message ?? error);
  }
}

/**
 * One snapshot for every route and rider, read at most every {@link REFRESH_MS}
 * and only while someone asks. A due refresh runs in the background — only the
 * first ask after boot waits for it — and a stalled feed reads as none.
 */
async function currentSnapshot(nowMs: number): Promise<Snapshot | null> {
  if (nowMs - lastTry >= REFRESH_MS) {
    lastTry = nowMs;
    inflight = refresh().finally(() => { inflight = null; });
  }
  if (!snapshot && inflight) await inflight;
  return snapshot && nowMs / 1000 - snapshot.newest <= STALE_AFTER_S ? snapshot : null;
}

/** The route's buses from the official feed, or none when the feed cannot say. Never throws. */
export async function fetchOfficialLiveBuses(
  ruta: string,
  routeType: 'troncal' | 'zonal',
  names: string[],
  variants: CatalogRouteDetail[]
): Promise<OfficialBus[]> {
  try {
    const idx = loadIndex();
    if (!idx || variants.length === 0) return [];
    const feed = await currentSnapshot(Date.now());
    return feed ? officialBusesFor(feed.byRoute, idx, ruta, routeType, names, variants) : [];
  } catch (error: any) {
    // A fault here must cost one tier, not the cascade.
    console.warn('[GTFS-RT] tier failed:', error?.message ?? error);
    return [];
  }
}
