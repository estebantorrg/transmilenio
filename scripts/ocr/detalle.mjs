// Station planos → a DRAFT of the furniture around the platforms.
//
//   node detalle.mjs                 # every sheet nobody has read yet
//   node detalle.mjs TM0005 …        # just these
//   node detalle.mjs --check         # re-read the two done by hand, and diff
//
// WHY THIS EXISTS
//
// `planos.mjs` answers how many vagones a sheet prints. This answers what is
// drawn AROUND them — the vestibules, the taquillas and torniquetes inside
// them, the salidas and the street each comes out on, the pedestrian bridges —
// which is what `detalle` in `plano_vagones.json` holds and what the estación
// page draws.
//
// Two stations were read by eye (Guatoque, Av. Chile). Each cost several passes
// and most of that was reading the sheet wrong. There are 152 left, so the eye
// is the wrong instrument: it does not scale, and it was not even accurate.
//
// WHAT IT WRITES, AND WHAT IT REFUSES TO
//
// It writes `_planos/detalle_draft.json` and nothing else. It never touches
// `plano_vagones.json`. A draft is a proposal to check against the sheet, not
// an answer — the same rule `planos.mjs` follows, for the same reason: the
// sheets carry things no rule about pixels can know.
//
// It is also allowed to LEAVE GAPS, and does so deliberately. A vestibule whose
// tiles it cannot classify emits no tiles rather than guessed ones; a salida
// whose street name will not OCR emits `calle: null`. Half the stations drawn
// accurately beats every station drawn confidently wrong — a wrong plano sends
// a rider to the wrong end of a platform, which is worse than no plano.
//
// HOW IT READS A SHEET
//
// 1. THE PLATES locate everything. They are the one primitive already proven
//    (`planos.mjs`, 19/21) — saturated-yellow bars, all one size per sheet.
//    They give the platform band, the rows, and the x of every vagón column.
//
// 2. A COLUMN PROFILE over that band gives the shape. For each x, the most
//    common non-white pixel: pale grey is platform surface, anything darker is
//    station footprint. Absolute greys are NOT trusted to mean anything — the
//    channels are grey 200 at Guatoque and grey 156 at Calle 85, the same
//    element drawn two ways — so the runs are named STRUCTURALLY instead:
//
//      pale run under a vagón plate            → `vagones`
//      pale run, tall and narrow, no plate      → `puente`
//      footprint run between two decks          → `paso`
//      footprint run past the outermost deck    → `vestibulo`
//
//    A footprint run beside a vestibule is absorbed INTO it: on the sheet the
//    ramp arrows and the walking figure sit in a channel at the vestibule's
//    platform edge, and the renderer already draws that as part of the block.
//
// 3. THE LEGEND classifies the equipment tiles. Every sheet prints its own
//    Convenciones key, so the glyphs are matched against artwork from the SAME
//    sheet rather than against anything hard-coded — the plan draws them white
//    on black and the legend grey on white, so both are reduced to an ink
//    silhouette first. The key's labels are OCR'd too, so nothing depends on
//    the rows keeping a fixed order.
//
// 4. OCR, but only ever on a tight crop, never on the page. The plate número
//    reads reliably this way at both sheet sizes, which the full-page pass in
//    `planos.mjs` could not do — a `Vagón 3` bar is 88x17 on a dense sheet and
//    comes back clean at 6-12x, from a vote across zooms and a binarised pass.
//    Street names are the honest failure: they read at 1024 on a roomy sheet
//    (`Carrera 27`, 88x22) and do not read at all on a dense one (`Calle 72`,
//    38x10). Those are left null on purpose.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const OUT = '_planos';
const PLATES = '../../server/src/data/plano_vagones.json';
const MAPS_API = 'https://tramites.transmilenio.gov.co/station-maps/api/map';

// Read by hand, checked against the sheet, and shipping. The generator does not
// propose for these — it would only offer a worse copy of an answer that is
// already right. `--check` re-reads them anyway and diffs, which is the only
// test this tool has: it has to reproduce what the eye found.
const DONE = new Set(['TM0147', 'TM0061']);

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const only = argv.filter((a) => /^TM\d+$/i.test(a)).map((a) => a.toUpperCase());

mkdirSync(OUT, { recursive: true });
mkdirSync('_out', { recursive: true });

async function markers() {
  const cache = `${OUT}/markers.json`;
  if (!existsSync(cache)) {
    const res = await fetch(MAPS_API);
    if (!res.ok) throw new Error(`station-maps API ${res.status}`);
    writeFileSync(cache, JSON.stringify(await res.json()));
  }
  return JSON.parse(readFileSync(cache, 'utf8')).markers ?? [];
}

