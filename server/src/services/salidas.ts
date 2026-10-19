/**
 * Reading TRANSMILENIO's open "Salidas" files (spec §5.8): the parsing half of
 * `sync_demand.ts`. On its own, free of `import.meta`, so a test can load it
 * (`tests/demand-sync.spec.ts`) — what that script writes is committed to main
 * by a bot every day, with nobody reading it first.
 */

import zlib from 'node:zlib';
import { isFestivo } from '../../../shared/festivos.js';

/** Extracts the single CSV entry from a PKZIP buffer (handles the data-descriptor
 *  form these files use — the local header sizes are zero, so read the central
 *  directory). No external dependency. */
export function unzipSingleEntry(buf: Buffer): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: end-of-central-directory not found');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('ZIP: central directory header not found');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOff = buf.readUInt32LE(cdOffset + 42);
  if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('ZIP: local file header not found');
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + compSize);
  return method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp);
}

/** The two columns a Salidas CSV ends with, in order. */
const COUNT_COLUMNS = ['Entradas_E', 'Salidas_S'];

/** Aggregates one day's CSV into `agg` (code → summed entradas/salidas).
 *  The `Estacion` code is the only 5-digit `(NNNNN)` token per row (Línea and
 *  Acceso codes are 2-digit); `Entradas_E`/`Salidas_S` are the last two integer
 *  columns — robust even for the ~0.5% of rows with commas inside access names.
 *
 *  Read by position, so the header has to say the position still means that: a
 *  column appended upstream would otherwise be summed as if it were the exits,
 *  every row would still parse, and the wrong numbers would be committed. */
export function aggregateDay(csv: string, agg: Map<string, { e: number; s: number }>): number {
  const lines = csv.split(/\r?\n/);
  const header = lines[0].replace(/^﻿/, '').split(',').map((name) => name.trim());
  if (header.slice(-2).join() !== COUNT_COLUMNS.join()) {
    throw new Error(`Salidas CSV no longer ends in ${COUNT_COLUMNS.join(', ')}: "${lines[0].slice(0, 160)}"`);
  }

  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const codeMatch = line.match(/\((\d{5})\)/);
    if (!codeMatch) continue;
    const cols = line.split(',');
    const entradas = Number(cols[cols.length - 2]);
    const salidas = Number(cols[cols.length - 1]);
    if (!Number.isFinite(entradas) || !Number.isFinite(salidas)) continue;
    const prev = agg.get(codeMatch[1]) || { e: 0, s: 0 };
    prev.e += entradas;
    prev.s += salidas;
    agg.set(codeMatch[1], prev);
    rows++;
  }
  return rows;
}

/**
 * The first candidate `works` says yes to, or null. Tried a batch at a time,
 * in order: free proxies are mostly dead and a probe can take seconds, so one
 * at a time is minutes, and all at once is hundreds of sockets. A probe that
 * throws counts as a no.
 */
export async function firstWorking<T>(candidates: T[], works: (candidate: T) => Promise<boolean>, batch = 25): Promise<T | null> {
  for (let i = 0; i < candidates.length; i += batch) {
    const slice = candidates.slice(i, i + batch);
    const ok = await Promise.all(slice.map((candidate) => works(candidate).catch(() => false)));
    const at = ok.indexOf(true);
    if (at >= 0) return slice[at];
  }
  return null;
}

/**
 * Whether a service day belongs in the weekday mean: Monday to Friday, and not
 * a festivo. A holiday that falls on a weekday is published like any other day
 * and carries a Sunday's ridership, so counting it pulled every station's mean
 * down for as long as it stayed in the window. `date` is read as a UTC calendar
 * day, the way the file names are built.
 */
export function isOrdinaryWeekday(date: Date): boolean {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isFestivo(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}
