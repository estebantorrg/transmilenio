// Station planos → how many vagones the sheet prints, and in what shape.
//
//   node planos.mjs            # every station not already read by hand
//   node planos.mjs TM0059 …   # just these
//   node planos.mjs --all      # include the hand-read ones (that is the test)
//
// WHY THIS EXISTS
//
// `server/src/data/plano_vagones.json` gates the vagón numbering: a station is
// numbered only where the catalog's lettered-wagon count equals the plate count
// counted off its official plano. Eight sheets were read by hand on 2026-08-28
// and seven counts were wrong — and two of those (La Castellana, Calle 85) were
// worse than wrong, because the bad count happened to EQUAL the wagon count, so
// the gate passed and the page published a vagón number that sends a rider to a
// platform they do not board.
//
// Those stations look correct from every dataset we hold. The catalog, the
// register and the recorrido coordinates all agree with each other and all
// undercount; only the sheet knows. That was measured, not assumed: the ArcGIS
// vagón count mirrors the catalog at both, and every station reports a single
// coordinate across every recorrido, even the two that are physically two
// stations. So the sheets have to be read, and 117 of them is too many by hand.
//
// WHAT IT READS, AND WHY IT DOES NOT OCR
//
// The vagón plates are the only saturated-yellow horizontal bars on the sheet,
// and at one station they are all the same size — five 107×21 bars at Toberín,
// four 77×16 at Calle 85. The other yellow (legend swatch, `Salida` tabs) never
// matches that modal size. So the plates are found by colour and size, and
// their POSITIONS answer the question:
//
//   • one row of N plates            → an ordinary platform of N vagones
//   • two rows whose x line up       → one vagón drawn once per carriageway;
//                                      Av. Chile prints 6 bars for 3 vagones
//   • two rows whose x do NOT line up → staggered platforms (La Castellana)
//
// Reading the número was tried and abandoned. These images are published only
// at 1024×576 (there is no un-optimised variant — every other path 404s), which
// leaves ~4px per character on a plate. A full-page pass found two of La
// Castellana's four plates and got worse with zoom, exactly as `FINDINGS.md`
// measured for the plegables. Geometry answers the question the dataset asks;
// the número does not need to be guessed to answer it.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It writes nothing. It prints a ranked proposal for a person to confirm,
// because two things here cannot be settled by pixels:
//   • Las Aguas draws its Aguas–Universidades tunnel mouth in platform styling
//     with a `Vagón 1` plate on it. It is not a platform, no bus calls there,
//     and no rule about boxes can know that.
//   • a count that disagrees with the catalog may mean the count is wrong, or
//     may mean the catalog groups platforms differently (Calle 161; and the
//     merged codes at Av. Jiménez and Ricaurte, which no sheet can reconcile).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const MAPS_API = 'https://tramites.transmilenio.gov.co/station-maps/api/map';
const OUT = '_planos';
const CATALOG = '../../server/src/data/master_catalog.json';
const PLATES = '../../server/src/data/plano_vagones.json';

// Sheets already read by hand. Excluded by default — the point is to find the
// ones nobody has looked at. `--all` re-checks them, which is how this tool is
// validated: it has to reproduce what the eye found.
const READ_BY_HAND = new Set([
  'TM0046', 'TM0103', 'TM0028', 'TM0061', 'TM0121', 'TM0137',
  'TM0139', 'TM0059', 'TM0016', 'TM0018', 'TM90009', 'TM90010', 'TM90011',
]);

// One código covering two physical stations: its plate count can never equal
// its wagon count and no sheet will reconcile them (`VERIFIED_SPLITS`).
const MERGED = new Set(['TM0013', 'TM0069']);

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const only = argv.filter((a) => /^TM\d+$/i.test(a)).map((a) => a.toUpperCase());

mkdirSync(OUT, { recursive: true });

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

/** Every saturated-yellow blob on the sheet, with its bounding box. */
async function yellowBlobs(page, file) {
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

    const yellow = (i) => {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      return r > 180 && g > 150 && b < 120 && r - b > 90 && g - b > 70;
    };

    const seen = new Uint8Array(width * height);
    const blobs = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (seen[p] || !yellow(p * 4)) continue;
        let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
        const stack = [p];
        seen[p] = 1;
        while (stack.length) {
          const q = stack.pop();
          const qx = q % width, qy = (q / width) | 0;
          n++;
          if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
          if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
          for (const r of [q - 1, q + 1, q - width, q + width]) {
            if (r < 0 || r >= width * height || seen[r]) continue;
            if (Math.abs((r % width) - qx) > 1) continue;
            if (!yellow(r * 4)) continue;
            seen[r] = 1;
            stack.push(r);
          }
        }
        blobs.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, px: n });
      }
    }
    return { width, height, blobs };
  }, { b64 });
}

/**
 * The plates: the bars that lie along a platform, plus any the same size.
 *
 * Two properties hold on every sheet and neither is enough alone.
 *
 * Plates are **collinear** — they run along the platform, so they share a y.
 * That is what separates them from Bicentenario's `Piso 1` / `Piso 2` labels,
 * which are yellow, wider than a plate, and scattered around its intermodal
 * building. Width alone picked those and reported one vagón out of three.
 *
 * Plates are also **the same size as each other**, which is what recovers the
 * second platform of a staggered station: La Castellana draws its two rows at
 * slightly different scales (67px and 78px) so only one of them wins the row
 * vote, and the other is admitted by matching that size within a quarter. The
 * `Salida` tabs never come close — 67 against 107 at Toberín, 79 against 149 at
 * Las Aguas, 36 against 88 at Av. Chile.
 *
 * Taking the most COMMON size was the first attempt and fails twice: it split
 * La Castellana's two scales, and at Las Aguas it picked the three `Salida`
 * tabs over the two real plates on sheer count.
 */
