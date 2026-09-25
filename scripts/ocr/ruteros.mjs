// Reads the rutero tables off TRANSMILENIO's route artwork — the 482 vector
// plegables and volantes delivered in answer to radicado 2026-ER-47262.
//
//   node ruteros.mjs                       # every PDF under the artes folder
//   node ruteros.mjs --only "AH 605" 139   # just the files whose name contains these
//   node ruteros.mjs --jobs 3              # parallel render workers (default 2)
//
// Writes `_ruteros/ruteros.json` and prints a confidence report. Nothing here
// ships to the site on its own: the output is a draft to be checked.
//
// WHY GEOMETRY FIRST, OCR SECOND
//
// These PDFs are vector art with every letter converted to curves — no text
// layer — but every cell of a rutero is a filled path with an exact colour.
// So the table is located from the drawing, not from pixels or OCR guesses:
//
//   • the table outline is one dark path whose bounding box is the whole table;
//   • the código tab sits flush with its top, narrower than the table;
//   • the destino band spans the full width just under the tab;
//   • corridor chips are ~40–48pt rectangles, yellow (#ffeb3d) or dark
//     (#2c2e35), stacked flush against the table's left edge, one per row;
//   • each hito runs from its chip's right edge to the table's right edge.
//
// A dark chip spanning two rows (the manual's "corredor destacado", e.g.
// `AV. NQS` beside U. NAL. and CAMPÍN) is drawn as two adjacent dark
// rectangles with no border between them, so runs of dark chips are also
// read as one union and the union wins when only it reads as a corridor.
//
// Only those cells are then rendered and OCR'd one by one — the per-cell read
// FINDINGS.md measured as excellent, where the full-page read was not. Dark
// chips are inverted first: white-on-dark is what the engine drops.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ZONAS, leerCodigoZonal, normalizarCorredor } from '../../shared/nomenclatura.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTES = join(HERE, '..', '..', 'peticiones', 'Respuesta A', '09-2026_Artesfinales TransMiZonales');
const OUT = join(HERE, '_ruteros');
const SCALE = 6; // 612pt → 3672px; a 40×20pt chip becomes 240×120px
// Each cell is OCR'd at these fractions of SCALE and the readings vote: the
// heavy condensed face reads right at SOME sizes and wrong at others, and which
// ones differs per cell (KR 24 at 0.2–0.3, CL 72 at 0.3–0.65, D205 at all).
const OCR_SCALES = [0.2, 0.3, 0.45, 0.65];
// …each also stretched horizontally. The face is a heavy condensed display cut,
// and the engine reads it as a normal-width face would be read: H605 → "11605"
// and KR 24 → "n 24" at EVERY size, correct at every size once widened 1.4–2.3×.
// One unstretched variant is kept for the cells that were already fine.
const OCR_VARIANTS = [...OCR_SCALES.map((f) => ({ f, sx: 1.8 })), { f: 0.3, sx: 1 }];

// ─── colour ──────────────────────────────────────────────────────────────────
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
const isDark = (hex) => rgb(hex).every((c) => c < 80);
const isYellow = (hex) => { const [r, g, b] = rgb(hex); return r > 220 && g > 200 && b < 120; };
const near = (a, b, tol = 2.5) => Math.abs(a - b) <= tol;

// ─── geometry ────────────────────────────────────────────────────────────────
async function geometry(lib, page) {
  const [, , W, H] = page.view;
  const ol = await page.getOperatorList();
  const NAME = Object.fromEntries(Object.entries(lib.OPS).map(([k, v]) => [v, k]));
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let fill = '#000000';
  const fills = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const op = NAME[ol.fnArray[i]];
    const a = ol.argsArray[i];
    if (op === 'save') stack.push(ctm);
    else if (op === 'restore') ctm = stack.pop() ?? ctm;
    else if (op === 'transform') ctm = mul(ctm, a);
    else if (op === 'setFillRGBColor') fill = a[0];
    else if (op === 'constructPath' && /fill/i.test(NAME[a[0]] ?? '')) {
      const path = a[1][0];
      const mm = a[2];
      let corners = 0;
      let rect = true;
      for (let k = 0; k < path.length;) {
        const c = path[k];
        if (c === 0 || c === 1) { corners++; k += 3; } else if (c === 4) k += 1; else { rect = false; break; }
      }
      const p = [[mm[0], mm[1]], [mm[2], mm[3]]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const x0 = Math.min(p[0][0], p[1][0]);
      const x1 = Math.max(p[0][0], p[1][0]);
      const y0 = H - Math.max(p[0][1], p[1][1]);
      const y1 = H - Math.min(p[0][1], p[1][1]);
      fills.push({ x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, fill: String(fill).toLowerCase(), rect: rect && corners <= 5 });
    }
  }
  return { W, H, fills };
}

