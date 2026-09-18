/**
 * Operator notices by station código, for the catalog to carry (spec §5.5.6).
 *
 * Whether a notice is in force is decided in the reader's browser
 * (`shared/avisos.js`), not here: the light catalog is built once and served
 * for days, and a nightly closure turns on and off inside that. What this does
 * is the part that does not depend on the hour — refuse a notice whose dates do
 * not parse, and leave out one that has already ended.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Aviso } from '../../../shared/avisos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type AvisoArchivo = Aviso & { estacion: string; fuente?: string; motivo?: string };

const HORA = /^\d{1,2}:\d{2}$/;

function valido(a: AvisoArchivo): boolean {
  if (!a || typeof a.titulo !== 'string' || !a.titulo.trim()) return false;
  if (!Number.isFinite(Date.parse(a.desde))) return false;
  if (a.hasta != null && !(Date.parse(a.hasta) > Date.parse(a.desde))) return false;
  if (a.franja && !(HORA.test(a.franja.desde) && HORA.test(a.franja.hasta))) return false;
  return true;
}

const AVISOS: Record<string, AvisoArchivo[]> = (() => {
  let file: { avisos?: AvisoArchivo[] };
  try {
    file = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'data', 'avisos.json'), 'utf-8'));
  } catch {
    // No notices is the normal state of a station, so a missing file costs
    // nothing but the notices.
    console.warn('[TM API] avisos.json unreadable; no operator notices will be shown.');
    return {};
  }
  const out: Record<string, AvisoArchivo[]> = {};
  for (const aviso of file.avisos ?? []) {
    if (!valido(aviso)) {
      console.warn(`[TM API] aviso ${aviso?.id ?? '?'}: dates or title do not parse; left out.`);
      continue;
    }
    const code = String(aviso.estacion ?? '').trim().toUpperCase();
    (out[code] ??= []).push(aviso);
  }
  return out;
})();

/**
 * The notices a station should ship: those not yet ended at `ahora`, without
 * the file's own bookkeeping. `fuente` and `motivo` say why a notice is on
 * file, which belongs in the file and not in a payload every visitor
 * downloads — the same rule `planoLayout` follows.
 */
export function stationAvisos(stationCode: unknown, ahora = Date.now()): Aviso[] | undefined {
  const list = AVISOS[String(stationCode ?? '').trim().toUpperCase()];
  if (!list) return undefined;
  const out = list
    .filter((a) => a.hasta == null || Date.parse(a.hasta) > ahora)
    .map(({ estacion: _e, fuente: _f, motivo: _m, ...aviso }) => aviso);
  return out.length ? out : undefined;
}