async function imageFor(marker) {
  const file = `${OUT}/${marker.code}.jpg`;
  if (!existsSync(file)) {
    const res = await fetch(marker.image_url);
    if (!res.ok) throw new Error(`image ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

/**
 * Everything the sheet is made of, in one pass over the pixels.
 *
 * Returns the yellow blobs (plates and salida tabs), the near-black tiles (the
 * equipment, and the service chips that are not equipment), the legend's
 * glyphs, and — the expensive part — a per-x histogram of the greys so the
 * column profile can be taken over any band without touching the image again.
 */
async function segment(page, file) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async ({ b64 }) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height);

    const at = (x, y) => (y * width + x) * 4;
    const white = (i) => data[i] > 246 && data[i + 1] > 246 && data[i + 2] > 246;
    const grey = (i) => Math.abs(data[i] - data[i + 1]) < 12 && Math.abs(data[i + 1] - data[i + 2]) < 12;

    /** Connected components of a predicate, 4-connected, with bounding boxes. */
    function comps(test, minPx, box) {
      const X0 = box?.x0 ?? 0, X1 = box?.x1 ?? width - 1;
      const Y0 = box?.y0 ?? 0, Y1 = box?.y1 ?? height - 1;
      const seen = new Uint8Array(width * height);
      const out = [];
      for (let y = Y0; y <= Y1; y++) {
        for (let x = X0; x <= X1; x++) {
          const p = y * width + x;
          if (seen[p] || !test(p * 4)) continue;
          let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
          const st = [p];
          seen[p] = 1;
          while (st.length) {
            const q = st.pop();
            const qx = q % width, qy = (q / width) | 0;
            n++;
            if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
            if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
            for (const r of [q - 1, q + 1, q - width, q + width]) {
              const rx = r % width, ry = (r / width) | 0;
              if (r < 0 || r >= width * height || seen[r]) continue;
              if (Math.abs(rx - qx) > 1) continue;
              if (rx < X0 || rx > X1 || ry < Y0 || ry > Y1) continue;
              if (!test(r * 4)) continue;
              seen[r] = 1;
              st.push(r);
            }
          }
          if (n >= minPx) out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, px: n });
        }
      }
      return out;
    }

    const isYellow = (i) => {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      return r > 180 && g > 150 && b < 120 && r - b > 90 && g - b > 70;
    };
    const isBlack = (i) => data[i] < 78 && data[i + 1] < 78 && data[i + 2] < 78;

    return {
      width,
      height,
      yellows: comps(isYellow, 120).sort((x, y) => x.y - y.y || x.x - y.x),
      blacks: comps(isBlack, 60).sort((x, y) => x.x - y.x),
    };
  }, { b64 });
}

/**
 * The column profile: what each x is made of, across the platform band.
 *
 * `P` pale grey — a platform surface, so a deck or a bridge deck.
 * `F` footprint — any darker non-white grey: vestibule, channel, crossing.
 * `.` nothing — white page, so outside the drawing.
 *
 * The two greys a sheet uses for `F` are NOT separated, on purpose. Guatoque
 * draws its channels at 200 and its vestibule at 176; Calle 85 draws its
 * channels at 156 and has no 200 at all. Reading meaning into the value made
 * the same element two different things on two sheets. What the runs ARE is
 * decided structurally further down instead.
 */
async function profile(page, file, band, deepBand) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async ({ b64, band, deepBand }) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data, width } = ctx.getImageData(0, 0, cv.width, cv.height);
    const prof = [];
    for (let x = 0; x < width; x++) {
      // How much platform grey stands in this column across the WHOLE drawing,
      // which is the measure that tells a bridge from a deck. Counted over a
      // wider window than the structure is: inside the platform band a bridge
      // is exactly as deep as a platform, and Boyacá's went unseen.
      let deep = 0;
      for (let y = deepBand.y0; y <= deepBand.y1; y++) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12) continue;
        if (r >= 222 && r <= 250) deep++;
      }
      let pale = 0, foot = 0, ptop = -1, pbot = -1;
      for (let y = band.y0; y <= band.y1; y++) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r > 246 && g > 246 && b > 246) continue;
        if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12) continue;
        if (r >= 222 && r <= 250) {
          pale++;
          // How far the PLATFORM grey reaches at this x, and only that. It is
          // what tells a bridge from a deck — a bridge crosses the road the
          // station sits in, so it is drawn taller than any platform — and
          // measuring all ink instead caught the service chips above and below
          // the drawing, which made every column the same height.
          if (ptop < 0) ptop = y;
          pbot = y;
        } else if (r >= 130) foot++;
      }
      prof.push({ c: pale === 0 && foot === 0 ? '.' : pale >= foot ? 'P' : 'F', pale: deep });
    }
    return prof;
  }, { b64, band, deepBand });
}

/**
 * Where the platforms are, down the page.
 *
 * The bands the furniture is filed under — above the platforms, between them,
 * below them — have to be measured off the DECKS, not off the plates. A plate
 * is centred in its deck, so plate edges put the boundary in the middle of a
 * platform: at Av. Chile that filed the taquilla, which is plainly drawn beside
 * the upper deck, in the middle band with the torniquetes.
 */
async function deckRows(page, file, span) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(
    async ({ b64, span }) => {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height);
      const counts = [];
      for (let y = 0; y < height; y++) {
        let pale = 0;
        for (let x = span.x0; x <= span.x1; x++) {
          const i = (y * width + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          // The vagón plate lies ON the deck, so it is platform too. Counting
          // only the grey cut every platform in half at its own label and left
          // four bands where there are two — which filed Guatoque's torniquetes
          // below the lower platform instead of between the two.
          if (r > 180 && g > 150 && b < 120 && r - b > 90 && g - b > 70) { pale++; continue; }
          if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12) continue;
          if (r >= 222 && r <= 250) pale++;
        }
        counts.push(pale);
      }
      // A deck row is a stretch of page where platform grey runs most of the
      // drawing's width. A bridge is narrow, so it never reaches the cut.
      const cut = (span.x1 - span.x0) * 0.3;
      const bands = [];
      let start = -1;
      for (let y = 0; y <= height; y++) {
        const on = y < height && counts[y] >= cut;
        if (on && start < 0) start = y;
        if (!on && start >= 0) { bands.push({ y0: start, y1: y - 1 }); start = -1; }
      }
      return bands.filter((b) => b.y1 - b.y0 >= 8);
    },
    { b64, span }
  );
}

/** Run-length encode a profile, dropping runs too thin to be a column. */
function runsOf(prof, min) {
  const runs = [];
  let i = 0;
  while (i < prof.length) {
    let j = i;
    while (j < prof.length && prof[j].c === prof[i].c) j++;
    runs.push({ c: prof[i].c, x0: i, x1: j - 1, w: j - i, pale: prof.slice(i, j).map((p) => p.pale) });
    i = j;
  }
  // A hairline white border inside the drawing is not a gap in it: Calle 57
  // separates its decks from its crossings with a 7px white rule, and taking
  // those at face value cut the plan into five pieces.
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    const absorb = () => {
      prev.x1 = r.x1;
      prev.w = prev.x1 - prev.x0 + 1;
      prev.pale = prev.pale.concat(r.pale);
    };
    // Anything too thin to be a column belongs to the column before it —
    // whatever it is made of. Absorbing only the white ones left a one-pixel
    // hairline of footprint standing between two halves of the same platform;
    // it was too narrow to survive the filter below, but while it was there the
    // two halves could not merge, and the drawing gained a phantom vagón for
    // every deck the sheet drew a seam across. Gobernación grew two.
    if (r.w < min && prev) { absorb(); continue; }
    if (prev && prev.c === r.c) { absorb(); continue; }
    merged.push({ ...r });
  }
  // How much platform grey a column actually holds, taken as the median down
  // the run so a few stray pixels — the antialiased edge of a service chip
  // sitting above the drawing — cannot pass for a column of it. Reading the
  // topmost and bottommost pale pixel instead made every run the same height
  // and hid both of Av. Chile's bridges.
  for (const r of merged) {
    const v = r.pale.filter((n) => n > 0).sort((a, b) => a - b);
    r.deep = v.length ? v[Math.floor(v.length / 2)] : 0;
  }
  return merged.filter((r) => r.w >= min || r.c === '.');
}

/**
 * The plates, exactly as `planos.mjs` finds them — collinear yellow bars, all
 * one size per sheet. Kept in step with that file on purpose: the two tools
 * have to agree about how many vagones a sheet prints, or the furniture will
 * be hung on a platform count nothing else believes.
 */
function platesOf(blobs, height) {
  const bars = blobs.filter((b) => b.px > 250 && b.h >= 8 && b.w / b.h >= 3 && b.w / b.h <= 9);
  if (bars.length === 0) return [];
  const tol = Math.max(8, height * 0.03);
  const like = (a, b) => Math.abs(a.w - b.w) / b.w <= 0.25 && Math.abs(a.h - b.h) / b.h <= 0.15;
  const bandOf = (b) => bars.filter((o) => Math.abs(o.y - b.y) <= tol && like(o, b));
  let best = null;
  for (const seed of bars) {
    const band = bandOf(seed);
    const w = band.reduce((t, b) => t + b.w, 0) / band.length;
    const h = band.reduce((t, b) => t + b.h, 0) / band.length;
    if (!best || band.length > best.band.length || (band.length === best.band.length && w > best.w)) {
      best = { band, w, h };
    }
  }
  const rowed = best.band.length >= 2;
  return bars
    .filter((b) => {
      const dw = Math.abs(b.w - best.w) / best.w;
      const dh = Math.abs(b.h - best.h) / best.h;
      if (dw > 0.25 || dh > 0.25) return false;
      return rowed ? bandOf(b).length >= 2 : dw <= 0.12 && dh <= 0.12;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** y-clusters of plates = the platforms drawn one above the other. */
function rowsOf(plates, height) {
  const tol = Math.max(8, height * 0.03);
  const rows = [];
  for (const p of plates) {
    const row = rows.find((r) => Math.abs(r.y - p.y) <= tol);
    if (row) { row.items.push(p); row.y = (row.y * (row.items.length - 1) + p.y) / row.items.length; }
    else rows.push({ y: p.y, items: [p] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => a.y - b.y);
}

/**
 * Crop, upscale, optionally binarise, and OCR — never the whole page.
 *
 * `crop.mjs` exists because Windows OCR skips small text on a busy page; the
 * same cell read in isolation and enlarged comes back cleanly. That holds here
 * and is what makes the vagón número readable at all, which a full-page pass
 * in `planos.mjs` measured as hopeless.
 */
/**
 * Crop, upscale, optionally binarise — and save, rather than read.
 *
 * `crop.mjs` exists because Windows OCR skips small text on a busy page; the
 * same cell read in isolation and enlarged comes back cleanly. That is what
 * makes the vagón número readable at all, which a full-page pass in
 * `planos.mjs` measured as hopeless.
 */
async function renderCrop(page, file, box, zoom, mode, out) {
  const b64 = readFileSync(file).toString('base64');
  const url = await page.evaluate(
    async ({ b64, box, zoom, mode }) => {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(box.w * zoom));
      cv.height = Math.max(1, Math.round(box.h * zoom));
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, cv.width, cv.height);
      if (mode !== 'raw') {
        const d = ctx.getImageData(0, 0, cv.width, cv.height);
        for (let i = 0; i < d.data.length; i += 4) {
          const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
          let v = mode === 'invert' ? 255 - lum : lum;
          if (mode !== 'plain') v = v < 128 ? 0 : 255;
          d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
          d.data[i + 3] = 255;
        }
        ctx.putImageData(d, 0, 0);
      }
      return cv.toDataURL('image/png');
    },
    { b64, box, zoom, mode }
  );
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
}

/**
 * OCR a directory in one go.
 *
 * Per-image `ocr.ps1` spends nearly all its time starting PowerShell, and a
 * sheet asks for two dozen crops. Batching turned a run of 150 sheets from
 * hours into minutes; nothing about the recognition itself changed.
 */
function ocrDir(dir) {
  const out = `${dir}.json`;
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'ocr_batch.ps1',
      '-Dir', dir, '-Out', out], { stdio: 'pipe' });
    return JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Read one box several ways and let them vote.
 *
 * No single (zoom, preprocessing) pair reads every plate. On Av. Chile — 88x17
 * bars, the dense case — raw at 10x got five of six and binarised at 4x got the
 * sixth, and each missed one the other found. Pooling them read all six, so the
 * battery is the method rather than a fallback.
 */
const VARIANTS = [
  ['raw', 6], ['raw', 10], ['binary', 4], ['binary', 12],
];
const STREET_VARIANTS = [
  ['plain', 6], ['plain', 14], ['invert', 6], ['invert', 14],
];

function tally(texts, pick) {
  const counts = new Map();
  for (const t of texts) {
    const v = pick(t ?? '');
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { value: null, votes: 0, rival: 0 };
  return { value: ranked[0][0], votes: ranked[0][1], rival: ranked[1]?.[1] ?? 0 };
}

// One digit, never two. A plate prints its número twice — Vagon 2 / Wagon 2 —
// and where the OCR runs the pair together it comes back as "Vagón 21 2",
// which a two-digit pattern read as vagón 21. No sheet numbers a vagón past 6.
const pickVagon = (t) => {
  const m = /vag[oóaú0-9]{0,3}n?\W{0,3}([1-9])/i.exec(t.replace(/\s+/g, ' '));
  return m ? m[1] : null;
};

// A street name is a word and a number — `Carrera 27`, `Calle 72`. Anything
// without both is the OCR reading the tab's own furniture rather than a street.
const pickStreet = (t) => {
  const s = t.replace(/\s+/g, ' ').trim();
  return /^[A-Za-zÁÉÍÓÚÑáéíóúñ.]{3,}(\s+[A-Za-zÁÉÍÓÚÑáéíóúñ.]+)*\s+\d{1,3}[A-Za-z]?( Sur| Bis)?$/.test(s) ? s : null;
};

const GRIDS = [6, 8, 10, 12];
const LEGEND_ORDER = ['taquilla', 'torniquete', 'rampa', 'escalera', 'emergencia', 'ascensor', 'bici', 'cable', 'zonal'];
const LEGEND_MATCH = [
  [/taquill/i, 'taquilla'],
  [/torni/i, 'torniquete'],
  [/rampa/i, 'rampa'],
  [/escaler/i, 'escalera'],
  [/emergenc/i, 'emergencia'],
  [/ascens/i, 'ascensor'],
  [/bici/i, 'bici'],
  [/[c(]able/i, 'cable'],
  [/z[oc]nal/i, 'zonal'],
];

/**
 * Reduce a glyph to a 12x12 ink silhouette, so two drawings of the same symbol
 * compare regardless of size or polarity.
 *
 * The key prints its icons grey on white and the plan prints them white on
 * black, so neither the colour nor its sign can be compared directly — only
 * the shape. Both are tightened to their ink before scaling, because the plan's
 * black tile is a good deal bigger than the symbol inside it and the key's is
 * not.
 */
async function silhouette(page, file, box, polarity, N = 12) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(
    async ({ b64, box, polarity, N }) => {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data, width } = ctx.getImageData(0, 0, cv.width, cv.height);
      const lum = (x, y) => {
        const i = (y * width + x) * 4;
        return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      };
      // `dark` for the key (grey on white), `light` for the plan (white on a
      // black tile). Either way "ink" means the symbol, not its ground.
      //
      // Two rows of the key break that rule: Salida de Emergencia and Ascensor
      // Prioritario are printed as a SOLID green and blue tile with the symbol
      // knocked out in white, so read as dark-on-light they came back as filled
      // squares. Two identical filled squares then sat at the same distance
      // from every tile nobody could name, and a hundred unnamed tiles across
      // the run reported "emergencia 0.34, ascensor 0.34" — a tie between two
      // shapes that were not shapes. So the polarity is checked, not assumed:
      // ink covering nearly the whole box means the ground was measured, and
      // the symbol is the other one.
      let dark = polarity === 'dark';
      if (dark) {
        let on = 0, all = 0;
        for (let y = box.y; y < box.y + box.h; y++) {
          for (let x = box.x; x < box.x + box.w; x++) { all++; if (lum(x, y) < 205) on++; }
        }
        if (all && on / all > 0.7) dark = false;
      }
      const ink = (x, y) => (dark ? lum(x, y) < 205 : lum(x, y) > 150);

      // Trim a plan tile to its own black ground before reading the symbol off
      // it. The tile is drawn touching the platform's black edge line, so the
      // two come back as ONE component and the box runs off along the line —
      // and since everything beyond the tile is pale, that pale ran straight
      // into the symbol's silhouette. Five stations on the Calle 26 template
      // lost both taquillas to it. A column belongs to the tile only if its
      // dark ground is nearly as tall as the tile; the edge line is a few
      // pixels and never is.
      let X0 = box.x, X1 = box.x + box.w - 1, Y0 = box.y, Y1 = box.y + box.h - 1;
      if (!dark) {
        const tall = [];
        for (let x = X0; x <= X1; x++) {
          let n = 0;
          for (let y = Y0; y <= Y1; y++) if (lum(x, y) < 205) n++;
          if (n >= box.h * 0.5) tall.push(x);
        }
        if (tall.length >= 3) { X0 = tall[0]; X1 = tall[tall.length - 1]; }
        const wide = [];
        for (let y = Y0; y <= Y1; y++) {
          let n = 0;
          for (let x = X0; x <= X1; x++) if (lum(x, y) < 205) n++;
          if (n >= (X1 - X0 + 1) * 0.5) wide.push(y);
        }
        if (wide.length >= 3) { Y0 = wide[0]; Y1 = wide[wide.length - 1]; }
      }
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      for (let y = Y0; y <= Y1; y++) {
        for (let x = X0; x <= X1; x++) {
          if (!ink(x, y)) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return null;
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      
      const cell = [];
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          let on = 0, total = 0;
          const sx = x0 + Math.floor((gx * w) / N), ex = x0 + Math.max(Math.floor(((gx + 1) * w) / N), Math.floor((gx * w) / N) + 1);
          const sy = y0 + Math.floor((gy * h) / N), ey = y0 + Math.max(Math.floor(((gy + 1) * h) / N), Math.floor((gy * h) / N) + 1);
          for (let y = sy; y < ey; y++) for (let x = sx; x < ex; x++) { total++; if (ink(x, y)) on++; }
          cell.push(total && on / total >= 0.4 ? 1 : 0);
        }
      }
      return { grid: cell, box: { x: x0, y: y0, w, h } };
    },
    { b64, box, polarity, N }
  );
}

const distance = (a, b) => a.reduce((t, v, i) => t + (v === b[i] ? 0 : 1), 0);

/** The same silhouette flipped left-to-right. */
function mirror(grid, n) {
  const out = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out.push(grid[y * n + (n - 1 - x)]);
  return out;
}

/** Where the Convenciones key is, and how much to enlarge it to read it. */
function legendBox(planX0, height) {
  return {
    region: { x: 0, y: Math.round(height * 0.2), w: Math.max(40, planX0 - 6), h: Math.round(height * 0.8) },
    zooms: height > 800 ? [2, 3] : [4, 6],
  };
}

/**
 * The sheet's own Convenciones key: where each symbol is drawn, and its name.
 *
 * Matching plan tiles against artwork from the SAME sheet sidesteps the two
 * things that would otherwise have to be assumed — the drawing scale, which
 * differs between the 1024 and 1920 templates, and the symbol set, which a
 * station without a TransMiCable connection does not print in full.
 */
async function legendFrom(page, file, passes, region) {
  // Pooled across zooms. One pass is unreliable — Calle 106 gave up only two of
  // the nine rows — and the pitch that places the rest is only as good as the
  // rows it is measured from.
  const hits = [];
  for (const { lines, zoom } of passes) {
    for (const line of lines ?? []) {
      const w0 = line.words?.[0];
      if (!w0) continue;
      const y = region.y + w0.y / zoom;
      const x = region.x + w0.x / zoom;
      for (const [re, name] of LEGEND_MATCH) {
        if (!re.test(line.text)) continue;
        if (hits.some((h) => h.name === name)) continue;
        hits.push({ name, y, labelX: x });
      }
    }
  }
  if (hits.length < 2) return [];
  hits.sort((a, b) => a.y - b.y);

  // The key is evenly spaced, so two rows fix the pitch and every row the OCR
  // garbled can be placed from that rather than dropped. `Conexión con servicio
  // zonal` comes back as `pn,'icio zcnal` on the dense template.
  const idx = (name) => LEGEND_ORDER.indexOf(name);
  const spans = [];
  for (let i = 1; i < hits.length; i++) {
    const d = idx(hits[i].name) - idx(hits[i - 1].name);
    if (d > 0) spans.push((hits[i].y - hits[i - 1].y) / d);
  }
  if (spans.length === 0) return [];
  const pitch = spans.sort((a, b) => a - b)[Math.floor(spans.length / 2)];
  // How wide the symbol column is, taken from the row pitch. The key is laid
  // out to one rhythm — the symbol runs about 1.2 pitches and the label starts
  // at about 2.1 — so the pitch places it on both templates. Taking it from the
  // OCR's own word box does not: at Calle 106 the first word came back at the
  // symbol's own x, which cropped every symbol to its left edge and left four
  // plainly-drawn taquillas unnamed.
  const wordX = Math.min(...hits.map((h) => h.labelX));
  const labelX = wordX - region.x > pitch * 1.5 ? Math.min(wordX, region.x + pitch * 2.1) : region.x + pitch * 2.1;
  const base = hits[0].y - idx(hits[0].name) * pitch;

  const out = [];
  for (const [i, name] of LEGEND_ORDER.entries()) {
    const y = base + i * pitch;
    if (y < region.y || y > region.y + region.h) continue;
    const box = {
      x: Math.max(0, Math.round(region.x)),
      y: Math.round(y - pitch * 0.15),
      w: Math.max(6, Math.round(labelX - region.x - pitch * 0.15)),
      h: Math.max(6, Math.round(pitch * 0.85)),
    };
    // Kept at several grids. A tile drawn 14px across on a dense sheet cannot
    // carry a 12x12 silhouette — the scaling noise swamped the shape and left
    // Av. Chile's taquillas unnamed — so each tile is compared at a grid its
    // own size supports, and the key has to offer one to compare against.
    const grids = {};
    for (const n of GRIDS) {
      const sil = await silhouette(page, file, box, 'dark', n);
      if (sil) grids[n] = sil.grid;
    }
    if (Object.keys(grids).length) out.push({ name, grids, box, ocr: hits.some((h) => h.name === name) });
  }
  return out;
}

/**
 * The drawing's own extent, told from the legend and the page margin beside it.
 *
 * Taken as the widest unbroken stretch of ink that holds the plates, rather
 * than as a fixed fraction of the page: the legend is 180px wide on the 1024
 * template and 400px on the 1920 one, and a station drawn short leaves a lot of
 * white between the two.
 */
function planSpan(runs, plates) {
  const groups = [];
  let cur = null;
  for (const r of runs) {
    if (r.c === '.') { cur = null; continue; }
    if (!cur) { cur = { runs: [] }; groups.push(cur); }
    cur.runs.push(r);
  }
  let best = null;
  for (const g of groups) {
    const x0 = g.runs[0].x0, x1 = g.runs[g.runs.length - 1].x1;
    const held = plates.filter((p) => p.x >= x0 - 4 && p.x + p.w <= x1 + 4).length;
    if (!best || held > best.held || (held === best.held && x1 - x0 > best.x1 - best.x0)) {
      best = { held, x0, x1, runs: g.runs };
    }
  }
  return best;
}

/**
 * Which band a piece of furniture is filed under.
 *
 * Two decks: above the upper one, between them, below the lower one. One deck:
 * the middle band IS the platform, since there is nothing to be between.
 */
function bandOf(y, bands) {
  if (bands.length >= 2) {
    if (y < bands[0].y1) return 'arriba';
    if (y > bands[1].y0) return 'abajo';
    return 'centro';
  }
  const only = bands[0];
  if (y < only.y0) return 'arriba';
  if (y > only.y1) return 'abajo';
  return 'centro';
}

/**
 * Which way a Salida tab points.
 *
 * The tab prints a solid triangle at the end it leads to. Text is on the tab
 * too and is just as dark, so the triangle is told from it by SOLIDITY — it
 * fills most of the tab's height in a single column, and no letter does.
 */
async function salidaHacia(page, file, tab) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(
    async ({ b64, tab }) => {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data, width } = ctx.getImageData(0, 0, cv.width, cv.height);
      const dark = (x, y) => {
        const i = (y * width + x) * 4;
        return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 120;
      };
      const solid = (x0, x1) => {
        let best = 0;
        for (let x = x0; x <= x1; x++) {
          let n = 0;
          for (let y = tab.y + 1; y < tab.y + tab.h - 1; y++) if (dark(x, y)) n++;
          best = Math.max(best, n / Math.max(1, tab.h - 2));
        }
        return best;
      };
      const edge = Math.max(2, Math.round(tab.w * 0.22));
      return { left: solid(tab.x, tab.x + edge), right: solid(tab.x + tab.w - edge, tab.x + tab.w - 1) };
    },
    { b64, tab }
  );
}

