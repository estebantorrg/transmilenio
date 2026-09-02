/**
 * The vagón number printed on a station's platform signs — resolved once, here,
 * for every surface that names a platform (spec §5.5.4).
 *
 * The catalog keys wagons `A`/`B`/`C` (128 of 139 stations) while the signage in
 * the station reads "Vagón 1/2/3". A→1, B→2, C→3, D→4 was verified against the
 * official planos for Sevillana, León XIII, Bosa, General Santander, Calle 40
 * Sur, San Mateo and — on four vagones each — Granja-Carrera 77 and Suba-TV 91.
 *
 * It is NOT universal. It fails where the catalog groups platforms differently
 * from the signage: Calle 161 files 4 printed vagones under 2 wagons, so its
 * `A` mixes printed vagones 1 and 3. Most such cases are caught by comparing
 * the catalog's wagon count against the plate count counted off each plano and
 * committed to `data/plano_vagones.json`.
 *
 * That comparison is a PROXY, and Av. Jiménez is where it fails silently: five
 * wagons, five printed vagones across its two sheets, and the mapping still is
 * not one-to-one, because its wagons B and C are split by DIRECTION rather than
 * by platform and each spans two vagones. Equal counts would have passed it and
 * printed a wrong platform. `printed` in the same file is the answer for
 * stations like that — the mapping read off the sheet, which outranks the
 * counts wherever it exists.
 *
 * Sending a rider to "Vagón 1" when the sign says 3 is a real wrong answer, so
 * where the counts disagree no number is published at all. Resolved here rather
 * than at each render site because the app popup and the prerendered estación
 * page describe the same platform: the app used to print the catalog's raw key
 * ("Vagón A" — a letter that appears on no sign anywhere) while the SEO page
 * printed the gated number, so the two surfaces answered "which platform" two
 * different ways for the same station.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** One printed vagón in a station's drawn shape (`layouts`). */
export interface PlanoLayoutVagon {
  /** The number printed on its plate. */
  vagon: string;
  /**
   * The códigos on each of its two long edges, as the sheet draws them.
   *
   * Per vagón and not per platform, because the two are not the same question:
   * at Calle 85 one straight platform has vagón 4 serving southbound only,
   * vagón 3 northbound only, and vagones 2 and 1 both. A side declared once for
   * the whole platform cannot say that, and guessing it from the corridor would
   * put chips on an edge no bus stops at.
   */
  arriba?: string[];
  abajo?: string[];
  /**
   * código → the destination whose variant boards this vagón, for a código the
   * catalog files more than once here.
   *
   * A plate prints one chip per código. Where the catalog carries two variants
   * of that código in the same direction — La Castellana files `G12` southbound
   * to both `P. Sur` and `G. Santander` — drawing both puts two chips under one
   * sign and claims two boardable services. Which one it is, is answered here;
   * picking by array order would be a coin toss printed as a fact (§1).
   */
  destinos?: Record<string, string>;
  /**
   * `destinos` for the LOWER edge, where one vagón carries the same código on
   * both of its edges bound for different places.
   *
   * Ricaurte's Vagón 6 has route `5` above and below: `5` to Portal Américas on
   * the Américas side, `5` to Av. Jiménez on the other. One `destinos` names one
   * of them and would print it on both edges. Normally the direction filter
   * separates such a pair on its own, but not here — that half of the station
   * runs occidente↔oriente while the station's corridor is norte↔sur, so
   * neither variant matches either side, the filter correctly declines to drop
   * anything, and `destinos` then picks the same one twice.
   *
   * Falls back to `destinos` when absent, so every existing layout is unchanged.
   */
  destinosAbajo?: Record<string, string>;
}
/** One platform: a run of vagones, in the order the sheet draws them. */
export interface PlanoLayoutRow {
  /** How far along the drawing the row starts, in vagón columns — the stagger
   *  between two platforms that do not line up, as the sheet draws it. */
  offset: number;
  vagones: PlanoLayoutVagon[];
  /**
   * What this row's two long edges face, where the row does not share the
   * station's corridor.
   *
   * Most layouts are two platforms of ONE troncal, so the drawing names it once
   * around the whole thing. Ricaurte and Av. Jiménez are not: each is two
   * platform groups on DIFFERENT troncals, published as two separate sheets and
   * joined underground. Ricaurte's vagones 1–3 face AutoNorte / Suba / Calle 80
   * / NQS Central against Caracas Sur / Carrera 10 / NQS Sur, while its vagones
   * 4–6 face Américas / AV. Ciudad de Cali against Suba / Caracas / Carrera 7 /
   * Eje Ambiental. A single shared pair of labels would tell half the station
   * the other half's directions, which is worse than saying nothing.
   *
   * Set it on a row and the labels are drawn around that row alone.
   */
  eje?: { arriba: string; abajo: string };
  /**
   * The catalog wagon letters this platform IS, for a station the catalog
   * files as one stop and the map resolves as two.
   *
   * Ricaurte and Av. Jiménez are each two stations across a tunnel, and the
   * map already shows them as separate points. A popup opened on one of them
   * must not draw the other, and knowing which códigos resolve is not enough
   * to tell: route 5 terminates at Av. Jiménez, the catalog files it under a
   * CARACAS wagon, and the Calle 13 sheet prints it on Vagón 5 — so the
   * Caracas half drew a stray Vagón 5 from the platform across the tunnel.
   *
   * Absent on every station that is only one station, where it means "always
   * draw this row".
   */
  wagones?: string[];
}
export interface PlanoLayout {
  rows: PlanoLayoutRow[];
  /**
   * What physically separates the two platforms — answered, never assumed.
   *
   * The drawing called this a busway everywhere, on no evidence at all. It is
   * not: El Tiempo, AV. Rojas and Tygua are split by a **ciclorruta**,
   * and Guatoque by a **caño**, an open water channel. The sheets say so if you
   * look — the first three draw bici glyphs on the dividing line and Guatoque
   * draws it in blue — and telling a rider they must cross a busway to reach
   * the other platform, when what is actually there is a canal, is the kind of
   * confident wrong answer this dataset exists to avoid.
   *
   * Absent where nobody has checked: the drawing then separates the platforms
   * without naming what lies between them.
   */
  divider?: 'busway' | 'ciclorruta' | 'cano' | 'tren' | 'separador' | 'tunel';
}