function dedupe(items, key) {
  const seen = new Set();
  return items.filter((it) => { const k = key(it); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Some chips are drawn as one rectangle per line of text (580's "AV." over
 * "1/MAYO"), each about half a row tall. Two adjacent same-colour chips that
 * together make one ordinary row height are one row, not two — otherwise the
 * hito beside them is read twice.
 */
function mergeLineChips(chips) {
  if (chips.length < 2) return chips;
  const heights = chips.map((c) => c.h).sort((a, b) => a - b);
  const rowH = heights[Math.floor(heights.length * 0.75)];
  const out = [];
  for (const c of chips) {
    const prev = out[out.length - 1];
    if (prev && prev.fill === c.fill && near(prev.y1, c.y0, 1) && prev.h < rowH * 0.75 && c.h < rowH * 0.75 && near(prev.h + c.h, rowH, rowH * 0.2)) {
      out[out.length - 1] = { ...prev, y1: c.y1, h: c.y1 - prev.y0 };
    } else out.push({ ...c });
  }
  return out;
}

/**
 * A last row with no corridor: F425 ends with "EST. BANDERAS" across the whole
 * table, with no chip beside it. The table outline says it is there — the
 * outline runs a row further down than the last chip — so that space is read
 * as full-width hito rows of the table's usual height.
 */
function withChiplessRows(t, rows) {
  if (!rows.length) return rows;
  const heights = rows.map((r) => r.chip.y1 - r.chip.y0).sort((a, b) => a - b);
  const rowH = heights[Math.floor(heights.length / 2)];
  const last = rows[rows.length - 1].chip.y1;
  const gap = t.y1 - last;
  if (gap < rowH * 0.6) return rows;
  const n = Math.max(1, Math.round(gap / rowH));
  for (let k = 0; k < n; k++) {
    rows.push({ chip: null, dark: false, fill: null, hito: { x0: t.x0, y0: last + (k * gap) / n, x1: t.x1, y1: last + ((k + 1) * gap) / n } });
  }
  return rows;
}

/** Tables, their cells, and the schedule chips, all in page points (top-down). */
function layout({ W, fills }) {
  // Every size below is for a 612pt-wide plegable. Volantes are ~397pt wide and
  // draw the same table at about 0.65 of it (G528's chips are 26pt, not 40), so
  // the bounds scale with the page rather than being tuned twice.
  const k = W / 612;
  const chipsAll = dedupe(
    fills.filter((f) => f.rect && (isYellow(f.fill) || isDark(f.fill)) && f.w >= 30 * k && f.w <= 70 * k && f.h >= 9 * k && f.h <= 36 * k),
    (f) => `${f.x0.toFixed(0)}|${f.y0.toFixed(0)}`
  );
  const outlines = dedupe(
    fills.filter((f) => isDark(f.fill) && !f.rect && f.w > 90 * k && f.w < 280 * k && f.h > 70 * k && f.h < 340 * k),
    (f) => `${f.x0.toFixed(0)}|${f.y0.toFixed(0)}|${f.w.toFixed(0)}`
  );

  const tables = [];
  for (const t of outlines) {
    // Some chips are painted twice, a fraction of a point apart (580 draws its
    // AV. 1/MAYO chip at x 126.3 and again at 126.9). Rounding to whole points
    // cannot catch a pair that straddles one, so overlap decides: a chip that
    // covers the same rows as the one before it is the same chip.
    const chips = chipsAll
      .filter((c) => near(c.x0, t.x0, 3) && c.y0 >= t.y0 - 1 && c.y1 <= t.y1 + 1)
      .sort((a, b) => a.y0 - b.y0)
      .filter((c, i, all) => i === 0 || !(near(c.y0, all[i - 1].y0, 1.5) && near(c.y1, all[i - 1].y1, 1.5)));
    if (chips.length < 2) continue;
    const firstRow = chips[0].y0;
    const tab = fills
      .filter((f) => !isDark(f.fill) && near(f.y0, t.y0, 2) && f.x0 > t.x0 - 1 && f.x1 < t.x1 + 1 && f.w < t.w - 4 && f.h >= 8 * k && f.h <= 48 * k)
      .sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const header = fills
      .filter((f) => !isDark(f.fill) && near(f.x0, t.x0, 2) && near(f.x1, t.x1, 2) && f.h >= 8 * k && f.h <= 48 * k && f.y1 <= firstRow + 1.5 && f.y0 >= t.y0 - 1)
      .sort((a, b) => b.y0 - a.y0)[0];
    const headerBox = header
      ? { x0: t.x0, x1: t.x1, y0: header.y0, y1: header.y1 }
      : { x0: t.x0, x1: t.x1, y0: tab ? tab.y1 : t.y0 + (firstRow - t.y0) / 2, y1: firstRow };
    tables.push({
      box: { x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1 },
      tab: tab ? { x0: tab.x0, y0: tab.y0, x1: tab.x1, y1: tab.y1 } : { x0: t.x0, y0: t.y0, x1: t.x1, y1: headerBox.y0 },
      tabColor: tab?.fill ?? null,
      header: headerBox,
      headerColor: header?.fill ?? null,
      rows: withChiplessRows(t, mergeLineChips(chips).map((c) => ({
        chip: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
        dark: isDark(c.fill),
        fill: c.fill,
        hito: { x0: c.x1, y0: c.y0, x1: t.x1, y1: c.y1 },
      }))),
    });
  }
  // Left to right, then top to bottom: the order a rider reads the piece in.
  tables.sort((a, b) => (Math.abs(a.box.y0 - b.box.y0) > 20 ? a.box.y0 - b.box.y0 : a.box.x0 - b.box.x0));

  // Schedule: a small dark day chip ("L-S") with a wide yellow bar flush to its right.
  const smallDark = fills.filter((f) => f.rect && isDark(f.fill) && f.w >= 12 * k && f.w < 32 * k && f.h >= 8 * k && f.h <= 28 * k);
  const bars = fills.filter((f) => f.rect && isYellow(f.fill) && f.w > 50 * k && f.h >= 8 * k && f.h <= 28 * k);
  const horarios = [];
  for (const d of dedupe(smallDark, (f) => `${f.x0.toFixed(0)}|${f.y0.toFixed(0)}`)) {
    const bar = bars.find((b) => near(b.x0, d.x1, 3) && near(b.y0, d.y0, 2));
    if (bar) horarios.push({ dias: { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 }, horas: { x0: bar.x0, y0: bar.y0, x1: bar.x1, y1: bar.y1 }, diasFill: d.fill, horasFill: bar.fill });
  }
  horarios.sort((a, b) => a.dias.y0 - b.dias.y0 || a.dias.x0 - b.dias.x0);
  // The DIGITAL rutero, the layout of the routes that carry an electronic sign
  // (the infographic's "Digital"): one wide zone-coloured bar with código and
  // destino, and directly under it a dark strip of the same width reading
  // "Jerusalén/CL 70 Sur - Tunal/AV. V/cio - Olaya/KR 24 - …" — the same
  // hito/corredor pairs as a table, in one line. 113 zonal pieces use it.
  const digitales = [];
  for (const bar of fills.filter((f) => f.rect && !isDark(f.fill) && !isYellow(f.fill) && f.w > 250 * k && f.h >= 18 * k && f.h <= 48 * k)) {
    const strip = fills.find((g) => g.rect && isDark(g.fill) && near(g.x0, bar.x0, 2) && near(g.x1, bar.x1, 2) && near(g.y0, bar.y1, 2) && g.h >= 10 * k && g.h <= 34 * k);
    if (!strip) continue;
    if (digitales.some((d) => near(d.bar.y0, bar.y0, 2) && near(d.bar.x0, bar.x0, 2))) continue;
    digitales.push({
      bar: { x0: bar.x0, y0: bar.y0, x1: bar.x1, y1: bar.y1 },
      color: bar.fill,
      // The código sits left of a white rule at about a fifth of the bar; the
      // destino is centred in the rest. Only the destino is read: the código
      // comes from the file name or the bar's colour, as for the tables.
      destino: { x0: bar.x0 + (bar.x1 - bar.x0) * 0.2, y0: bar.y0, x1: bar.x1, y1: bar.y1 },
      linea: { x0: strip.x0, y0: strip.y0, x1: strip.x1, y1: strip.y1 },
      lineaFill: strip.fill,
    });
  }
  digitales.sort((a, b) => a.bar.y0 - b.bar.y0);
  return { tables, horarios, digitales };
}

// ─── rendering + crops (worker) ──────────────────────────────────────────────
async function renderCrops(file, cropDir) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const doc = await lib.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const geo = await geometry(lib, page);
  const lay = layout(geo);
  const id = basename(file, '.pdf').replace(/[^A-Za-z0-9-]+/g, '_');
  if (lay.tables.length === 0 && lay.horarios.length === 0 && lay.digitales.length === 0) return { id, lay, page: { W: geo.W, H: geo.H }, crops: [] };

  // Only the band that holds the tables and schedule is rendered.
  const boxes = [...lay.tables.map((t) => t.box), ...lay.horarios.flatMap((h) => [h.dias, h.horas]), ...lay.digitales.flatMap((d) => [d.bar, d.linea])];
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y0)) - 4);
  const bottom = Math.min(geo.H, Math.max(...boxes.map((b) => b.y1)) + 28);
  const vp = page.getViewport({ scale: SCALE });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil((bottom - top) * SCALE));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas, transform: [1, 0, 0, 1, 0, -top * SCALE] }).promise;

  // One hito can span two chip rows (TC14: "AV." / "V/CIO" as two chips beside
  // one "JACQUELINE"). The drawing gives no hito rectangle to say so, but the
  // separator line does: between two hitos there is a dark rule across the
  // column; where there is none, the text runs on and the two rows are one.
  const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const hasRule = (hito, y) => {
    const x0 = Math.round((hito.x0 + (hito.x1 - hito.x0) * 0.1) * SCALE);
    const x1 = Math.round((hito.x1 - (hito.x1 - hito.x0) * 0.1) * SCALE);
    const yy = Math.round((y - 1 - top) * SCALE);
    const hh = Math.round(2 * SCALE);
    if (x1 <= x0 || yy < 0) return true;
    const d = ctx.getImageData(x0, yy, x1 - x0, hh).data;
    const w = x1 - x0;
    let cols = 0;
    for (let x = 0; x < w; x++) {
      for (let r = 0; r < hh; r++) if (lum(d, (r * w + x) * 4) < 110) { cols++; break; }
    }
    return cols / w > 0.6;
  };
  for (const t of lay.tables) {
    const merged = [];
    for (const row of t.rows) {
      const prev = merged[merged.length - 1];
      if (prev && prev.chip && row.chip && prev.fill === row.fill && near(prev.hito.y1, row.hito.y0, 1) && !hasRule(prev.hito, prev.hito.y1)) {
        prev.chip = { ...prev.chip, y1: row.chip.y1 };
        prev.hito = { ...prev.hito, y1: row.hito.y1 };
        prev.merged = (prev.merged ?? 1) + 1;
      } else merged.push({ ...row });
    }
    t.rows = merged;
  }

  const crops = [];
  /**
   * One cell → black text on white, written at every OCR_SCALES size.
   *
   * Binarised by distance from the cell's OWN background, not by luminance: the
   * zone colours run from navy to orange to yellow-green, and a single luminance
   * cut turned the bright ones (orange H, green B) white along with their white
   * text. The background is the cell's most common colour, which on these flat
   * vector fills is exact.
   */
  const crop = (name, b, inset = 1.2, fillHex = null, insetX = inset) => {
    const x = Math.round((b.x0 + insetX) * SCALE);
    const y = Math.round((b.y0 + inset - top) * SCALE);
    const w = Math.max(4, Math.round((b.x1 - b.x0 - 2 * insetX) * SCALE));
    const h = Math.max(4, Math.round((b.y1 - b.y0 - 2 * inset) * SCALE));
    const src = ctx.getImageData(x, y, w, h);
    // The drawing states each cell's fill, so that is the background. The most
    // common colour is only the fallback: bold condensed text can cover more of
    // a cell than its ground does ("ARBORIZADORA ALTA" in white on orange), and
    // taking the text for the background inverts the whole mask.
    let bg;
    if (fillHex) bg = rgb(fillHex);
    else {
      const counts = new Map();
      for (let i = 0; i < src.data.length; i += 16) {
        const k = ((src.data[i] >> 3) << 10) | ((src.data[i + 1] >> 3) << 5) | (src.data[i + 2] >> 3);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const bgKey = [...counts].sort((p, q) => q[1] - p[1])[0][0];
      bg = [((bgKey >> 10) & 31) * 8 + 4, ((bgKey >> 5) & 31) * 8 + 4, (bgKey & 31) * 8 + 4];
    }
    const mask = createCanvas(w, h);
    const mctx = mask.getContext('2d');
    const img = mctx.createImageData(w, h);
    for (let i = 0; i < src.data.length; i += 4) {
      const d = Math.abs(src.data[i] - bg[0]) + Math.abs(src.data[i + 1] - bg[1]) + Math.abs(src.data[i + 2] - bg[2]);
      const v = d > 150 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    mctx.putImageData(img, 0, 0);
    const base = `${id}__${name}`;
    const write = (source, sw0, sh0, prefix) => {
      for (const [vi, { f, sx }] of OCR_VARIANTS.entries()) {
        const sw = Math.max(8, Math.round(sw0 * f * sx));
        const sh = Math.max(8, Math.round(sh0 * f));
        const pad = 30;
        const out = createCanvas(sw + 2 * pad, sh + 2 * pad);
        const octx = out.getContext('2d');
        octx.fillStyle = '#ffffff';
        octx.fillRect(0, 0, out.width, out.height);
        octx.drawImage(source, pad, pad, sw, sh);
        const png = `${base}__${prefix}${vi}.png`;
        writeFileSync(join(cropDir, png), out.toBuffer('image/png'));
        crops.push(png);
      }
    };
    write(mask, w, h, 'v');

    // A two-line cell ("KR" over "72D", "AV." over "BOYACÁ") loses its short
    // line: the engine does not detect a line of two or three glyphs on its own
    // — the same blindness that makes the L-S day chips unreadable. Laid side by
    // side the lines are one ordinary line, so each multi-line cell is also
    // written that way and both readings vote.
    const rowInk = new Array(h).fill(0);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (img.data[(yy * w + xx) * 4] === 0) rowInk[yy]++;
    const bands = [];
    for (let yy = 0; yy < h; yy++) {
      const ink = rowInk[yy] > 0;
      const last = bands[bands.length - 1];
      if (ink && (!last || last.end < yy - Math.max(3, Math.round(h * 0.04)))) bands.push({ start: yy, end: yy });
      else if (ink) last.end = yy;
    }
    const lines = bands.filter((b) => b.end - b.start >= h * 0.12);
    if (lines.length >= 2) {
      const boxes = lines.map((b) => {
        let x0 = w, x1 = 0;
        for (let yy = b.start; yy <= b.end; yy++) for (let xx = 0; xx < w; xx++) if (img.data[(yy * w + xx) * 4] === 0) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; }
        return { x0, x1, y0: b.start, y1: b.end };
      });
      const lh = Math.max(...boxes.map((b) => b.y1 - b.y0 + 1));
      const gap = Math.round(lh * 0.45);
      const jw = boxes.reduce((sum, b) => sum + (b.x1 - b.x0 + 1), 0) + gap * (boxes.length - 1);
      const joined = createCanvas(jw, lh);
      const jctx = joined.getContext('2d');
      jctx.fillStyle = '#ffffff';
      jctx.fillRect(0, 0, jw, lh);
      let cx = 0;
      for (const b of boxes) {
        const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
        jctx.drawImage(mask, b.x0, b.y0, bw, bh, cx, lh - bh, bw, bh);
        cx += bw + gap;
      }
      // Scaled against the one line's height, so its text is as large as a
      // single-line cell's would be.
      write(joined, jw, Math.round(lh * (h / lh) * 0.55), 'j');
    }
    return base;
  };
  lay.tables.forEach((t, ti) => {
    t.crops = {
      tab: crop(`t${ti}_tab`, t.tab, 1.2, t.tabColor, (t.tab.x1 - t.tab.x0) * 0.12),
      header: crop(`t${ti}_dest`, t.header, 1.2, t.headerColor),
      chips: t.rows.map((r, ri) => (r.chip ? crop(`t${ti}_c${ri}`, r.chip, 1.2, r.fill) : null)),
      hitos: t.rows.map((r, ri) => crop(`t${ti}_h${ri}`, r.hito, 1.5)),
      runs: [],
      // The line under the table says what it is for. Usually "Cuando el bus va
      // hacia …", but a table captioned "Operación domingos y festivos" is a
      // Sunday-and-holiday variant of the same direction (route 12 prints two
      // tables for Portal Eldorado for that reason), and without the flag the
      // two look like a contradiction.
      caption: crop(`t${ti}_cap`, { x0: t.box.x0, x1: t.box.x1, y0: t.box.y1 + 1, y1: Math.min(bottom + 26, t.box.y1 + 24) }, 0.5),
    };
    // Runs of adjacent dark chips: one corridor drawn across several rows.
    for (let i = 0; i < t.rows.length; i++) {
      if (!t.rows[i].dark || !t.rows[i].chip) continue;
      let j = i;
      while (j + 1 < t.rows.length && t.rows[j + 1].dark && t.rows[j + 1].chip && near(t.rows[j + 1].chip.y0, t.rows[j].chip.y1, 1)) j++;
      if (j > i) {
        const b = { x0: t.rows[i].chip.x0, y0: t.rows[i].chip.y0, x1: t.rows[i].chip.x1, y1: t.rows[j].chip.y1 };
        t.crops.runs.push({ from: i, to: j, png: crop(`t${ti}_run${i}_${j}`, b, 1.2, t.rows[i].fill) });
      }
      i = j;
    }
  });
  lay.digitales.forEach((dg, di) => {
    dg.crops = { destino: crop(`d${di}_dest`, dg.destino, 1.2, dg.color), linea: crop(`d${di}_line`, dg.linea, 1, dg.lineaFill) };
  });
  lay.horarios.forEach((h, hi) => {
    h.crops = { dias: crop(`s${hi}_d`, h.dias, 0.8, h.diasFill), horas: crop(`s${hi}_h`, h.horas, 0.8, h.horasFill) };
  });
  return { id, lay, page: { W: geo.W, H: geo.H }, crops };
}