/** One sheet → a draft `detalle`, and everything that stopped it being surer. */
async function readSheet(page, file, code) {
  const notes = [];
  const seg = await segment(page, file);
  const { width, height, yellows, blacks } = seg;

  const plates = platesOf(yellows, height);
  if (plates.length === 0) return { notes: ['no vagón plates found — nothing to hang furniture on'] };
  const rows = rowsOf(plates, height);

  const pad = Math.round(height * 0.11);
  const band = {
    y0: Math.max(0, Math.min(...plates.map((p) => p.y)) - pad),
    y1: Math.min(height - 1, Math.max(...plates.map((p) => p.y + p.h)) + pad),
  };
  // The structure is read inside the platform band and the depth outside it,
  // so a bridge — which is drawn taller than any platform because it crosses
  // the road the station sits in — has somewhere to show that.
  const wide = Math.round(height * 0.3);
  const prof = await profile(page, file, band, {
    y0: Math.max(0, band.y0 - wide),
    y1: Math.min(height - 1, band.y1 + wide),
  });
  const minRun = Math.max(4, Math.round(width * 0.008));
  const span = planSpan(runsOf(prof, minRun), plates);
  if (!span) return { notes: ['no drawing found'] };

  // What the profile actually saw, for the pass where a person checks a draft
  // against the sheet. Set DEBUG=1.
  if (process.env.DEBUG) {
    console.error('  ' + code + ' span ' + span.x0 + '..' + span.x1);
    console.error('  runs  ' + span.runs.map((r) => r.c + r.x0 + '-' + r.x1 + ' deep=' + r.deep).join('  '));
    console.error('  plates ' + plates.map((p) => p.x + ',' + p.y + ' ' + p.w + 'x' + p.h).join('  '));
  }


  // A deck is a pale run with a plate on it. Every other pale run is something
  // else the sheet draws in the platform's own grey — a bridge deck, or the
  // pad a torniquete sits on — and only the plate separates them.
  // A plate belongs to a deck it OVERLAPS, not one it is centred on. Boyacá
  // draws two platforms with a single `Vagón 1` between them, and the centre
  // of that plate lands in the seam — so the centre test found no platform at
  // all and the sheet came back unreadable.
  const over = (r, p) => {
    const lap = Math.min(r.x1, p.x + p.w - 1) - Math.max(r.x0, p.x) + 1;
    return lap >= Math.min(p.w, r.w) * 0.2;
  };
  const decks = span.runs.filter((r) => r.c === 'P' && plates.some((p) => over(r, p)));
  if (decks.length === 0) return { notes: ['plates found but none sits on a platform'] };
  const deckH = Math.max(...decks.map((r) => r.deep));
  const deckW = Math.max(...decks.map((r) => r.w));

  for (const r of span.runs) {
    r.kind = decks.includes(r)
      ? 'deck'
      // Depth tells a bridge from a platform — except where the platforms are
      // themselves drawn nearly full height, as Calle 187's are, and the ratio
      // has nowhere to move. There the position settles it: platform grey at
      // the very edge of the drawing, carrying no plate and too narrow to be a
      // platform, is the bridge onto the station. A vestibule is never drawn in
      // platform grey, so nothing else can be mistaken for one.
      : r.c === 'P' && r.w < deckW * 0.6 &&
        (r.deep > deckH * 1.2 || r === span.runs[0] || r === span.runs[span.runs.length - 1])
        ? 'puente'
        : 'foot';
  }

  // A plate names ONE platform, even where it is drawn across two. Where the
  // sheet leaves the second unlabelled — Boyacá does — the second is still a
  // platform and still gets a column; it just gets no número, and says so.
  const plateDeck = new Map();
  for (const p of plates) {
    const lap = (r) => Math.min(r.x1, p.x + p.w - 1) - Math.max(r.x0, p.x) + 1;
    const best = decks.filter((r) => over(r, p)).sort((a, b) => lap(b) - lap(a))[0];
    if (best) plateDeck.set(p, best);
  }

  const bands = await deckRows(page, file, span);
  if (bands.length === 0) return { notes: ['platform bands not found — nothing to file furniture under'] };

  // The equipment: near-square black tiles standing INSIDE the drawing. The
  // service chips are the same black and often the same size, and sit in the
  // rows above and below it — which is the only thing that separates them, so
  // the platforms' own vertical extent is what decides.
  const top = bands[0].y0;
  const bot = bands[bands.length - 1].y1;
  // A tile sharing a column with a plate is a service chip, not equipment: the
  // chips stack directly above and below the plate they belong to. Ruling out
  // the whole deck COLUMN instead was too blunt — Tygua draws the strip its
  // torniquetes stand in in platform grey, so it reads as deck, and all four
  // were thrown away as chips.
  const onPlate = (b) => plates.some(
    (p) => b.x < p.x + p.w && b.x + b.w > p.x && Math.abs((b.x + b.w / 2) - (p.x + p.w / 2)) < p.w * 0.5
  );
  // The arrow printed on a Salida tab is black, small and square, and is not a
  // piece of equipment — it is part of the tab, and the tab is read separately.
  const onTab = (b) => yellows.some(
    (y) => b.x < y.x + y.w && b.x + b.w > y.x && b.y < y.y + y.h && b.y + b.h > y.y
  );
  const tiles = blacks.filter((b) => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const ratio = b.w / b.h;
    return cx >= span.x0 && cx <= span.x1 && cy > top && cy < bot &&
      ratio > 0.55 && ratio < 1.8 && b.w > minRun && !onPlate(b) && !onTab(b);
  });

  // The Salida tabs: yellow, but never a plate, and each carries a black box
  // under it naming the street. The box is what confirms the tab — a legend
  // swatch is yellow too and has nothing beneath it.
  // Inside the drawing, vertically as well as across. The station name runs in
  // a coloured masthead at the top of every sheet, and on the orange templates
  // — Biblioteca, Parque — that masthead reads as one enormous yellow tab.
  const tall = (bands[bands.length - 1].y1 - bands[0].y0) * 0.35;
  const tabs = yellows.filter(
    (b) => !plates.includes(b) &&
      b.x + b.w / 2 >= span.x0 && b.x + b.w / 2 <= span.x1 &&
      b.y + b.h / 2 > bands[0].y0 - tall && b.y + b.h / 2 < bands[bands.length - 1].y1 + tall &&
      b.w / b.h >= 1.6
  );
  const streetBox = (tab) =>
    blacks.find(
      (b) => b.y > tab.y && b.y - (tab.y + tab.h) < tab.h * 1.2 && Math.abs(b.x - tab.x) < tab.w * 0.4 && b.w > tab.w * 0.5
    );

  // Every crop this sheet needs, rendered before a single one is read. The OCR
  // then runs once for the whole sheet instead of once per crop, which is the
  // difference between this finishing in minutes and in hours.
  const dir = '_out/' + code;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const jobs = [];
  const leg = legendBox(span.x0, height);
  for (const z of leg.zooms) await renderCrop(page, file, leg.region, z, 'plain', dir + '/legend' + z + '.png');
  for (const [i, p] of plates.entries()) {
    for (const [mode, zoom] of VARIANTS) {
      const name = 'plate' + i + '_' + mode + zoom + '.png';
      await renderCrop(page, file, { x: p.x - 2, y: p.y - 2, w: p.w + 4, h: p.h + 4 }, zoom, mode, dir + '/' + name);
      jobs.push({ kind: 'plate', i, name });
    }
  }
  for (const [i, tab] of tabs.entries()) {
    const box = streetBox(tab);
    if (!box) continue;
    for (const [mode, zoom] of STREET_VARIANTS) {
      const name = 'street' + i + '_' + mode + zoom + '.png';
      await renderCrop(page, file, { x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 }, zoom, mode, dir + '/' + name);
      jobs.push({ kind: 'street', i, name });
    }
  }
  const read = ocrDir(dir);
  const textOf = (name) => (read[name]?.lines ?? []).map((l) => l.text).join(' ');
  const textsFor = (kind, i) => jobs.filter((j) => j.kind === kind && j.i === i).map((j) => textOf(j.name));

  const legend = await legendFrom(page, file, leg.zooms.map((z) => ({ zoom: z, lines: read['legend' + z + '.png']?.lines })), leg.region);
  if (legend.length === 0) notes.push('legend unreadable — equipment left unnamed');
  if (process.env.DEBUG) console.error('  tiles ' + JSON.stringify(tiles.map((t) => [t.x, t.y, t.w, t.h])) + ' blacks ' + JSON.stringify(blacks.filter((b) => b.x > span.x0 && b.x < span.x1).map((t) => [t.x, t.y, t.w, t.h])));
  if (process.env.DEBUG) console.error('  legend ' + legend.map((l) => l.name + (l.ocr ? '' : '?') + ' ' + JSON.stringify(l.box)).join('  '));

  const named = new Map();
  for (const t of tiles) {
    if (legend.length === 0) break;
    const n = GRIDS.filter((g) => g <= Math.max(6, Math.min(t.w, t.h) * 0.75)).pop() ?? GRIDS[0];
    const sil = await silhouette(page, file, t, 'light', n);
    if (!sil) continue;
    const ranked = legend
      .filter((l) => l.grids[n])
      // Against the key's artwork AND its mirror. At the right-hand end of a
      // drawing the sheet flips its symbols the same way it flips the block
      // around them — Av. Chile's two taquillas are mirror images — and matched
      // one way only, the flipped one came back as a wheelchair.
      .map((l) => ({
        name: l.name,
        d: Math.min(distance(sil.grid, l.grids[n]), distance(sil.grid, mirror(l.grids[n], n))) / (n * n),
      }))
      .sort((a, b) => a.d - b.d);
    if (ranked.length < 2) continue;
    // Only a CLEAR win is taken: a match barely ahead of its rival is a coin
    // toss, and a coin toss puts a taquilla where the torniquetes are. The
    // margin is what does the work — the absolute distance drifts with the
    // drawing scale, the gap between first and second does not.
    if (ranked[0].d <= 0.34 && ranked[1].d - ranked[0].d >= 0.06) named.set(t, ranked[0].name);
    else notes.push('tile at ' + t.x + ',' + t.y + ' unclassified (best ' + ranked[0].name + ' ' +
      ranked[0].d.toFixed(2) + ', next ' + ranked[1].name + ' ' + ranked[1].d.toFixed(2) + ')');
  }

  const numbers = new Map();
  for (const [i, p] of plates.entries()) {
    const r = tally(textsFor('plate', i), pickVagon);
    if (r.value && r.votes > r.rival) numbers.set(p, r.value);
    else notes.push('plate at ' + p.x + ',' + p.y + ' — número unread' +
      (r.value ? ' (best "' + r.value + '", ' + r.votes + 'v vs ' + r.rival + 'v)' : ''));
  }

  const salidas = [];
  for (const [i, tab] of tabs.entries()) {
    const box = streetBox(tab);
    const r = box ? tally(textsFor('street', i), pickStreet) : { value: null, votes: 0 };
    const calle = r.value && r.votes >= 2 ? r.value : null;
    if (!calle) {
      notes.push('salida at ' + tab.x + ',' + tab.y + ' — street name unread (box ' +
        (box ? box.w + 'x' + box.h : 'not found') + ')');
    }
    const sides = await salidaHacia(page, file, tab);
    const hacia = Math.abs(sides.left - sides.right) < 0.15 ? null : sides.left > sides.right ? 'izq' : 'der';
    salidas.push({ tab, calle, hacia, fila: bandOf(tab.y + tab.h / 2, bands) });
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir + '.json', { force: true });

  return { plates, rows, bands, span, plateDeck, tiles, named, numbers, salidas, notes };
}

