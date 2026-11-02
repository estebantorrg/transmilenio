// Reads page 2 of TRANSMILENIO's route artwork, "Listado de Paraderos", from the
// drawing alone: one block per sentido, one icon per stop.
//
//   node paraderos.mjs                  # every PDF under the artes folder
//   node paraderos.mjs --only "AF 410"  # just the files whose name contains these
//
// → _paraderos/lectura.json  every block as read, aligned with its catalog variant
// → _paraderos/revision.md   blocks and stops where the piece and the catalog differ
// → server/src/data/paraderos_plegable.json  the bahías printed on the pieces
//
// NO OCR, ON PURPOSE. The catalog already has what the text says: every paradero's
// name and `direccion`, and the módulo inside its código (603A08 → A). What only
// the drawing has is the icon: which bahías a paradero has (the lettered squares
// of the grid) and which one this route uses (the outlined square). So the icons
// are read, and aligned with the catalog's stop order by módulo letter. The order
// check needs nothing else, and an alignment that does not hold publishes nothing.
//
// The icons, whose size varies by piece (a piece with few stops draws them larger):
//   • paradero simple: a disc with a bus in it;
//   • paradero múltiple: yellow squares in a grid two wide, A B over C D over E F.
//     A square with no letter drawn in it is no bahía. The route's own bahía has an
//     outline around its square. Grid position gives the letter, so it is not read.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerCodigoParadero, leerCodigoZonal } from '../../shared/nomenclatura.js';
import { geometry } from './ruteros.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTES = join(HERE, '..', '..', 'peticiones', 'Respuesta A', '09-2026_Artesfinales TransMiZonales');
const OUT = join(HERE, '_paraderos');
const DATA = join(HERE, '..', '..', 'server', 'src', 'data');
/** Share of a block's stops that must agree with its catalog variant to trust it. */
const MIN_ACUERDO = 0.9;

/** Path length of the bus glyph in a paradero-simple icon; letters run under 130. */
const BUS_PATH = [260, 290];

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
const isDark = (hex) => rgb(hex).every((c) => c < 80);
const isWhite = (hex) => rgb(hex).every((c) => c > 240);
const isModuleYellow = (hex) => { const [r, g, b] = rgb(hex); return r > 230 && g > 170 && g < 225 && b < 110; };

/**
 * One block per coloured header, its stops in reading order: down each column,
 * columns left to right.
 *
 * @returns {Array<{ color: string, paradas: Array<{ tipo: 'simple' | 'multiple', modulos?: string[], modulo?: string | null }> }>}
 */
export function leerPagina({ W, H, fills }) {
  const k = W / 612;
  const barras = fills
    .filter((f) => f.rect && !isDark(f.fill) && !isWhite(f.fill) && f.w > 300 * k && f.h >= 15 * k && f.h <= 32 * k)
    .sort((a, b) => a.y0 - b.y0);
  return barras.map((barra, i) => {
    const y0 = barra.y1;
    const y1 = barras[i + 1]?.y0 ?? H;
    const dentro = fills.filter((f) => f.y0 >= y0 && f.y1 <= y1);

    const cuadros = dentro.filter((f) => f.rect && isModuleYellow(f.fill) && f.w >= 3.5 * k && f.w <= 12 * k && near(f.w, f.h, 0.8));
    const grupos = [];
    for (const c of [...cuadros].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
      const g = grupos.find((x) => x.some((o) => near(o.x0, c.x0, 1.6 * c.w) && near(o.y0, c.y0, 1.6 * c.w)));
      if (g) g.push(c); else grupos.push([c]);
    }
    const multiples = grupos.filter((grupo) => grupo.length > 1).map((grupo) => {
      const x0 = Math.min(...grupo.map((c) => c.x0));
      const y0g = Math.min(...grupo.map((c) => c.y0));
      // One square's size is the grid's step: a piece with few stops draws them larger.
      const paso = Math.min(...grupo.map((c) => c.w)) + 0.5 * k;
      const letra = (c) => 'ABCDEF'[Math.round((c.y0 - y0g) / paso) * 2 + Math.round((c.x0 - x0) / paso)];
      // By the glyph's centre: on some pieces a letter overshoots its square.
      const dentroDe = (c, f) => near((f.x0 + f.x1) / 2, (c.x0 + c.x1) / 2, c.w / 2) && near((f.y0 + f.y1) / 2, (c.y0 + c.y1) / 2, c.h / 2);
      const conLetra = grupo.filter((c) => dentro.some((f) => isDark(f.fill) && !f.rect && dentroDe(c, f)));
      // The outline is a ring a little larger than its square, in the zone's colour.
      const elegido = grupo.find((c) => dentro.some((f) => !f.rect && !isDark(f.fill) && !isModuleYellow(f.fill) && !isWhite(f.fill)
        && f.w > c.w * 0.95 && f.w < c.w * 1.6 && near(f.h, f.w, 0.6) && f.x0 <= c.x0 + 0.2 && f.x1 >= c.x1 - 0.2 && f.y0 <= c.y0 + 0.2 && f.y1 >= c.y1 - 0.2));
      return {
        x: x0, y: y0g,
        parada: { tipo: 'multiple', modulos: conLetra.map(letra).filter(Boolean).sort(), modulo: elegido ? letra(elegido) : null },
      };
    });

    // The bus itself, by its outline's length: the one thing that holds across
    // templates. Its disc is a stroke on some pieces and runs from 8 to 16pt.
    const buses = dentro.filter((f) => !f.rect && isDark(f.fill) && f.n >= BUS_PATH[0] && f.n <= BUS_PATH[1]);
    const simples = buses.map((f) => ({ x: f.x0, y: f.y0, parada: { tipo: 'simple' } }));

    const iconos = [...multiples, ...simples].sort((a, b) => a.x - b.x);
    const columnas = [];
    for (const ic of iconos) {
      const col = columnas[columnas.length - 1];
      if (col && ic.x - col[0].x < 30 * k) col.push(ic); else columnas.push([ic]);
    }
    return { color: barra.fill, paradas: columnas.flatMap((col) => col.sort((a, b) => a.y - b.y).map((ic) => ic.parada)) };
    // Some pieces paint a header bar twice, and the gap between the two holds nothing.
  }).filter((bloque) => bloque.paradas.length > 0);
}

