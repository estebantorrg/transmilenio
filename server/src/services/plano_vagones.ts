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

/** Vagón plates counted on each official plano, by station código. */
const PLANO_VAGONES: Record<string, number> = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, '..', 'data', 'plano_vagones.json'), 'utf-8')).counts ?? {};
  } catch {
    // A missing dataset must not break the catalog — it only costs numbering.
    console.warn('[TM API] plano_vagones.json unreadable; vagón numbers will be omitted.');
    return {};
  }
})();

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