/** The read sheet → the `columnas` array `plano_vagones.json` holds. */
function buildColumns(read) {
  const { span, rows, bands, tiles, named, numbers, salidas, plates, plateDeck, notes } = read;
  const order = span.runs.filter((r) => r.kind);
  const deckAt = (r) => plates.filter((p) => plateDeck.get(p) === r);
  const firstDeck = order.findIndex((r) => r.kind === 'deck');
  const deckRuns = order.filter((r) => r.kind === 'deck');
  const decksBefore = (x) => { const d = deckRuns.filter((r) => r.x1 < x); return d.length ? d[d.length - 1].x1 : null; };
  const decksAfter = (x) => { const d = deckRuns.find((r) => r.x0 > x); return d ? d.x0 : null; };
  const lastDeck = order.length - 1 - [...order].reverse().findIndex((r) => r.kind === 'deck');

  /**
   * How far out from an access block its furniture may stand.
   *
   * Not all of it stands ON the block. Tygua and Biblioteca draw the strip
   * holding the torniquetes in PLATFORM grey, so it reads as part of the deck
   * and every torniquete on those sheets fell outside the block and was thrown
   * away in silence. Nothing but the block's own equipment lies between it and
   * the first vagón plate, so the plate is the honest boundary — capped, so a
   * long block cannot reach halfway down a platform for something to claim.
   */
  const catchment = (x0, x1) => {
    const cap = (x1 - x0 + 1) * 1.2;
    const right = plates.filter((p) => p.x > x1).map((p) => p.x - 1);
    const left = plates.filter((p) => p.x + p.w < x0).map((p) => p.x + p.w + 1);
    return [
      left.length ? Math.max(x0 - cap, Math.max(...left)) : x0,
      right.length ? Math.min(x1 + cap, Math.min(...right)) : x1,
    ];
  };

  /** The tiles and salidas standing over a stretch of the drawing. */
  const furniture = (rawX0, rawX1, lado) => {
    const [x0, x1] = catchment(rawX0, rawX1);
    const col = { t: 'vestibulo', salidas: [], arriba: [], centro: [], abajo: [] };
    if (lado === 'der') col.lado = 'der';
    for (const s of salidas) {
      const cx = s.tab.x + s.tab.w / 2;
      if (cx < x0 || cx > x1) continue;
      const entry = { calle: s.calle, fila: s.fila === 'centro' ? 'arriba' : s.fila };
      // A tab with no triangle it could read points the way the block faces,
      // which for a block at either end of the drawing is out of the station.
      entry.hacia = s.hacia ?? (lado === 'der' ? 'der' : 'izq');
      col.salidas.push(entry);
    }
    const mine = tiles.filter((t) => {
      const cx = t.x + t.w / 2;
      return cx >= x0 && cx <= x1 && named.has(t);
    });
    // Left to right, as the sheet draws them, mirrored block or not: the
    // flip that `lado: der` applies is on the BAND, and all the equipment
    // rides inside a single child of it, so the flip never reaches the order
    // of the icons themselves. Checked against the rendered page.
    for (const t of mine) col[bandOf(t.y + t.h / 2, bands)].push(named.get(t));
    if (!col.salidas.length) delete col.salidas;
    return col;
  };

  const columnas = [];
  let i = 0;
  while (i < order.length) {
    const r = order[i];
    if (r.kind === 'deck') {
      const ps = deckAt(r).sort((a, b) => a.y - b.y);
      const col = { t: 'vagones' };
      const rowIndex = (p) => rows.findIndex((row) => row.items.includes(p));
      for (const p of ps) {
        const n = numbers.get(p);
        if (!n) continue;
        if (rowIndex(p) === 0) col.arriba = n;
        else col.abajo = n;
      }
      if (!col.arriba && !col.abajo) {
        notes.push('platform at x ' + r.x0 + '..' + r.x1 + ' carries no número — the sheet may label it with a plate drawn across its neighbour');
      }
      columnas.push(col);
      i++;
      continue;
    }
    // Everything up to the next deck is one stretch of station: a bridge, a
    // vestibule, a plain crossing, or a bridge with a vestibule each side.
    let j = i;
    while (j < order.length && order[j].kind !== 'deck') j++;
    const stretch = order.slice(i, j);
    const inner = i > firstDeck && j <= lastDeck;

    // Which way an access block faces, from the side its platform is on: with
    // the platform to its LEFT the block is mirrored, because the end nearest
    // the platform is where the sheet puts the equipment and the way through,
    // and the exit then points out to the right. True at either end of a
    // drawing and equally true either side of a bridge in the middle of one,
    // so it is asked as one question — where is the nearest deck — rather than
    // as two rules that disagreed with each other.
    const ladoFor = (x0, x1) => {
      const left = decksBefore(x0), right = decksAfter(x1);
      if (left == null) return undefined;
      if (right == null) return 'der';
      return x0 - left < right - x1 ? 'der' : undefined;
    };

    // A bridge cuts the stretch: what lies either side of it is its own block.
    const parts = [];
    for (const r of stretch) {
      if (r.kind === 'puente') {
        // Adjacent bridge runs are one bridge. Calle 106 draws its deck in two
        // pieces and drew two bridges side by side out of it.
        const last = parts[parts.length - 1];
        if (last && last.puente) { last.x1 = r.x1; continue; }
        parts.push({ puente: true, x0: r.x0, x1: r.x1 });
        continue;
      }
      const prev = parts[parts.length - 1];
      if (prev && !prev.puente) prev.x1 = r.x1;
      else parts.push({ puente: false, x0: r.x0, x1: r.x1 });
    }

    if (parts.length === 1 && !parts[0].puente) {
      const f = furniture(parts[0].x0, parts[0].x1, ladoFor(parts[0].x0, parts[0].x1));
      const bare = !f.salidas && !f.arriba.length && !f.centro.length && !f.abajo.length;
      // A crossing between two vagones carries no equipment and no exit: it is
      // just the gap a rider walks through. Given furniture, it is a vestibule
      // that happens to sit between two platforms.
      columnas.push(inner && bare ? { t: 'paso' } : f);
    } else {
      for (const p of parts) {
        if (p.puente) { columnas.push({ t: 'puente' }); continue; }
        const f = furniture(p.x0, p.x1, ladoFor(p.x0, p.x1));
        if (f.salidas || f.arriba.length || f.centro.length || f.abajo.length) columnas.push(f);
      }
    }
    i = j;
  }
  for (const c of columnas) {
    if (c.t !== 'vestibulo') continue;
    for (const k of ['arriba', 'centro', 'abajo']) if (c[k].length === 0) delete c[k];
  }
  return columnas;
}