/**
 * Global alignment of a block's stops with a catalog variant's. A simple stop
 * agrees with a módulo-A código, a múltiple with the módulo it outlines (or any,
 * if none is outlined); a stop that is no paradero (an estación's TM código) has
 * no módulo to contradict.
 */
export function alinear(paradas, stops) {
  const letra = (s) => leerCodigoParadero(s.codigo)?.modulo ?? null;
  const acuerda = (p, s) => {
    const m = letra(s);
    if (m === null) return true;
    if (p.tipo === 'simple') return m === 'A';
    return p.modulo ? p.modulo === m : p.modulos.includes(m);
  };
  const n = paradas.length, m = stops.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) dp[i][0] = -i;
  for (let j = 1; j <= m; j++) dp[0][j] = -j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    dp[i][j] = Math.max(dp[i - 1][j - 1] + (acuerda(paradas[i - 1], stops[j - 1]) ? 2 : -2), dp[i - 1][j] - 1, dp[i][j - 1] - 1);
  }
  const pares = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (acuerda(paradas[i - 1], stops[j - 1]) ? 2 : -2)) { pares.unshift({ i: i - 1, j: j - 1, ok: acuerda(paradas[i - 1], stops[j - 1]) }); i--; j--; }
    else if (i > 0 && dp[i][j] === dp[i - 1][j] - 1) { pares.unshift({ i: i - 1, j: null, ok: false }); i--; }
    else { pares.unshift({ i: null, j: j - 1, ok: false }); j--; }
  }
  return { pares, acuerdo: pares.filter((p) => p.ok).length / Math.max(1, pares.length) };
}

/** `Plegable_WEB_AH 605` → A605, H605, AH605; `Volante_WEB_1-1` → 1-1. */
function codigosDeArchivo(name) {
  const m = name.replace(/\.pdf$/i, '').match(/^(?:Plegable|Volantes?)[_ ]*(?:WEB[_ ]*)?(.+)$/i);
  const raw = (m ? m[1] : name).replace(/\s+/g, '').toUpperCase();
  return [...new Set([raw, ...(leerCodigoZonal(raw) ?? []).map((s) => s.codigo)])];
}

