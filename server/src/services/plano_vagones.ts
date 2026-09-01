/**
 * The vagón number printed on a station's platform signs — resolved once, here,
 * for every surface that names a platform (spec §5.5.4).
 *
 * The catalog keys wagons `A`/`B`/`C` (128 of 139 stations) while the signage in
 * the station reads "Vagón 1/2/3". A→1, B→2, C→3, D→4 was verified against the
 * official planos for Sevillana, León XIII, Bosa, General Santander, Calle 40
 * Sur, San Mateo and — on four vagones each — Granja-Carrera 77 and Suba-TV 91.
 *
 * It is NOT universal. It fails exactly where the catalog groups platforms
 * differently from the signage: Calle 161 (catalog 2 wagons, plano prints 4, so
 * catalog `A` mixes printed vagones 1 and 3) and Av. Jiménez (catalog 5, plano
 * prints 3). Both are caught by comparing the catalog's wagon count against the
 * plate count counted off each plano and committed to `data/plano_vagones.json`
 * — a predicate that agreed with ground truth on 9 of the 10 stations checked,
 * and whose one miss errs toward silence. 93 of 139 stations get a number, 46
 * fall back to a neutral label.
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
}
/** One platform: a run of vagones, in the order the sheet draws them. */
export interface PlanoLayoutRow {
  /** How far along the drawing the row starts, in vagón columns — the stagger
   *  between two platforms that do not line up, as the sheet draws it. */
  offset: number;
  vagones: PlanoLayoutVagon[];
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
  divider?: 'busway' | 'ciclorruta' | 'cano' | 'tren';
}

const PLANO_FILE: {
  counts?: Record<string, number>;
  wagons?: Record<string, Record<string, string>>;
  layouts?: Record<string, PlanoLayout>;
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

export function plateWagon(stationCode: unknown, codigo: unknown): string | undefined {
  const station = PLANO_WAGONS[String(stationCode ?? '').trim().toUpperCase()];
  if (!station) return undefined;
  return station[String(codigo ?? '').trim().toUpperCase()];
}

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
  const plates = PLANO_VAGONES[String(stationCode).toUpperCase()];
  const labels: Record<string, string> = {};

  for (const key of wagonKeys) {
    const k = key.trim().toUpperCase();
    if (k === '0') continue;
    if (!/^[A-Z]$/.test(k)) {
      labels[key] = key; // `T3` and numeric keys are already as-printed
      continue;
    }
    if (plates && plates === letteredWagons) labels[key] = String(k.charCodeAt(0) - 64);
  }

  return Object.keys(labels).length > 0 ? labels : undefined;
}
