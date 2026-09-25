/**
 * The rutero tradicional — the printed table on the paradero's plegable and on
 * the side of the zonal bus: código and destino over a column of corredores
 * (yellow chips, the main one dark) each beside the barrio or hito it passes.
 *
 * The data is `server/src/data/ruteros_tradicionales.json`, read off the final
 * artwork TRANSMILENIO handed over for radicado 2026-ER-47262 by
 * `scripts/ocr/ruteros.mjs`. Only the facts are published — the drawing here is
 * ours, not a copy of the piece.
 *
 * **Consecutive rows on the same corredor are one cell.** The artwork prints
 * `AV. 1° DE MAYO` once, a single chip standing beside TIMIZA and OLAYA; the
 * data keeps one row per hito, so runs of the same corredor (and the same
 * chip colour) collapse into one `rowspan` here. Only runs: a corredor the
 * route leaves and comes back to is printed again, and so is it here.
 *
 * Plain ESM, like `rutero.js`, so the Vite client and the tsx-run prerender
 * share one copy; types are in `tabla_rutero.d.ts`.
 */

/** @param {unknown} value */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Folded for comparison: no accents, no punctuation, single spaces. */
function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * Rows grouped into runs: consecutive rows with the same corredor and the same
 * chip colour share one cell. A row without a corredor never joins a run.
 *
 * @param {ReadonlyArray<readonly [string | null, 0 | 1 | number, string]>} filas
 * @returns {{ corredor: string | null, destacado: boolean, hitos: string[] }[]}
 */
export function agruparFilas(filas) {
  /** @type {{ corredor: string | null, destacado: boolean, hitos: string[] }[]} */
  const runs = [];
  for (const [corredor, destacado, hito] of filas) {
    const prev = runs.at(-1);
    if (corredor && prev && prev.corredor === corredor && prev.destacado === Boolean(destacado)) {
      prev.hitos.push(hito);
    } else {
      runs.push({ corredor: corredor || null, destacado: Boolean(destacado), hitos: [hito] });
    }
  }
  return runs;
}

/**
 * The sentidos of `ruta` headed for `destino` (the catalog's destination for
 * the route on screen). Matched on the folded name, or one name containing the
 * other (`BOSA SAN JOSÉ CICLOVÍA` for `Bosa San José`). Nothing is guessed: no
 * match is an empty list.
 *
 * @param {{ sentidos: ReadonlyArray<{ destino: string }> } | null | undefined} ruta
 * @param {unknown} destino
 */