// ─── reading the OCR back ────────────────────────────────────────────────────
/** Every scale's reading of one cell, empty ones dropped. */
function readings(ocr, base) {
  return ['v', 'j'].flatMap((p) => OCR_VARIANTS.map((_, vi) => {
    const r = ocr[`${base}__${p}${vi}.png`];
    if (!r || r.error || !r.lines) return '';
    return r.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
  })).filter(Boolean);
}

/** How many variants produced exactly the majority reading. */
function agreement(list) {
  const m = majority(list);
  return m ? list.filter((x) => x === m).length : 0;
}

/** The reading most scales agree on (ties → the longer one). */
function majority(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] ?? '';
}

/** A corridor: the normalised form most scales produce; else the raw majority. */
/**
 * OCR-only repairs, kept here rather than in the shared grammar because they
 * describe the engine, not the city: the slash of "V/CIO" comes back as I, 1 or
 * l, and the degree sign of "1° de Mayo" as a 0 ("10 de Mayo" — there is no
 * Avenida 10 de Mayo).
 */
function reparaCorredor(x) {
  return String(x).replace(/\bV[I1l|]CIO\b/i, 'V/CIO').replace(/\b10\s*DE\s*MAYO\b/i, '1° DE MAYO');
}

function voteCorredor(list) {
  const fixed = list.map(reparaCorredor);
  const norms = fixed.map((x) => normalizarCorredor(x)).filter(Boolean);
  return norms.length ? { raw: majority(list), norm: majority(norms), votes: norms.length } : { raw: majority(list), norm: null, votes: 0 };
}