/** One icon a plano draws on an access block. The legend on every sheet. */
export type PlanoIcono =
  | 'taquilla'
  | 'torniquete'
  | 'rampa'
  | 'escalera'
  | 'ascensor'
  | 'emergencia'
  | 'bici'
  | 'cable'
  | 'zonal';

/** A way out, and the street it comes out on. */
export interface PlanoSalida {
  /** The street as the sheet prints it under "Salida / Exit". */
  calle: string;
  /** Which way the sheet's arrow points. */
  hacia?: 'izq' | 'der';
  /** Which platform it serves, where the sheet draws one per row. */
  fila?: 'arriba' | 'abajo' | 'ambas';
}

/**
 * One column of the drawing, left to right as the sheet draws them.
 *
 * Columns rather than rows because only columns can say that a vestibule
 * spans BOTH platforms while the caño between them does not — which at
 * Guatoque is the difference between "there is no way across" and the truth.
 */
export type PlanoColumna =
  | {
      t: 'vestibulo';
      /** Which side the platform is on. 'der' mirrors the block for one at the
       *  RIGHT end of a drawing: its equipment and its way through sit on the
       *  left, and its exit points out to the right. */
      lado?: 'izq' | 'der';
      salidas?: PlanoSalida[];
      /** Icons on the upper platform, between the platforms, and on the
       *  lower one — the sheet places them per band, not per column. */
      arriba?: PlanoIcono[];
      centro?: PlanoIcono[];
      abajo?: PlanoIcono[];
    }
  | {
      t: 'vagones';
      /** Vagón NUMBERS, not services. The services are stated once, in
       *  `layouts`, so the compact drawing and this one cannot disagree. */
      arriba?: string;
      abajo?: string;
    }
  | { t: 'paso' }
  | {
      t: 'puente';
      nombre?: string;
      /** What gets a rider up to it — stairs, and a lift where the sheet
       *  draws one. Material Symbols has no bridge glyph, and an unlabelled
       *  arch read as nothing, so a bridge is drawn as a named structure
       *  carrying its own accesses, which is how the sheets mark it too. */
      sube?: string[];
    };

/**
 * The station as its plano actually draws it — platforms AND the furniture
 * around them. Read for the estación page only; the popup keeps the compact
 * drawing, because a popup is a glance and a page is what you study before
 * you travel.
 */
export interface PlanoDetalle {
  source?: string;
  why?: string;
  columnas: PlanoColumna[];
}

const PLANO_FILE: {
  counts?: Record<string, number>;
  wagons?: Record<string, Record<string, string>>;
  layouts?: Record<string, PlanoLayout>;
  printed?: Record<string, Record<string, string>>;
  detalle?: Record<string, PlanoDetalle>;
} = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, '..', 'data', 'plano_vagones.json'), 'utf-8'));
  } catch {
    // A missing dataset must not break the catalog — it only costs numbering.
    console.warn('[TM API] plano_vagones.json unreadable; vagón numbers will be omitted.');
    return {};
  }
})();

/** Vagón plates counted on each official plano, by station código. */
const PLANO_VAGONES: Record<string, number> = PLANO_FILE.counts ?? {};

/**
 * Station código → route código → the vagón letter the plano puts it on.
 *
 * Read off the same sheets as the plate counts, for the pairs upstream files
 * without a `vagon`.
 */
const PLANO_WAGONS: Record<string, Record<string, string>> = PLANO_FILE.wagons ?? {};