export function sentidosHacia(ruta, destino) {
  const want = fold(destino);
  if (!ruta || !want) return [];
  const exact = ruta.sentidos.filter((s) => fold(s.destino) === want);
  if (exact.length) return exact;
  const padded = (s) => ` ${s} `;
  const contained = ruta.sentidos.filter((s) => {
    const got = fold(s.destino);
    return got && (padded(got).includes(padded(want)) || padded(want).includes(padded(got)));
  });
  if (contained.length) return contained;
  // Last, spelling: the catalog and the print disagree on articles, spaces and
  // a letter or two (`Sabana de Dorado` / `SABANA DEL DORADO`, `Bellaflor`,
  // `Barancas Norte`, `Fontibon San Pablo` / `FONTIBÓN S. PABLO`). Compared
  // without articles or spaces, within ~15% of the length — `CALLE 197` is
  // still not `CALLE 222` — and only a single closest sentido counts.
  const key = (v) => fold(v).split(' ').filter((w) => !STOPWORDS.has(w)).join('');
  const wantKey = key(destino);
  const scored = ruta.sentidos
    .map((s) => ({ s, d: distance(wantKey, key(s.destino)) }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (!best || best.d > Math.max(1, Math.floor(wantKey.length * 0.15))) return [];
  return scored.filter((x) => x.d === best.d && key(x.s.destino) === key(best.s.destino)).map((x) => x.s);
}

const STOPWORDS = new Set(['DE', 'DEL', 'EL', 'LA', 'LOS', 'LAS', 'Y']);

/** Levenshtein distance. */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Black or white, whichever reads on `hex`. */
function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Contrast against white vs against near-black (#1b1b1b ≈ 0.011).
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.061) ? '#fff' : '#1b1b1b';
}

/** A size step from the length of a line, so short text fills its cell the way the print does. */
function talla(text, pasos) {
  const n = String(text).length;
  return pasos.findIndex((max) => n <= max) + 1 || pasos.length + 1;
}

/**
 * A corredor as the chip prints it: short ones on one line, big (`KR 15`); a
 * named avenue as `AV.` over its name when the name is long (`AV.` /
 * `ESPERANZA`), since the chip is narrow and the name is what is read.
 */
function corredorHtml(corredor) {
  // Past nine characters the chip can't hold one line at a readable size, so it
  // breaks after `AV.` or at the first space (`AUTO` / `NORTE`), as the print does.
  const m = corredor.length > 9 ? /^(AV\.)\s*(.+)$|^(\S+)\s+(.+)$/.exec(corredor) : null;
  if (m) {
    const [first, rest] = m[1] ? [m[1], m[2]] : [m[3], m[4]];
    return `<span class="tr-chip-texto tr-t${talla(rest, [7, 9, 11])} tr-dos-lineas">${esc(first)}<br>${esc(rest)}</span>`;
  }
  return `<span class="tr-chip-texto tr-t${talla(corredor, [5, 7, 9, 11])}">${esc(corredor)}</span>`;
}

/**
 * One sentido, drawn the way the paradero's piece draws it.
 *
 * `tabla`: a trapezoid tab with the código on the zone colour, the destino in
 * a band of the same colour, then one row per hito — the corredor's chip
 * filling its cell (yellow; dark for the main corredor) beside the hito on a
 * tint of the zone colour. `digital`: the layout of the routes with an
 * electronic sign — `código │ destino` in one bar over a dark strip reading
 * `Hito/CORREDOR - Hito/CORREDOR …`.
 *
 * @param {{
 *   codigo: string,
 *   color: string,
 *   formato?: 'tabla' | 'digital',
 *   sentido: { destino: string, operacion?: string, filas: ReadonlyArray<readonly [string | null, number, string]> },
 * }} options
 */
export function tablaRuteroHtml({ codigo, color, formato = 'tabla', sentido }) {
  const ink = inkOn(color);
  const style = `--tr-zona:${esc(color)};--tr-tinta:${ink}`;
  const label = `Rutero de la ruta ${codigo} hacia ${sentido.destino}`;
  const operacion = sentido.operacion ? `<p class="tr-operacion">Operación ${esc(sentido.operacion)}</p>` : '';

  if (formato === 'digital') {
    const pares = sentido.filas.map(([corredor, , hito]) => (
      `<span class="tr-par">${esc(hito)}${corredor ? `/<b>${esc(corredor)}</b>` : ''}</span>`
    )).join('<span class="tr-guion"> - </span>');
    return `<figure class="tabla-rutero tr-digital" style="${style}" aria-label="${esc(label)}">`
      + `<div class="tr-barra"><span class="tr-codigo">${esc(codigo)}</span><span class="tr-destino tr-t${talla(sentido.destino, [12, 18, 24])}">${esc(sentido.destino)}</span></div>`
      + `<p class="tr-franja">${pares}</p>${operacion}</figure>`;
  }

  const body = agruparFilas(sentido.filas).map((run) => run.hitos.map((hito, i) => {
    const corredor = i > 0 ? '' : run.corredor
      ? `<th scope="row" class="tr-corredor${run.destacado ? ' tr-destacado' : ''}"${run.hitos.length > 1 ? ` rowspan="${run.hitos.length}"` : ''}>${corredorHtml(run.corredor)}</th>`
      : '<td class="tr-corredor tr-sin-corredor"></td>';
    return `<tr>${corredor}<td class="tr-hito tr-t${talla(hito, [9, 12, 15, 19])}">${esc(hito)}</td></tr>`;
  }).join('')).join('');
  // The tab is a trapezoid with rounded shoulders; an SVG stretched to the box
  // draws it, its outline kept at one width by non-scaling-stroke.
  const pestana = '<svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">'
    + '<path d="M0 24.5 L12 3.2 Q13.8 0 17.4 0 L82.6 0 Q86.2 0 88 3.2 L100 24.5"/></svg>';
  return `<figure class="tabla-rutero" style="${style}" aria-label="${esc(label)}">`
    + `<div class="tr-pestana">${pestana}<span class="tr-codigo">${esc(codigo)}</span></div>`
    + `<div class="tr-cuerpo"><div class="tr-destino tr-t${talla(sentido.destino, [10, 13, 16, 20])}">${esc(sentido.destino)}</div>`
    + `<table aria-label="${esc(label)}"><tbody>${body}</tbody></table></div>${operacion}</figure>`;
}

/**
 * The table's stylesheet, one copy for both surfaces: the prerender inlines it
 * in its <style>, the client adds it once (`ensureTablaRuteroStyle`). Sized in
 * container units, so the whole piece scales as one drawing the way the print
 * does, from a phone column to the desktop page.
 *
 * Proportions are the artwork's (a plegable table is 162.7 pt wide = 100cqi):
 * tab and destino band 20cqi, rows 15cqi, chip column 30%. The face is a heavy
 * condensed sans — the system's own when it has one (Roboto Condensed on
 * Android, Bahnschrift on Windows, Avenir Next Condensed on Apple); nothing is
 * downloaded for it.
 */
export const TABLA_RUTERO_CSS = `
.tabla-rutero {
  --tr-tinta-oscura: #2c2e35;
  --tr-regla: max(1.5px, 0.8cqi);
  container-type: inline-size;
  width: min(100%, 400px);
  margin: 0;
  font-family: 'Roboto Condensed', 'Bahnschrift Condensed', 'Avenir Next Condensed', 'Arial Narrow', sans-serif-condensed, 'Bahnschrift', 'Inter', sans-serif;
  font-stretch: condensed;
  font-weight: 700;
  line-height: 1;
  color: var(--tr-tinta-oscura);
  text-transform: uppercase;
}
.tabla-rutero .tr-pestana {
  position: relative;
  width: 72cqi;
  height: 19cqi;
  margin: 0 auto calc(-1 * var(--tr-regla));
  display: grid;
  place-items: center;
}
.tabla-rutero .tr-pestana svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.tabla-rutero .tr-pestana path { fill: var(--tr-zona); stroke: var(--tr-tinta-oscura); stroke-width: 1.6px; vector-effect: non-scaling-stroke; }
.tabla-rutero .tr-codigo,
.tabla-rutero .tr-destino {
  color: #fff;
  -webkit-text-stroke: 0.09em var(--tr-tinta-oscura);
  paint-order: stroke fill;
  letter-spacing: 0.01em;
}
.tabla-rutero .tr-pestana .tr-codigo { position: relative; font-size: 17cqi; font-weight: 800; }
.tabla-rutero .tr-cuerpo {
  position: relative;
  border: var(--tr-regla) solid var(--tr-tinta-oscura);
  border-radius: 2.2cqi;
  overflow: hidden;
  background: var(--tr-tinta-oscura);
}
.tabla-rutero .tr-cuerpo > .tr-destino {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 19cqi;
  padding: 1.4cqi 2cqi;
  background: var(--tr-zona);
  font-weight: 800;
  text-align: center;
  line-height: 0.98;
}
.tabla-rutero .tr-destino.tr-t1 { font-size: 15cqi; }
.tabla-rutero .tr-destino.tr-t2 { font-size: 12cqi; }
.tabla-rutero .tr-destino.tr-t3 { font-size: 10cqi; }
.tabla-rutero .tr-destino.tr-t4 { font-size: 8.4cqi; }
.tabla-rutero .tr-destino.tr-t5 { font-size: 7cqi; }
.tabla-rutero table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
}
.tabla-rutero td,
.tabla-rutero th {
  height: 15cqi;
  padding: 0.8cqi 1.6cqi;
  border-top: var(--tr-regla) solid var(--tr-tinta-oscura);
  text-align: center;
  vertical-align: middle;
}
.tabla-rutero .tr-corredor {
  width: 30%;
  background: #ffeb3d;
  color: var(--tr-tinta-oscura);
  border-right: var(--tr-regla) solid var(--tr-tinta-oscura);
  font-weight: 800;
}
.tabla-rutero .tr-corredor.tr-destacado { background: var(--tr-tinta-oscura); color: #fff; }
.tabla-rutero .tr-corredor.tr-sin-corredor { background: #fff; }
.tabla-rutero .tr-chip-texto { display: block; white-space: nowrap; letter-spacing: -0.01em; }
.tabla-rutero .tr-chip-texto.tr-t1 { font-size: 11cqi; }
.tabla-rutero .tr-chip-texto.tr-t2 { font-size: 8.6cqi; }
.tabla-rutero .tr-chip-texto.tr-t3 { font-size: 6.8cqi; }
.tabla-rutero .tr-chip-texto.tr-t4 { font-size: 5.6cqi; }
.tabla-rutero .tr-chip-texto.tr-t5 { font-size: 4.8cqi; white-space: normal; }
.tabla-rutero .tr-dos-lineas { line-height: 0.98; }
.tabla-rutero .tr-dos-lineas.tr-t1 { font-size: 6.4cqi; }
.tabla-rutero .tr-dos-lineas.tr-t2 { font-size: 5.4cqi; }
.tabla-rutero .tr-dos-lineas.tr-t3 { font-size: 4.6cqi; }
.tabla-rutero .tr-dos-lineas.tr-t4 { font-size: 4cqi; white-space: normal; }
.tabla-rutero .tr-hito {
  background: #fff;
  background: color-mix(in srgb, var(--tr-zona) 13%, #fff);
  overflow-wrap: anywhere;
}
.tabla-rutero .tr-hito.tr-t1 { font-size: 11.5cqi; }
.tabla-rutero .tr-hito.tr-t2 { font-size: 9.2cqi; }
.tabla-rutero .tr-hito.tr-t3 { font-size: 7.6cqi; }
.tabla-rutero .tr-hito.tr-t4 { font-size: 6.2cqi; }
.tabla-rutero .tr-hito.tr-t5 { font-size: 5.6cqi; line-height: 1.05; }
.tabla-rutero .tr-operacion {
  margin: 1.6cqi 0 0;
  font-family: inherit;
  font-size: 4.4cqi;
  text-align: center;
  color: inherit;
  opacity: 0.8;
}
.tabla-rutero.tr-digital { width: min(100%, 640px); }
.tabla-rutero .tr-barra {
  display: flex;
  align-items: center;
  min-height: 9cqi;
  background: var(--tr-zona);
  border-radius: 0.8cqi 0.8cqi 0 0;
}
.tabla-rutero .tr-barra .tr-codigo {
  padding: 0 3cqi;
  font-size: 6.2cqi;
  font-weight: 800;
  border-right: max(1.5px, 0.35cqi) solid #fff;
  line-height: 6cqi;
}
.tabla-rutero .tr-barra .tr-destino { flex: 1; padding: 1cqi 2cqi; text-align: center; font-weight: 800; }
.tabla-rutero .tr-barra .tr-destino.tr-t1 { font-size: 6.4cqi; }
.tabla-rutero .tr-barra .tr-destino.tr-t2 { font-size: 5.2cqi; }
.tabla-rutero .tr-barra .tr-destino.tr-t3 { font-size: 4.4cqi; }
.tabla-rutero .tr-barra .tr-destino.tr-t4 { font-size: 3.8cqi; }
.tabla-rutero .tr-franja {
  margin: 0;
  padding: 1.4cqi 2.4cqi;
  background: #373a40;
  color: #fff;
  font-size: 3.4cqi;
  font-weight: 600;
  line-height: 1.35;
  text-align: center;
  text-transform: none;
  border-radius: 0 0 0.8cqi 0.8cqi;
}
.tabla-rutero .tr-franja b { color: #ffeb3d; font-weight: 700; }
.tabla-rutero .tr-par { white-space: nowrap; }
.tabla-ruteros { display: flex; flex-wrap: wrap; gap: 20px 28px; align-items: flex-start; }
`;

/** Adds `TABLA_RUTERO_CSS` to the document once (client only). */
export function ensureTablaRuteroStyle() {
  if (typeof document === 'undefined' || document.getElementById('tabla-rutero-css')) return;
  const style = document.createElement('style');
  style.id = 'tabla-rutero-css';
  style.textContent = TABLA_RUTERO_CSS;
  document.head.append(style);
}

/**
 * The sizes above assume a condensed face. Where the system has none (a Linux
 * desktop, Windows before 10) the fallback is wider and a chip's label would
 * spill out of its cell, so on the client each label that doesn't fit is set
 * smaller until it does — in container units, so it still scales with the page.
 * Where a condensed face is present this changes nothing.
 *
 * @param {ParentNode} root
 */
export function ajustarTablasRutero(root) {
  for (const figure of root.querySelectorAll('.tabla-rutero')) {
    const width = figure.clientWidth;
    if (!width) continue;
    for (const el of figure.querySelectorAll('.tr-chip-texto, .tr-destino, .tr-codigo')) {
      el.style.fontSize = '';
      // Spacing and the outline don't scale exactly with the size: a few passes.
      for (let pass = 0; pass < 3 && el.scrollWidth > el.clientWidth + 1; pass++) {
        const style = getComputedStyle(el);
        const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const fit = (el.clientWidth - pad) / (el.scrollWidth - pad);
        if (!(fit > 0 && fit < 1)) break;
        el.style.fontSize = `${((parseFloat(style.fontSize) * fit * 0.97) / width) * 100}cqi`;
      }
    }
  }
}
