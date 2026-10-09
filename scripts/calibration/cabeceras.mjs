/**
 * Builds `server/src/data/horarios_cabecera.json` — the first and last
 * scheduled departure of each urban zonal route **from its own cabecera**, per
 * day type (spec §5.5.5).
 *
 * Source: "HORARIOS OPERACION RUTAS URBANAS", TRANSMILENIO S.A.'s own schedule,
 * delivered in answer to radicado 2026-ER-53567 (October 2026). It stays
 * local-only like the other source files; only the table below is committed.
 *
 * Why it is worth a file of its own: the catalog carries one window per código,
 * and for a route with a cabecera at each end that window is often the other
 * end's. C149 (to Bilbao) reads "4:00 a.m." in the catalog; the schedule says
 * the first bus leaves Est. Av. 1 de Mayo at 5:38 — 4:00 is when the first one
 * leaves Bilbao, an hour and a half away. Of the weekday rows that match a
 * catalog sentido, about a quarter differ from the catalog's window.
 *
 * A row is filed under a catalog sentido only when its cabecera IS that
 * sentido's first stop: `KA302` is two públicos, K302 and A302, and which row
 * belongs to which is read off the stop the row names, never assumed from the
 * letters. A row whose cabecera opens no sentido of its códigos is reported and
 * left out — a schedule on the wrong direction is worse than none (§1).
 *
 *   cd scripts/calibration && npm install && node cabeceras.mjs
 *
 * Output: código → cabecera (cenefa) → { n: name, t: 'C' | 'D', H?, S?, F? },
 * each day type a list of [start, end] minutes from midnight; `end` runs past
 * 1440 when the last bus leaves after midnight. A day type that is absent means
 * the schedule lists no service from that cabecera on that kind of day.
 *
 * `circulares`: código → { c: cabecera, n: its name, d: day types it runs }.
 * A circular route has ONE cabecera, so only the sentido that starts there has
 * an entry above; the other código of the same loop (F410 beside A410) starts
 * mid-route and gets none. That it is circular, and which days it runs, is true
 * of the loop whichever código the rider reads it under, so those two facts —
 * and only those, never the hours — are filed under every código of the loop.
 */

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

const HORARIOS = arg('horarios', path.join(ROOT, 'peticiones', 'Respuesta IDK', 'HORARIOS OPERACION RUTAS URBANAS 2026-ER-53567.xlsx'));
const CATALOG = path.join(ROOT, 'server', 'src', 'data', 'master_catalog.json');
const OUT = path.join(ROOT, 'server', 'src', 'data', 'horarios_cabecera.json');

const HOJAS = { HABIL: 'H', SABADO: 'S', FESTIVO: 'F' };
const MINUTES_PER_DAY = 1440;

/**
 * TRANSMILENIO's planning código → the público(s) it covers. `KA302` is origin
 * letter + destination letter + number: K302 one way, A302 the other. `HH710`
 * is H710 both ways; `18--11` is the alimentador `18-11`; `SE10`/`TC14` and the
 * numeric ones are already públicos.
 */
function publicos(rutaComercial) {
  const codigo = String(rutaComercial ?? '').trim().toUpperCase().replace('--', '-');
  const partido = /^([A-Z])([A-Z])(\d+[A-Z]?)$/.exec(codigo);
  if (!partido) return [codigo];
  return [...new Set([partido[2] + partido[3], partido[1] + partido[3]])];
}