const stored = JSON.parse(readFileSync(PLATES, 'utf8'));
const list = (await markers()).filter((m) => {
  const code = String(m.code).toUpperCase();
  if (only.length) return only.includes(code);
  if (check) return DONE.has(code);
  return !DONE.has(code);
});

const browser = await chromium.launch();
const page = await browser.newPage();
const drafts = {};
const report = [];

for (const m of list) {
  const code = String(m.code).toUpperCase();
  try {
    const file = await imageFor(m);
    const read = await readSheet(page, file, code);
    if (!read.span) {
      report.push({ code, name: m.name, notes: read.notes });
      process.stderr.write('x');
      continue;
    }
    const columnas = buildColumns(read);
    const shape = columnas.map((c) => c.t + (c.lado ? ':' + c.lado : '')).join(' ');
    const oneRow = read.rows.length < 2;
    if (oneRow) {
      read.notes.push(
        'single-row station — the renderer draws a `detalle` into two bands and there is only one, so this needs a layout with both carriageways before it can be used'
      );
    }
    drafts[code] = {
      name: m.name,
      draft: true,
      rows: read.rows.length,
      vagones: read.plates.length,
      shape,
      columnas,
      notes: read.notes,
    };
    report.push({ code, name: m.name, shape, rows: read.rows.length, notes: read.notes, oneRow });
    process.stderr.write(read.notes.length ? '!' : '.');
  } catch (e) {
    report.push({ code, name: m.name, notes: ['ERROR ' + String(e.message).slice(0, 90)] });
    process.stderr.write('x');
  }
}
process.stderr.write('\n');
await browser.close();