/**
 * The zone a new-signage tab is painted in. The tab carries the DESTINATION
 * zone's colour, so for a two-way piece (AH 605) it says which of the two
 * códigos a table is without reading a letter — the letters are exactly what
 * the engine misreads. Matched to the manual's colours and to the older ones
 * the printed pieces still use; old signage paints every tab one navy, which
 * matches nothing here and so decides nothing.
 */
const ART_COLORS = { A: '#0c3b96', H: '#ff8525' };
function zonaDeColor(hex) {
  if (!hex) return null;
  const c = rgb(hex);
  let best = null;
  for (const [letra, z] of Object.entries(ZONAS)) {
    for (const ref of [z.color, ART_COLORS[letra]].filter(Boolean)) {
      const d = rgb(ref).reduce((sum, v, i) => sum + Math.abs(v - c[i]), 0);
      if (!best || d < best.d) best = { letra, d };
    }
  }
  return best && best.d <= 90 ? best.letra : null;
}

/** Expected códigos from the file name: `Plegable_WEB_AH 605` → A605, H605. */
function expectedCodes(name) {
  // "Volantes_WEB_AL 821" exists too — plural, once — and read as código
  // "S_WEB_AL821" until the s was allowed for.
  const m = name.replace(/\.pdf$/i, '').match(/^(?:Plegable|Volantes?)[_ ]*(?:WEB[_ ]*)?(.+)$/i);
  const raw = (m ? m[1] : name).replace(/\s+/g, '').toUpperCase();
  const zonal = leerCodigoZonal(raw);
  return { raw, codes: zonal ? zonal.map((s) => s.codigo) : [raw] };
}