async function main() {
  const args = process.argv.slice(2);
  const onlyAt = args.indexOf('--only');
  const only = onlyAt > -1 ? args.slice(onlyAt + 1).filter((a) => !a.startsWith('--')) : [];

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^(Plegable|Volante)/i.test(name) && name.toLowerCase().endsWith('.pdf')) files.push(p);
    }
  };
  walk(ARTES);
  const chosen = only.length ? files.filter((f) => only.some((o) => basename(f).includes(o))) : files;

  const catalog = JSON.parse(readFileSync(join(DATA, 'master_catalog.json'), 'utf8'));
  const routes = Object.fromEntries(Object.entries(catalog.routes).map(([c, v]) => [c.toUpperCase(), v]));

  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const lectura = [];
  let sinPagina2 = 0;
  for (const file of chosen) {
    const task = lib.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true, verbosity: 0 });
    const doc = await task.promise;
    if (doc.numPages < 2) { sinPagina2++; await task.destroy(); continue; }
    const bloques = leerPagina(await geometry(lib, await doc.getPage(2)));
    await task.destroy();
    const variantes = codigosDeArchivo(basename(file)).flatMap((c) => (routes[c] ?? []).map((v) => ({ codigo: c, v })));
    for (const b of bloques) {
      // The variant the block agrees with best; the plain one on a tie, because
      // a piece prints the ordinary service and "… Ciclovía" is the Sunday detour.
      const opciones = variantes
        .map(({ codigo, v }) => ({ codigo, nombre: v.nombre.trim(), stops: v.stops ?? [], ...alinear(b.paradas, v.stops ?? []) }))
        .sort((x, y) => y.acuerdo - x.acuerdo || Number(/ciclov/i.test(x.nombre)) - Number(/ciclov/i.test(y.nombre)));
      const mejor = opciones[0] ?? null;
      lectura.push({
        archivo: relative(ARTES, file).replace(/\\/g, '/'),
        color: b.color,
        paradas: b.paradas,
        variante: mejor ? { codigo: mejor.codigo, nombre: mejor.nombre, acuerdo: Number(mejor.acuerdo.toFixed(3)) } : null,
        pares: mejor ? mejor.pares.map((p) => ({ arte: p.i, stop: p.j === null ? null : mejor.stops[p.j].codigo, nombre: p.j === null ? null : mejor.stops[p.j].nombre, ok: p.ok })) : [],
      });
    }
  }

  // ─── Bahías ───
  // Printed bahías of each paradero, only from blocks whose alignment holds and
  // only from stops that agree — a stop in a block that drifted says nothing.
  const bahias = {};
  // Stops whose printed módulo contradicts the one in their código, or may. Neither
  // is known to be right, so the site names no módulo there.
  const dudas = new Set();
  for (const b of lectura) {
    if (!b.variante || b.variante.acuerdo < MIN_ACUERDO) continue;
    for (const [i, p] of b.pares.entries()) {
      if (p.arte === null || !p.stop) continue;
      // One stop short on one side shifts the pairs next to it onto the wrong
      // icon, where a simple icon happily agrees with a módulo-A código (A410's
      // Br. Saucedal: printed B, código A). So a disagreement taints its neighbours.
      if (!p.ok || b.pares[i - 1]?.ok === false || b.pares[i + 1]?.ok === false) { dudas.add(p.stop); continue; }
      const a = b.paradas[p.arte];
      const c = leerCodigoParadero(p.stop);
      if (a.tipo !== 'multiple' || !c || !a.modulos.length) continue;
      const key = `${String(c.paradero).padStart(3, '0')}-${String(c.zona).padStart(2, '0')}`;
      bahias[key] = [...new Set([...(bahias[key] ?? []), ...a.modulos])].sort();
    }
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'lectura.json'), JSON.stringify(lectura, null, 1));

  // ─── Report ───
  const sinVariante = lectura.filter((b) => !b.variante);
  const dudosos = lectura.filter((b) => b.variante && b.variante.acuerdo < MIN_ACUERDO).sort((a, b) => a.variante.acuerdo - b.variante.acuerdo);
  const firmes = lectura.filter((b) => b.variante && b.variante.acuerdo >= MIN_ACUERDO);
  const paradasFirmes = firmes.flatMap((b) => b.pares);
  const md = [
    '# Listado de Paraderos: lo impreso contra el catálogo',
    '',
    `Piezas: ${chosen.length} | sin página 2: ${sinPagina2} | bloques: ${lectura.length}`,
    `Alineados (≥ ${MIN_ACUERDO * 100} %): ${firmes.length} | dudosos: ${dudosos.length} | sin variante en el catálogo: ${sinVariante.length}`,
    `Paraderos con bahías impresas: ${Object.keys(bahias).length}`,
    '',
    '## Diferencias en bloques alineados',
    'Paradas de más o de menos, o módulo distinto. Solo se informan; nada se corrige solo.',
    '',
    ...firmes.filter((b) => b.pares.some((p) => !p.ok)).map((b) => {
      const dif = b.pares.filter((p) => !p.ok).map((p) => (p.arte === null
        ? `solo catálogo ${p.stop} ${p.nombre}`
        : p.stop === null
          ? `solo pieza #${p.arte + 1}`
          : `#${p.arte + 1} pieza ${b.paradas[p.arte].modulo ?? 'simple'} ≠ ${p.stop} ${p.nombre}`));
      return `- **${b.variante.codigo} ${b.variante.nombre}** (${(b.variante.acuerdo * 100).toFixed(0)} %, \`${basename(b.archivo)}\`): ${dif.join('; ')}`;
    }),
    '',
    '## Bloques dudosos (no publican nada)',
    '',
    ...dudosos.map((b) => `- ${b.variante.codigo} ${b.variante.nombre}: ${(b.variante.acuerdo * 100).toFixed(0)} %, pieza ${b.paradas.length} paradas, \`${b.archivo}\``),
    '',
    '## Sin variante en el catálogo',
    '',
    ...sinVariante.map((b) => `- \`${b.archivo}\`: ${b.paradas.length} paradas`),
    '',
  ];
  writeFileSync(join(OUT, 'revision.md'), md.join('\n'));
  if (!only.length) writeFileSync(join(DATA, 'paraderos_plegable.json'), `${JSON.stringify({ bahias, dudas: [...dudas].sort() })}\n`);

  console.log(md.slice(2, 5).join('\n'));
  console.log(`stops firmes: ${paradasFirmes.length}, de acuerdo ${paradasFirmes.filter((p) => p.ok).length}`);
  console.log(`→ ${join(OUT, 'revision.md')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) await main();