/** A cell → minutes from midnight: an Excel day fraction, or "24:30:00". */
function minutos(valor) {
  if (typeof valor === 'number') return Math.round(valor * MINUTES_PER_DAY);
  const m = /^(\d{1,2}):(\d{2})/.exec(String(valor ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The windows a row describes. Usually one start and one end; a route that runs
 * two shifts writes both columns as ranges — "06:00:00 - 15:00:00" beside
 * "10:30:00 - 18:00:00" is 6:00–10:30 and 15:00–18:00.
 */
function ventanas(inicio, fin) {
  const partes = (v) => (typeof v === 'string' && v.includes(' - ') ? v.split(' - ') : [v]).map(minutos);
  const ini = partes(inicio);
  const end = partes(fin);
  if (ini.length !== end.length || [...ini, ...end].some((x) => x === null)) return null;
  return ini.map((start, i) => [start, end[i] < start ? end[i] + MINUTES_PER_DAY : end[i]]);
}

const catalogo = JSON.parse(readFileSync(CATALOG, 'utf8'));
const routes = (catalogo.data ?? catalogo).routes ?? {};
const libro = XLSX.readFile(HORARIOS);

const rutas = {};
const circulares = {};
const fuera = [];
let filas = 0;
for (const [hoja, tipo] of Object.entries(HOJAS)) {
  const sheet = libro.Sheets[hoja];
  if (!sheet) throw new Error(`${HORARIOS}: no sheet "${hoja}"`);
  for (const fila of XLSX.utils.sheet_to_json(sheet, { defval: '' })) {
    filas++;
    const cabecera = String(fila['Parada'] ?? '').trim().toUpperCase();
    const codigos = publicos(fila['Ruta comercial']);
    const sentidos = codigos.filter((codigo) =>
      (routes[codigo] ?? []).some((v) => String(v.stops?.[0]?.codigo ?? '').toUpperCase() === cabecera));
    const horas = ventanas(fila['Hora Inicio'], fila['Hora Fin']);
    if (sentidos.length !== 1 || !horas) {
      fuera.push(`${hoja} ${fila['Ruta comercial']} @ ${cabecera} (${fila['Nombre de parada']}): ${!horas ? 'horas ilegibles' : sentidos.length ? 'cabecera de varios códigos' : 'no abre ningún sentido del catálogo'}`);
      continue;
    }
    const entrada = ((rutas[sentidos[0]] ??= {})[cabecera] ??= { n: String(fila['Nombre de parada']).trim() });
    // The festivo sheet mislabels a few rows' topología ("Festivo "); the other
    // sheets carry the real one, so only a recognised value is kept.
    const topologia = /circular/i.test(fila['Topologia']) ? 'C' : /doble/i.test(fila['Topologia']) ? 'D' : null;
    if (topologia) entrada.t = topologia;
    entrada[tipo] = [...(entrada[tipo] ?? []), ...horas].sort((a, b) => a[0] - b[0]);
    if (topologia === 'C') {
      for (const codigo of codigos) {
        if (routes[codigo]) circulares[codigo] ??= { c: cabecera, n: entrada.n, de: sentidos[0], d: [] };
      }
    }
  }
}
// The days a loop runs are the days its cabecera has windows — read off the
// finished entry, so a festivo row whose topología is mislabelled still counts.
for (const lazo of Object.values(circulares)) {
  const entrada = rutas[lazo.de][lazo.c];
  lazo.d = Object.values(HOJAS).filter((tipo) => entrada[tipo]);
  delete lazo.de;
}

const ordenado = Object.fromEntries(Object.keys(rutas).sort().map((codigo) => [codigo, rutas[codigo]]));
writeFileSync(OUT, JSON.stringify({
  fuente: 'HORARIOS OPERACION RUTAS URBANAS, TRANSMILENIO S.A. (respuesta al radicado 2026-ER-53567, octubre de 2026), leído por scripts/calibration/cabeceras.mjs',
  rutas: ordenado,
  circulares: Object.fromEntries(Object.keys(circulares).sort().map((codigo) => [codigo, circulares[codigo]])),
}) + '\n');

const cabeceras = Object.values(ordenado).reduce((n, r) => n + Object.keys(r).length, 0);
console.log(`filas: ${filas} | códigos: ${Object.keys(ordenado).length} | cabeceras: ${cabeceras} | circulares: ${Object.keys(circulares).length} | fuera: ${fuera.length}`);
console.log(`→ ${OUT}`);
if (fuera.length) console.log('\nFilas que no se archivaron:\n  ' + fuera.join('\n  '));