function platesOf(blobs, height) {
  const bars = blobs.filter((b) => b.px > 250 && b.h >= 8 && b.w / b.h >= 3 && b.w / b.h <= 9);
  if (bars.length === 0) return [];

  // The most populated horizontal band decides what a plate looks like here.
  const tol = Math.max(8, height * 0.03);
  // A band is bars on one line that are also the same size as each other — a
  // row of plates. Without the size test, Bicentenario's `Piso 1` label pairs
  // with the `Zona Llegada de pasajeros` banner 17px below it and the two admit
  // each other as a platform.
  const bandOf = (b) =>
    bars.filter((o) => Math.abs(o.y - b.y) <= tol && Math.abs(o.w - b.w) / b.w <= 0.25);
  let best = null;
  for (const seed of bars) {
    const band = bandOf(seed);
    const width = band.reduce((t, b) => t + b.w, 0) / band.length;
    if (!best || band.length > best.band.length || (band.length === best.band.length && width > best.width)) {
      best = { band, width };
    }
  }

  // A near-exact size match is a plate wherever it sits. A looser one has to
  // earn it by lying in a row with another bar, which is what a second platform
  // does and what a stray label does not: Bicentenario's `Piso 1` and `Piso 2`
  // are within 17% of its plates but sit alone, while La Castellana's second
  // platform is 14% off and comes as a pair.
  return bars
    .filter((b) => {
      const off = Math.abs(b.w - best.width) / best.width;
      return off <= 0.12 || (off <= 0.25 && bandOf(b).length >= 2);
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** y-clusters = platforms drawn one above the other. */
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
 * Do the rows sit above one another, or beside?
 *
 * Aligned means the sheet draws each vagón once per carriageway and the numbers
 * repeat down the page — six bars, three vagones. Unaligned means the platforms
 * are staggered along the street and every bar is its own vagón.
 */
function rowsAligned(rows) {
  if (rows.length < 2) return false;
  const [a, b] = rows;
  if (a.items.length !== b.items.length) return false;
  const tol = Math.max(12, a.items[0].w * 0.4);
  return a.items.every((p, i) => Math.abs(p.x - b.items[i].x) <= tol);
}

const cat = JSON.parse(readFileSync(CATALOG, 'utf8'));
const stored = JSON.parse(readFileSync(PLATES, 'utf8')).counts;

const list = (await markers()).filter((m) => {
  if (only.length) return only.includes(String(m.code).toUpperCase());
  if (MERGED.has(m.code)) return false;
  return all || !READ_BY_HAND.has(m.code);
});

const browser = await chromium.launch();
const page = await browser.newPage();
const report = [];

for (const m of list) {
  const code = String(m.code).toUpperCase();
  try {
    const file = await imageFor(m);
    const { blobs, height } = await yellowBlobs(page, file);
    const plates = platesOf(blobs, height);
    const rows = rowsOf(plates, height);
    const aligned = rowsAligned(rows);
    // Aligned rows repeat the same vagones, so the distinct count is one row's.
    const printed = aligned ? rows[0].items.length : plates.length;
    const staggered = rows.length > 1 && !aligned;

    const station = cat.stations[code];
    const wagons = Object.keys(station?.wagons ?? {}).filter((k) => /^[A-Z]$/i.test(k)).length;
    const has = stored[code];

    // Portals key their platforms `T1`/`T6B` and TransMiCable has none at all,
    // so neither carries lettered wagons and neither is numbered by the gate
    // this tool exists to protect. Their sheets are a different drawing.
    if (wagons === 0) {
      report.push({ code, name: m.name, skipped: 'no lettered wagons (portal or cable)', flags: [] });
      process.stderr.write('-');
      continue;
    }

    const flags = [];
    // The shape that publishes a WRONG vagón number rather than withholding
    // one: more platforms printed than the catalog can name.
    if (wagons && printed > wagons) flags.push(`prints ${printed} vagones, catalog has ${wagons} wagons`);
    if (wagons && printed < wagons && printed > 0) flags.push(`prints ${printed}, catalog has ${wagons}`);
    if (staggered) flags.push('staggered platforms');
    if (printed > 0 && has !== undefined && printed !== has) flags.push(`stored count ${has}`);
    if (plates.length === 0) flags.push('no plates found');

    report.push({ code, name: m.name, printed, plates: plates.length, rows: rows.length, aligned, staggered, wagons, stored: has, flags });
    process.stderr.write(flags.length ? '!' : '.');
  } catch (e) {
    report.push({ code, name: m.name, error: String(e.message).slice(0, 60), flags: ['unreadable'] });
    process.stderr.write('x');
  }
}
process.stderr.write('\n');
await browser.close();

const flagged = report.filter((r) => r.flags.length && !r.error);
const failed = report.filter((r) => r.error);
const clean = report.filter((r) => !r.flags.length);

console.log(`\n${report.length} sheets — ${flagged.length} flagged, ${clean.length} ordinary, ${failed.length} unreadable\n`);
const rank = (r) => (r.staggered ? 0 : 1) + (r.printed > r.wagons ? 0 : 1);
for (const r of flagged.sort((a, b) => rank(a) - rank(b) || b.printed - a.printed)) {
  console.log(`${r.code}  ${String(r.name).slice(0, 32).padEnd(33)} prints=${r.printed} plates=${r.plates} rows=${r.rows}${r.aligned ? ' (aligned)' : ''} wagons=${r.wagons} stored=${r.stored}`);
  console.log(`        ${r.flags.join(' · ')}`);
}
if (failed.length) {
  console.log('\nUNREADABLE');
  for (const r of failed) console.log(`  ${r.code}  ${r.name} — ${r.error}`);
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`\nfull report → ${OUT}/report.json`);
