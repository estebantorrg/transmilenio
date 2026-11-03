// Cuts each rutero table out of its piece, so the review page can show the
// artwork beside what was read from it.
//
//   node ruteros_recortes.mjs            # pieces of the routes still to review
//   node ruteros_recortes.mjs --todas    # every piece (for audits of the clean ones)
//   node ruteros_recortes.mjs --rutas A410,C160   # just these routes' pieces
//
// → _ruteros/recortes/<pieza>__<n>.png, n = the table's place in the piece's
//   `tablas` (ruteros.json): its tables first, then its digital strips — the
//   order ruteros.mjs writes them in. Local only, like the rest of _ruteros/:
//   TRANSMILENIO's artwork is looked at here, never published.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { ARTES, geometry, layout, recorteId } from './ruteros.mjs';

const OUT = join(import.meta.dirname, '_ruteros');
const DIR = join(OUT, 'recortes');
const SCALE = 3;
// The código tab stands above the outline's box; the strip's bar and line are two boxes.
const TAB = 26;

const todas = process.argv.includes('--todas');
// --rutas A410,C160: just those routes' pieces, clean or not (spot checks).
const rutas = process.argv[process.argv.indexOf('--rutas') + 1]?.split(',');
const porRuta = JSON.parse(readFileSync(join(OUT, 'por_ruta.json'), 'utf8'));
const elegidas = process.argv.includes('--rutas') ? rutas.map((c) => porRuta[c]).filter(Boolean) : Object.values(porRuta).filter((r) => todas || !r.limpia);
const archivos = [...new Set(elegidas.flatMap((r) => r.fuentes))];
// A second run with --reves works the list from the other end: two of them halve the wait.
if (process.argv.includes('--reves')) archivos.reverse();

const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
mkdirSync(DIR, { recursive: true });
let n = 0;
for (const archivo of archivos) {
  const task = lib.getDocument({ data: new Uint8Array(readFileSync(join(ARTES, archivo))), useSystemFonts: true, verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1);
    const lay = layout(await geometry(lib, page));
    const cajas = [
      ...lay.tables.map((t) => ({ ...t.box, y0: t.box.y0 - TAB })),
      ...lay.digitales.map((d) => ({ x0: d.bar.x0, y0: d.bar.y0, x1: d.bar.x1, y1: d.linea.y1 })),
    ];
    if (!cajas.length || cajas.every((_, i) => existsSync(join(DIR, recorteId(archivo, i))))) continue;
    // Only the band that holds the tables is drawn: the whole page at this scale is most of the time.
    const top = Math.max(0, Math.min(...cajas.map((b) => b.y0)) - 4);
    const bottom = Math.max(...cajas.map((b) => b.y1)) + 4;
    const vp = page.getViewport({ scale: SCALE });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil((bottom - top) * SCALE));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas, transform: [1, 0, 0, 1, 0, -top * SCALE] }).promise;
    for (const [i, b] of cajas.entries()) {
      const x = Math.max(0, Math.floor((b.x0 - 3) * SCALE));
      const y = Math.max(0, Math.floor((b.y0 - 3 - top) * SCALE));
      const w = Math.min(canvas.width - x, Math.ceil((b.x1 - b.x0 + 6) * SCALE));
      const h = Math.min(canvas.height - y, Math.ceil((b.y1 - b.y0 + 6) * SCALE));
      const out = createCanvas(w, h);
      out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
      writeFileSync(join(DIR, recorteId(archivo, i)), out.toBuffer('image/png'));
      n++;
    }
  } catch (err) {
    console.warn(`${archivo}: ${err?.message ?? err}`);
  } finally {
    await task.destroy();
  }
}
console.log(`${n} recortes de ${archivos.length} piezas → ${DIR}`);