function readCode(text, expected) {
  const t = text.replace(/\s+/g, '').toUpperCase()
    .replace(/^1(?=\d{3}$)/, 'L') // FINDINGS: L815 read as 1815
    .replace(/O/g, '0');
  const hit = expected.find((c) => t.includes(c.replace(/O/g, '0')));
  return hit ?? null;
}

/**
 * The day chip of a schedule row. The pieces use a closed set (the
 * infographic's "Aplicación de los horarios según el tipo de operación"):
 * L-S, D-F, L-V, S, L-D. Anything else is a misread, not a new day type.
 */
function leerDias(text) {
  const t = String(text).toUpperCase().replace(/[—–_.]/g, '-').replace(/\s+/g, '').replace(/^1-/, 'L-').replace(/-+/g, '-');
  const compact = t.replace(/-/g, '');
  const map = { LS: 'L-S', DF: 'D-F', LV: 'L-V', LD: 'L-D', S: 'S', D: 'D' };
  return map[compact] ?? null;
}

/**
 * "4:00 a.m. - 10:00 p.m." → { desde: '04:00', hasta: '22:00' }. The engine
 * reads the stretched "m" as "rn" and the dash as anything; the two times and
 * their meridiems are what is kept. Past midnight ("12:30 a.m." as a closing
 * time) stays on the clock it names — the caller knows it closes after 24:00.
 */
