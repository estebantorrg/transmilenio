/**
 * The zonal schedules (`data/gtfs_zonal.json`, built by `sync_gtfs.ts`, spec
 * §5.5.10), read once and handed out per código — to `/api/horario-programado`
 * and to the prerender. ~2 MB on disk; parsed lazily, on the first page that
 * asks, so a box that serves none pays nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { SentidoHorario } from '../../../shared/horario_programado.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface HorarioProgramado {
  /** The GTFS build, "2026-09-29". */
  feed: string | null;
  /** The attribution line CC BY asks for. */
  credit: string;
  sentidos: SentidoHorario[];
}

interface GtfsZonalFile {
  _meta: { feed: string | null; credit: string };
  rutas: Record<string, SentidoHorario[]>;
}

let file: GtfsZonalFile | null | undefined;

function load(): GtfsZonalFile | null {
  if (file !== undefined) return file;
  try {
    file = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'data', 'gtfs_zonal.json'), 'utf-8')) as GtfsZonalFile;
  } catch {
    // No schedules is a smaller page, not a broken one.
    console.warn('[horario] gtfs_zonal.json unreadable; zonal pages go without scheduled frequencies.');
    file = null;
  }
  return file;
}

/** A zonal código's scheduled service, or null when the feed has none for it. */
export function horarioProgramado(codigo: string): HorarioProgramado | null {
  const data = load();
  // Own keys only: `constructor` is a property of every object, and it is not a route.
  const own = (key: string) => (data && Object.hasOwn(data.rutas, key) ? data.rutas[key] : undefined);
  const text = String(codigo ?? '').trim();
  const sentidos = own(text.toUpperCase()) ?? own(text);
  return data && sentidos ? { feed: data._meta.feed, credit: data._meta.credit, sentidos } : null;
}