if (check) {
  // The only test this tool has: reproduce, from pixels, the two sheets a
  // person read by eye. A shape that does not match is the tool being wrong —
  // those two were checked against the sheet more than once.
  console.log('\nCHECK — against the two read by hand\n');
  for (const code of DONE) {
    const got = drafts[code];
    const want = stored.detalle?.[code];
    if (!got || !want) { console.log(`  ${code}  no draft or no stored answer`); continue; }
    const shapeOf = (cols) => cols.map((c) => c.t + (c.lado ? ':' + c.lado : '')).join(' ');
    const wantShape = shapeOf(want.columnas);
    console.log(`  ${code}  ${got.name}`);
    console.log(`     stored : ${wantShape}`);
    console.log(`     read   : ${got.shape}`);
    console.log(`     shape  : ${wantShape === got.shape ? 'MATCH' : 'DIFFERS'}`);
    for (const [i, c] of got.columnas.entries()) {
      const w = want.columnas[i];
      if (!w) break;
      const fmt = (x) => JSON.stringify({ ...x, t: undefined });
      if (fmt(c) !== fmt(w)) console.log(`     col ${i} (${c.t})\n        stored ${fmt(w)}\n        read   ${fmt(c)}`);
    }
    for (const n of got.notes) console.log(`     · ${n}`);
  }
} else {
  writeFileSync(`${OUT}/detalle_draft.json`, JSON.stringify(drafts, null, 2) + '\n');
  const clean = report.filter((r) => r.shape && !r.notes.length);
  const iffy = report.filter((r) => r.shape && r.notes.length);
  const dead = report.filter((r) => !r.shape);
  console.log(`\n${report.length} sheets — ${clean.length} clean, ${iffy.length} with gaps, ${dead.length} unread\n`);
  const line = (r) => `  ${r.code}  ${String(r.name).slice(0, 28).padEnd(29)} ${r.shape ?? ''}`;
  if (clean.length) {
    console.log(`CLEAN — every column named, every número and street read  (${clean.length})`);
    for (const r of clean) console.log(line(r));
  }
  if (iffy.length) {
    console.log(`\nWITH GAPS — the shape is drafted, the listed parts are not  (${iffy.length})`);
    for (const r of iffy.sort((a, b) => a.notes.length - b.notes.length)) {
      console.log(line(r));
      for (const n of r.notes) console.log(`         · ${n}`);
    }
  }
  if (dead.length) {
    console.log(`\nUNREAD  (${dead.length})`);
    for (const r of dead) console.log(`  ${r.code}  ${r.name} — ${r.notes.join('; ')}`);
  }
  console.log(`\ndrafts → ${OUT}/detalle_draft.json  (nothing else was written)`);
}