function leerFranja(text) {
  // Only times and a.m./p.m. appear in these bars, so every letter o is a zero
  // ("11 :OO"); digits split by a space are one number ("1 1:00"); and a
  // bare hour ("11 p.m.") is on the hour.
  const t = String(text).toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/o/g, '0')
    .replace(/[^0-9apm:]/g, ' ')
    .replace(/(\d)\s+(?=\d)/g, '$1')
    .replace(/\s*:\s*/g, ':');
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\s*m?\b.*?(\d{1,2})(?::(\d{2}))?\s*([ap])/);
  if (!m) return null;
  const to24 = (h, min, ap) => {
    let hh = Number(h) % 12;
    if (ap === 'p') hh += 12;
    return `${String(hh).padStart(2, '0')}:${min}`;
  };
  const [, h1, m1 = '00', a1, h2, m2 = '00', a2] = m;
  if (Number(h1) > 12 || Number(h2) > 12 || Number(m1) > 59 || Number(m2) > 59) return null;
  return { desde: to24(h1, m1, a1), hasta: to24(h2, m2, a2) };
}

/** Similarity of two names on their letters and digits alone, 0–1. */
function similar(a, b) {
  const x = fold(a), y = fold(b);
  if (!x || !y) return 0;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  }
  return 1 - dp[x.length][y.length] / Math.max(x.length, y.length);
}
const fold = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const cleanName = (s) => s.replace(/\s+/g, ' ').replace(/^[^\p{L}\d]+|[^\p{L}\d.)]+$/gu, '').trim().toLocaleUpperCase('es');