/**
 * The vagón a service boards from where the plano says so and the recorrido
 * does not.
 *
 * Upstream sends `vagon` empty on some recorrido stops and the sync files those
 * under wagon `"0"`, the pool that takes no platform number anywhere (see
 * `printedVagonLabels`). On the three Avenida Ciudad de Cali stations that is
 * two of the four services at each — the station page lists them with no
 * platform at all while the plano on the wall prints one. This is that printed
 * answer, and only that: a pair with no sheet stays in `"0"` rather than being
 * inferred from where its neighbours board (§1 Certainty).
 */
const PLANO_LAYOUTS: Record<string, PlanoLayout> = PLANO_FILE.layouts ?? {};

/**
 * The station's drawn shape, where the catalog's lettered wagons cannot express
 * it (`layouts` in `plano_vagones.json`).
 *
 * The bar this app draws assumes one segmented platform carrying both
 * directions, which is what most stations are. A **staggered** station is not:
 * two platforms face opposite carriageways, offset, with the busway between
 * them. At La Castellana each catalog wagon straddles both of them, so a bar
 * built from the letters puts services from opposite sides of a road on one
 * platform — and its plate count happened to match the letters, so the
 * numbering gate passed that through as `Vagón 1`.
 *
 * Returned only after reconciling against the catalog's own services
 * (`layoutServices`): a sheet that has drifted is a stale drawing, and the
 * caller drops it rather than drawing a station that no longer exists.
 */
export function planoLayout(stationCode: unknown): PlanoLayout | undefined {
  return PLANO_LAYOUTS[String(stationCode ?? '').trim().toUpperCase()];
}

/** Every código a layout claims, across both edges of every vagón, for
 *  reconciling it against the catalog. */
export function layoutServices(layout: PlanoLayout): Set<string> {
  const codes = new Set<string>();
  for (const row of layout.rows ?? []) {
    for (const vagon of row.vagones ?? []) {
      for (const codigo of [...(vagon.arriba ?? []), ...(vagon.abajo ?? [])]) {
        codes.add(String(codigo).trim().toUpperCase());
      }
    }
  }
  return codes;
}

/**
 * The full drawn station, for the stations whose sheet has been read element
 * by element. Absent for the rest, and the page then draws the compact plan.
 */
const PLANO_DETALLE: Record<string, PlanoDetalle> = PLANO_FILE.detalle ?? {};

export function planoDetalle(stationCode: unknown): PlanoDetalle | undefined {
  return PLANO_DETALLE[String(stationCode ?? '').trim().toUpperCase()];
}

export function plateWagon(stationCode: unknown, codigo: unknown): string | undefined {
  const station = PLANO_WAGONS[String(stationCode ?? '').trim().toUpperCase()];
  if (!station) return undefined;
  return station[String(codigo ?? '').trim().toUpperCase()];
}

/**
 * Wagon letter → the vagón number that wagon actually boards, read off the
 * sheet, for the stations where the A→1 arithmetic is not the answer.
 *
 * The count gate below is a PROXY: equal counts are taken as evidence that the
 * catalog's letters and the station's plates line up in order. Usually they do.
 * Av. Jiménez is the case that proves the proxy can pass and still be wrong —
 * five wagons, five printed vagones, and the mapping is not one-to-one. Its
 * wagons B and C each carry half of Vagón 2 and half of Vagón 3, split by
 * DIRECTION rather than by platform: C holds everything northbound across both,
 * B everything southbound. So counting alone would print "Vagón 2" for a wagon
 * whose riders are standing at Vagón 3 half the time.
 *
 * Where an entry exists here it is the answer and the counts are not consulted.
 * A wagon that straddles two vagones is simply left out, and takes no number.
 */
const PLANO_PRINTED: Record<string, Record<string, string>> = PLANO_FILE.printed ?? {};

/**
 * Wagon key → the number printed on that platform's sign, for the keys where it
 * can be trusted. Returns `undefined` when nothing can be published, so the
 * field simply doesn't ship rather than shipping an empty object.
 *
 * `letteredWagons` is the station's platform count as the catalog sees it —
 * wagon "0" excluded, since it is the pool the catalog files without a platform
 * letter (spec §5.5.4) and the planos print no plate for it.
 */
export function printedVagonLabels(
  stationCode: string,
  wagonKeys: string[],
  letteredWagons: number
): Record<string, string> | undefined {
  const code = String(stationCode).toUpperCase();
  const plates = PLANO_VAGONES[code];
  // An answered mapping outranks the count, in both directions: it numbers a
  // wagon the counts would have refused, and it withholds one the counts would
  // have got wrong.
  const printed = PLANO_PRINTED[code];
  const labels: Record<string, string> = {};

  for (const key of wagonKeys) {
    const k = key.trim().toUpperCase();
    if (k === '0') continue;
    if (!/^[A-Z]$/.test(k)) {
      labels[key] = key; // `T3` and numeric keys are already as-printed
      continue;
    }
    if (printed) {
      if (printed[k]) labels[key] = printed[k];
      continue;
    }
    if (plates && plates === letteredWagons) labels[key] = String(k.charCodeAt(0) - 64);
  }

  return Object.keys(labels).length > 0 ? labels : undefined;
}
