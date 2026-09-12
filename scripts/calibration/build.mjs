/**
 * Builds `server/src/data/planner_calibration.json` — the measured inputs the
 * journey planner's zonal cost model is calibrated against (spec §5.6.5).
 *
 * Both inputs are TRANSMILENIO S.A.'s own operating data, delivered in answer to
 * a public-information request (Ley 1712 de 2014) in September 2026. They stay
 * local-only like every other third-party source file; only the aggregate below
 * is committed.
 *
 *   --parquet     velocidad comercial por tramo, agosto 2026 — one row per
 *                 date × hour × stretch between two consecutive paraderos,
 *                 measured from the zonal fleet's GPS, dwell included.
 *   --intervalos  INTERVALOS RUTAS URBANAS.xlsx — every scheduled dispatch of
 *                 the urban zonal routes, per day type (hábil/sábado/festivo).
 *   --festivos    the holidays inside the parquet's month (default: August 2026).
 *
 * Output, all of it small enough to ship to the phone:
 *
 *   speeds.pairs    from código → to código → base speed (km/h). The base is the
 *                   median over the daytime hours of that stretch.
 *   speeds.factor   one multiplier per day type × hour, shared by every stretch.
 *                   base × factor reproduces the measured hourly medians to a
 *                   9.3% median error (a single citywide speed: 25.9%), at a
 *                   fraction of the size of shipping every hour of every stretch.
 *   headways        catalog route código → median scheduled interval (minutes)
 *                   per day type × hour, 0 where nothing is dispatched.
 *
 *   cd scripts/calibration && npm install && node build.mjs
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SOURCE_DIR = path.join(ROOT, 'peticiones', 'Respuesta B');
const PARQUET = arg('parquet', path.join(SOURCE_DIR, 'vel_tramo_ago2026_UCE_r.parquet'));
const INTERVALOS = arg('intervalos', path.join(SOURCE_DIR, 'INTERVALOS RUTAS URBANAS.xlsx'));
// 7 Aug (Batalla de Boyacá) and 17 Aug (Asunción, moved to Monday) — the same
// dates `isFestivo` in client/src/services/schedule.ts returns for 2026.
const FESTIVOS = arg('festivos', '2026-08-07,2026-08-17').split(',').map((d) => d.trim()).filter(Boolean);
const CATALOG = path.join(ROOT, 'server', 'src', 'data', 'master_catalog.json');
const OUT = path.join(ROOT, 'server', 'src', 'data', 'planner_calibration.json');

const STOP_CODE = /^\d{3}[A-Z]\d{2}$/;
// A stretch needs this many rows over the month before its base speed is trusted.
const MIN_PAIR_ROWS = 30;
// Rows outside this band are GPS artefacts (the file carries 0.005 and 192 km/h).
const SPEED_BAND_KMH = [2, 80];
// An hour's factor needs this many stretches behind it; thinner hours (1–3 a.m.)
// borrow the nearest hour that has them.
const MIN_FACTOR_CELLS = 500;
const DAY_TYPES = ['H', 'S', 'F'];
const SHEET_DAY_TYPE = { HABIL: 'H', SABADO: 'S', FESTIVO: 'F' };

const sqlPath = (p) => p.replaceAll('\\', '/').replaceAll("'", "''");
const round = (value, step) => Math.round(value / step) * step;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ── Catalog: route códigos and the stop pairs its routes actually ride ─────────
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const catalogRoutes = (catalog.data ?? catalog).routes;
const catalogCodes = new Set(Object.keys(catalogRoutes));

// ── Speeds ──────────────────────────────────────────────────────────────────
const con = await (await DuckDBInstance.create(':memory:')).connect();
const query = async (sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();
const source = `read_parquet('${sqlPath(PARQUET)}')`;

const [{ first, last }] = await query(`SELECT min(fecha)::VARCHAR AS first, max(fecha)::VARCHAR AS last FROM ${source}`);
if (first.slice(0, 7) !== last.slice(0, 7) || !FESTIVOS.every((d) => d.startsWith(first.slice(0, 7)))) {
  throw new Error(`parquet spans ${first} → ${last}; pass --festivos for that month explicitly`);
}

const festivoList = FESTIVOS.map((d) => `DATE '${d}'`).join(', ');
await con.run(`
  CREATE TABLE cell AS
  SELECT split_part(tramo_parada, ' - ', 1) AS a,
         split_part(tramo_parada, ' - ', 2) AS b,
         CASE WHEN fecha IN (${festivoList}) OR dayofweek(fecha) = 0 THEN 'F'
              WHEN dayofweek(fecha) = 6 THEN 'S' ELSE 'H' END AS dt,
         cat_hora AS h,
         median(avg_vel_kmh_calc_v2) AS v,
         count(*) AS n
  FROM ${source}
  WHERE avg_vel_kmh_calc_v2 BETWEEN ${SPEED_BAND_KMH[0]} AND ${SPEED_BAND_KMH[1]}
  GROUP BY ALL`);
await con.run(`DELETE FROM cell WHERE NOT (regexp_full_match(a, '\\d{3}[A-Z]\\d{2}') AND regexp_full_match(b, '\\d{3}[A-Z]\\d{2}'))`);
await con.run(`
  CREATE TABLE base AS
  SELECT a, b, median(v) AS base, sum(n) AS n FROM cell WHERE h BETWEEN 5 AND 22
  GROUP BY ALL HAVING sum(n) >= ${MIN_PAIR_ROWS}`);

const factorRows = await query(`
  SELECT dt, h, median(cell.v / base.base) AS f, count(*) AS cells
  FROM cell JOIN base USING (a, b) WHERE cell.n >= 3 GROUP BY ALL`);
const factor = {};
for (const dt of DAY_TYPES) {
  const byHour = new Map(factorRows.filter((r) => r.dt === dt && r.cells >= MIN_FACTOR_CELLS).map((r) => [Number(r.h), r.f]));
  factor[dt] = Array.from({ length: 24 }, (_, h) => {
    for (let d = 0; d < 24; d++) {
      const near = byHour.get((h + d) % 24) ?? byHour.get((h - d + 24) % 24);
      if (near !== undefined) return round(near, 0.001);
    }
    return 1;
  });
}

const pairs = {};
let pairCount = 0;
for (const { a, b, base } of await query(`SELECT a, b, base FROM base ORDER BY a, b`)) {
  (pairs[a] ??= {})[b] = round(base, 0.1);
  pairCount++;
}

// ── Headways ────────────────────────────────────────────────────────────────
// Instante and Intervalo are Excel day fractions. The median interval of the
// dispatches leaving within an hour is that hour's headway; an hour whose only
// dispatch is the first of the day has no interval of its own and borrows the
// next hour's.
const minutesOf = (value) => {
  if (typeof value === 'number') return value * 1440;
  const m = String(value).match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3] ?? 0) / 60 : NaN;
};

const workbook = XLSX.readFile(INTERVALOS);
const perRoute = new Map(); // INTERVALOS code → { dispatches, H/S/F: hour → { count, intervals[] } }
for (const [sheet, dt] of Object.entries(SHEET_DAY_TYPE)) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, raw: true, defval: '' });
  const header = rows[0].map((c) => String(c).toLowerCase());
  const col = (name) => header.findIndex((c) => c.includes(name));
  const [codeCol, atCol, gapCol] = [col('ruta'), col('instante'), col('intervalo')];
  if (codeCol < 0 || atCol < 0 || gapCol < 0) throw new Error(`${sheet}: unexpected header ${rows[0].join(' | ')}`);
  for (const row of rows.slice(1)) {
    const code = String(row[codeCol]).trim();
    const at = minutesOf(row[atCol]);
    if (!code || !Number.isFinite(at)) continue;
    const route = perRoute.get(code) ?? { dispatches: 0, H: new Map(), S: new Map(), F: new Map() };
    perRoute.set(code, route);
    route.dispatches++;
    const hour = Math.floor(at / 60) % 24;
    const slot = route[dt].get(hour) ?? { count: 0, intervals: [] };
    route[dt].set(hour, slot);
    slot.count++;
    const gap = row[gapCol] === '' ? NaN : minutesOf(row[gapCol]);
    if (gap > 0 && gap <= 180) slot.intervals.push(gap);
  }
}

// INTERVALOS names a two-way service by both zone letters ("KA302" = K302 and
// A302). A código already in the catalog stands as it is (SE10, TC30, 19-2).
const catalogCodesFor = (code) => {
  if (catalogCodes.has(code)) return [code];
  const m = code.match(/^([A-Z])([A-Z])(\d+[A-Z]?)$/);
  return m ? [m[1] + m[3], m[2] + m[3]].filter((c) => catalogCodes.has(c)) : [];
};

const headways = {};
const owner = new Map();
let unmatched = 0;
let conflicts = 0;
for (const [code, route] of perRoute) {
  const table = {};
  for (const dt of DAY_TYPES) {
    const hours = route[dt];
    table[dt] = Array.from({ length: 24 }, (_, h) => {
      const slot = hours.get(h);
      if (!slot) return 0;
      if (slot.intervals.length) return round(median(slot.intervals), 0.5);
      const next = hours.get((h + 1) % 24);
      return next?.intervals.length ? round(median(next.intervals), 0.5) : 0;
    });
  }
  const targets = catalogCodesFor(code);
  if (targets.length === 0) unmatched++;
  for (const target of targets) {
    const prior = owner.get(target);
    if (prior) {
      conflicts++;
      if (perRoute.get(prior).dispatches >= route.dispatches) continue;
    }
    owner.set(target, code);
    headways[target] = table;
  }
}

// ── Coverage report ───────────────────────────────────────────────────────────
const coverage = {};
for (const variants of Object.values(catalogRoutes)) {
  for (const variant of variants) {
    const type = variant.tipoServicio || '?';
    const stops = [...(variant.stops ?? [])].sort((x, y) => x.posicion - y.posicion);
    const c = (coverage[type] ??= { edges: 0, measured: 0, variants: 0, headway: 0 });
    c.variants++;
    if (headways[variant.codigo]) c.headway++;
    for (let i = 0; i < stops.length - 1; i++) {
      c.edges++;
      if (pairs[stops[i].codigo]?.[stops[i + 1].codigo] !== undefined) c.measured++;
    }
  }
}

const output = {
  version: 1,
  source:
    'TRANSMILENIO S.A., respuesta a solicitud de acceso a información pública (Ley 1712 de 2014), septiembre de 2026: ' +
    `velocidad comercial por tramo ${first} a ${last} y programación de despachos INTERVALOS RUTAS URBANAS.`,
  speeds: { factor, pairs },
  headways,
};
writeFileSync(OUT, JSON.stringify(output) + '\n');

console.log(`period ${first} → ${last} · festivos ${FESTIVOS.join(', ')}`);
console.log(`stretches with a base speed: ${pairCount}`);
console.log(`headways: ${perRoute.size} INTERVALOS routes → ${Object.keys(headways).length} catalog códigos (${unmatched} unmatched, ${conflicts} conflicts)`);
console.log('factor H:', factor.H.join(' '));
console.table(Object.fromEntries(Object.entries(coverage).map(([type, c]) => [type, {
  variants: c.variants,
  'with headway': c.headway,
  edges: c.edges,
  'measured %': +(100 * c.measured / Math.max(1, c.edges)).toFixed(1),
}])));
console.log(`wrote ${path.relative(ROOT, OUT)} (${(JSON.stringify(output).length / 1024).toFixed(0)} KB)`);