function assemble(r, ocr, destinos, horariosCat) {
  const { codes } = expectedCodes(basename(r.file));
  const warnings = [];
  const tables = r.lay.tables.map((t, ti) => {
    const tabReads = readings(ocr, t.crops.tab);
    const zona = zonaDeColor(t.tabColor);
    const byColour = zona ? codes.find((c) => c[0] === zona && leerCodigoZonal(c)) : null;
    // One código per piece is simply the file name's (FINDINGS: the código is
    // not OCR'd). Two-way pieces need the tab: its colour, else its reading.
    const code = codes.length === 1 ? codes[0] : byColour ?? tabReads.map((x) => readCode(x, codes)).find(Boolean) ?? null;
    if (!code) warnings.push(`tabla ${ti}: código no leído (${JSON.stringify(tabReads)})`);
    const corredores = t.rows.map((row, ri) => (t.crops.chips[ri] ? voteCorredor(readings(ocr, t.crops.chips[ri])) : { raw: '', norm: null, sinChip: true }));
    for (const run of t.crops.runs) {
      const { raw, norm } = voteCorredor(readings(ocr, run.png));
      const partsRead = corredores.slice(run.from, run.to + 1).filter((c) => c.norm).length;
      if (norm && partsRead < run.to - run.from + 1) {
        for (let k = run.from; k <= run.to; k++) corredores[k] = { raw, norm, spans: run.to - run.from + 1 };
      }
    }
    const rows = t.rows.map((row, ri) => {
      const c = corredores[ri];
      const hito = cleanName(majority(readings(ocr, t.crops.hitos[ri])));
      if (!c.norm && !c.sinChip) warnings.push(`tabla ${ti} fila ${ri}: corredor sin normalizar ("${c.raw}")`);
      if (!hito) warnings.push(`tabla ${ti} fila ${ri}: hito vacío`);
      if (c.sinChip) return { corredor: null, hito };
      return { corredor: c.norm ?? c.raw, corredorLeido: c.raw, normalizado: Boolean(c.norm), destacado: row.dark, ...(c.spans ? { abarca: c.spans } : {}), hito };
    });
    // The destino as printed when the reading is sound; the catalog's name for
    // this código when it is not. Long destinos in the heavy face touch letter to
    // letter and no preprocessing separates them ("ARBORIZADORA ALTA" came back
    // as "A•ORmDORAAITA"), but the catalog already knows every route's ends.
    const headerReads = readings(ocr, t.crops.header).map(cleanName).filter(Boolean);
    const leido = majority(headerReads);
    // Five variants that each read something different are not a reading
    // (K336: GIUNDE / GuNDE / GMNDE for GRANDE) — the catalog is then the
    // better witness, at a lower bar than when the variants agree.
    const unanime = agreement(headerReads) >= 2;
    const candidatos = [...new Set((code ? [code] : codes).flatMap((c) => destinos.get(c) ?? []))];
    const ranked = candidatos.map((n) => ({ n, s: similar(leido, n) })).sort((a, b) => b.s - a.s);
    let destino = leido;
    let destinoFuente = 'ocr';
    const margen = !ranked[1] || ranked[0].s - ranked[1].s >= 0.1;
    if (ranked[0] && margen && ((ranked[0].s < 0.75 && ranked[0].s >= 0.4) || (!unanime && ranked[0].s >= 0.55 && ranked[0].s < 1))) {
      destino = ranked[0].n.toLocaleUpperCase('es');
      destinoFuente = 'catálogo';
    }
    if (!destino) warnings.push(`tabla ${ti}: destino vacío`);
    else if (destinoFuente === 'ocr' && ranked[0] && ranked[0].s < 0.6) warnings.push(`tabla ${ti}: destino "${destino}" no se parece a ninguno del catálogo (${candidatos.join(' / ')})`);
    const leyenda = majority(readings(ocr, t.crops.caption));
    const soloDomingos = /domingo|festivo/i.test(readings(ocr, t.crops.caption).join(' '));
    return { codigo: code, codigoFuente: codes.length === 1 ? 'archivo' : byColour ? 'color' : code ? 'ocr' : null, ...(soloDomingos ? { operacion: 'domingos y festivos' } : {}), leyenda, destino, destinoFuente, destinoLeido: leido, colorCodigo: t.tabColor, colorDestino: t.headerColor, filas: rows };
  });
  // Digital ruteros → the same shape as a table, rows in reading order.
  for (const [di, dg] of r.lay.digitales.entries()) {
    const zona = zonaDeColor(dg.color);
    const byColour = zona ? codes.find((c) => c[0] === zona && leerCodigoZonal(c)) : null;
    const code = codes.length === 1 ? codes[0] : byColour ?? null;
    if (!code) warnings.push(`digital ${di}: código no deducido`);
    const leido = majority(readings(ocr, dg.crops.destino).map(cleanName).filter(Boolean));
    const candidatos = [...new Set((code ? [code] : codes).flatMap((c) => destinos.get(c) ?? []))];
    const best = candidatos.map((n) => ({ n, s: similar(leido, n) })).sort((a, b) => b.s - a.s)[0];
    const destino = best && best.s >= 0.55 && best.s < 0.75 ? best.n.toLocaleUpperCase('es') : leido;
    // Each variant's line is split into segments; the variant whose segments
    // yield the most corridors the grammar accepts is the reading kept.
    const parsed = readings(ocr, dg.crops.linea).map((line) => line
      .split(/\s[-–—]\s|\s[-–—](?=\S)|(?<=\S)[-–—]\s/)
      .map((seg) => seg.trim()).filter(Boolean)
      .map((seg) => {
        const cut = seg.indexOf('/');
        if (cut < 0) return { hito: seg, corredor: null, normalizado: false, corredorLeido: '' };
        const rawCorr = reparaCorredor(seg.slice(cut + 1).trim());
        const norm = normalizarCorredor(rawCorr);
        return { hito: seg.slice(0, cut).trim(), corredor: norm ?? rawCorr, normalizado: Boolean(norm), corredorLeido: rawCorr };
      }));
    const filas = parsed.sort((a, b) => b.filter((x) => x.normalizado).length - a.filter((x) => x.normalizado).length || b.length - a.length)[0] ?? [];
    for (const [ri, fila] of filas.entries()) if (fila.corredor !== null && !fila.normalizado) warnings.push(`digital ${di} fila ${ri}: corredor sin normalizar ("${fila.corredorLeido}")`);
    if (!filas.length) warnings.push(`digital ${di}: línea no leída`);
    tables.push({ formato: 'digital', codigo: code, codigoFuente: codes.length === 1 ? 'archivo' : byColour ? 'color' : null, destino, destinoFuente: destino === leido ? 'ocr' : 'catálogo', destinoLeido: leido, colorCodigo: dg.color, colorDestino: dg.color, filas: filas.map((x) => ({ corredor: x.corredor, corredorLeido: x.corredorLeido, normalizado: x.normalizado, destacado: false, hito: x.hito })) });
  }

  // The day chip ("L-S") is too short a line for the engine to find at any
  // size. The catalog carries each route's windows with their convención, so a
  // window whose times match one of them takes its day type from there; one
  // that matches none is kept, flagged — the piece and the catalog disagree
  // (TC14's piece gives L-V/S/D-F where the catalog has L-S/D-F; F425's gives
  // an afternoon window the catalog does not have at all).
  const cat = codes.flatMap((c) => horariosCat.get(c) ?? []);
  //
  // All or nothing: a day type is taken from the catalog only when EVERY
  // window on the piece matches one there. When some do not, the two schedules
  // differ in structure, and a match on times alone is a coincidence — TC14's
  // "S 5:00 a.m.–8:00 p.m." has exactly the catalog's D-F times.
  const leidas = r.lay.horarios.map((h) => {
    const franjas = readings(ocr, h.crops.horas).map(leerFranja).filter(Boolean);
    return franjas.length ? JSON.parse(majority(franjas.map((x) => JSON.stringify(x)))) : null;
  });
  const diasDe = (franja) => {
    const hits = franja ? [...new Set(cat.filter((c) => c.desde === franja.desde && c.hasta === franja.hasta).map((c) => c.dias))] : [];
    return hits.length === 1 ? hits[0] : null;
  };
  const coincide = leidas.length > 0 && leidas.every((fr) => diasDe(fr));
  const horarios = r.lay.horarios.map((h, hi) => {
    const franja = leidas[hi];
    const leidos = majority(readings(ocr, h.crops.dias).map(leerDias).filter(Boolean)) || null;
    const dias = leidos ?? (coincide ? diasDe(franja) : null);
    if (!franja) warnings.push(`horario ${hi}: horas no leídas (${JSON.stringify(majority(readings(ocr, h.crops.horas)))})`);
    else if (!diasDe(franja)) warnings.push(`horario ${hi}: ${franja.desde}–${franja.hasta} no está en el catálogo (${cat.map((c) => `${c.dias} ${c.desde}–${c.hasta}`).join(', ') || 'sin horarios'})`);
    return { dias, diasFuente: leidos ? 'ocr' : dias ? 'catálogo' : null, ...(franja ?? { desde: null, hasta: null }) };
  });
  return { archivo: relative(ARTES, r.file).replace(/\\/g, '/'), codigos: codes, tablas: tables, horarios, avisos: warnings };
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const jobsAt = args.indexOf('--jobs');
  const jobs = jobsAt > -1 ? Number(args[jobsAt + 1]) || 2 : 2;
  const onlyAt = args.indexOf('--only');
  const only = [];
  if (onlyAt > -1) for (let k = onlyAt + 1; k < args.length && !args[k].startsWith('--'); k++) only.push(args[k]);

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
  console.log(`${chosen.length} PDF`);

  const cropDir = join(OUT, 'crops');
  rmSync(cropDir, { recursive: true, force: true });
  mkdirSync(cropDir, { recursive: true });

  const t0 = Date.now();
  const slices = Array.from({ length: jobs }, (_, i) => chosen.filter((_, k) => k % jobs === i)).filter((s) => s.length);
  const rendered = (await Promise.all(slices.map((slice) => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { files: slice, cropDir } });
    w.once('message', resolve);
    w.once('error', reject);
  })))).flat();
  console.log(`geometría + recortes: ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  const t1 = Date.now();
  const ocrJson = join(OUT, 'ocr.json');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'ocr_batch.ps1'), '-Dir', cropDir, '-Out', ocrJson], { stdio: 'inherit' });
  const ocr = JSON.parse(readFileSync(ocrJson, 'utf8'));
  console.log(`OCR: ${((Date.now() - t1) / 1000).toFixed(0)} s`);

  // Every route's destination names, from the catalog, keyed by código.
  const catalog = JSON.parse(readFileSync(join(HERE, '..', '..', 'server', 'src', 'data', 'master_catalog.json'), 'utf8'));
  const destinos = new Map();
  for (const [code, variants] of Object.entries((catalog.data ?? catalog).routes ?? {})) {
    destinos.set(code.toUpperCase(), [...new Set(variants.map((v) => v.nombre).filter(Boolean))]);
  }
  // …and their published windows, parsed to 24h, for the day-type match.
  const reloj = (v) => {
    const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
    if (!m) return null;
    const hh = (Number(m[1]) % 12) + (m[3].toUpperCase() === 'P' ? 12 : 0);
    return `${String(hh).padStart(2, '0')}:${m[2]}`;
  };
  const horariosCat = new Map();
  for (const [code, variants] of Object.entries((catalog.data ?? catalog).routes ?? {})) {
    const list = [];
    for (const v of variants) for (const row of v.horarios?.data ?? []) {
      const desde = reloj(row.hora_inicio), hasta = reloj(row.hora_fin);
      if (desde && hasta && !list.some((x) => x.dias === row.convencion && x.desde === desde && x.hasta === hasta)) list.push({ dias: row.convencion, desde, hasta });
    }
    horariosCat.set(code.toUpperCase(), list);
  }
  const out = rendered.map((r) => (r.error ? { archivo: relative(ARTES, r.file), error: r.error } : assemble(r, ocr, destinos, horariosCat)));
  // A partial run (--only) updates its own pieces inside the last full result
  // instead of replacing it: re-reading one fixed piece must not cost the
  // other 481.
  let merged = out;
  if (only.length) {
    try {
      const prev = JSON.parse(readFileSync(join(OUT, 'ruteros.json'), 'utf8'));
      const fresh = new Map(out.map((o) => [o.archivo, o]));
      merged = [...prev.filter((p) => !fresh.has(p.archivo)), ...out].sort((a, b) => a.archivo.localeCompare(b.archivo));
    } catch { /* no previous run: this one is the result */ }
  }
  writeFileSync(join(OUT, 'ruteros.json'), JSON.stringify(merged, null, 1));

  // ─── report ───
  const ok = out.filter((o) => !o.error);
  const tablas = ok.flatMap((o) => o.tablas);
  const filas = tablas.flatMap((t) => t.filas);
  const sinTablas = ok.filter((o) => o.tablas.length === 0);
  console.log(`\npiezas: ${out.length} | con error: ${out.length - ok.length} | sin tablas de rutero: ${sinTablas.length} | con rutero digital: ${ok.filter((o) => o.tablas.some((t) => t.formato === 'digital')).length}`);
  console.log(`tablas: ${tablas.length} | con código: ${tablas.filter((t) => t.codigo).length} (por color ${tablas.filter((t) => t.codigoFuente === 'color').length}) | con destino: ${tablas.filter((t) => t.destino).length} (del catálogo ${tablas.filter((t) => t.destinoFuente === 'catálogo').length})`);
  const conChip = filas.filter((f) => f.corredor !== null);
  console.log(`filas: ${filas.length} | corredor normalizado: ${conChip.filter((f) => f.normalizado).length}/${conChip.length} (${(100 * conChip.filter((f) => f.normalizado).length / Math.max(1, conChip.length)).toFixed(1)}%) | con hito: ${filas.filter((f) => f.hito).length}`);
  const hs = ok.flatMap((o) => o.horarios);
  console.log(`tablas solo domingos y festivos: ${tablas.filter((t) => t.operacion).length}`);
  console.log(`horarios: ${hs.length} franjas en ${ok.filter((o) => o.horarios.length).length} piezas | horas leídas ${hs.filter((h) => h.desde).length} | tipo de día ${hs.filter((h) => h.dias).length} | filas sin corredor ${filas.filter((f) => f.corredor === null).length}`);
  console.log(`→ ${join(OUT, 'ruteros.json')}`);
}

// ─── entry ───────────────────────────────────────────────────────────────────
// Last, so every declaration above is initialised before main() reads it.
if (!isMainThread) {
  const results = [];
  for (const file of workerData.files) {
    try { results.push({ file, ...(await renderCrops(file, workerData.cropDir)) }); }
    catch (err) { results.push({ file, error: String(err?.message ?? err) }); }
  }
  parentPort.postMessage(results);
} else {
  await main();
}
