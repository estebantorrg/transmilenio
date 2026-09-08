import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The renderer itself — the same module the app and the prerender both call, so
// a drawing can be produced here without a browser or a catalog.
import { buildSheetPlano } from '../shared/plano.js';

/**
 * The station plan (`shared/plano.js`, spec §5.5.6).
 *
 * The drawing is read off TransMilenio's own `plano de ubicación` sheets and
 * stored in `server/src/data/plano_vagones.json`. Two machine checks already
 * guard the DATA — `scripts/ocr/audit.mjs` proves the renderer draws what the
 * data says, `scripts/ocr/sweep.mjs` proves the data says something the catalog
 * agrees with — and both run in CI. Neither can see the third failure, which is
 * the one that keeps happening: the drawing is CORRECT and looks wrong.
 *
 * Three ways it has looked wrong so far, one test each:
 *
 *  · The same URL answered two ways. The prerendered page carries its own copy
 *    of the plan's CSS, inlined because it is read before any stylesheet loads,
 *    and that copy drifted: it drew the deck cells as flex columns with a 26px
 *    floor while the app drew them as a subgrid, styled five kinds of divider
 *    the app had never heard of, and never learned the crossing block at all.
 *  · Decks that did not line up. Every column sized its own bands, so a vagón
 *    carrying two rows of chips pushed its deck down and the vagón beside it
 *    stayed where it was — on one platform, drawn as one platform.
 *  · A drawing wider than the page it sits on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const root = (...parts: string[]): string => join(HERE, '..', ...parts);

const planos = JSON.parse(readFileSync(root('server/src/data/plano_vagones.json'), 'utf8'));
const drawn: string[] = Object.keys(planos.detalle ?? {});

const appCss = readFileSync(root('client/style.css'), 'utf8');
/** The prerender's inlined copy of the same rules, read as text so that pulling
 *  it in costs nothing: the module itself opens the 58 MB catalog. */
const prerenderCss = (() => {
  const src = readFileSync(root('server/src/prerender_seo.ts'), 'utf8');
  const match = /const PRERENDER_STYLE = `<style>([\s\S]*?)<\/style>`/.exec(src);
  if (!match) throw new Error('prerender_seo.ts no longer has a PRERENDER_STYLE block');
  return match[1];
})();

/** Every class name in a stylesheet that belongs to the plan. */
function planoClasses(css: string): Set<string> {
  return new Set([...css.matchAll(/\.(?:pvg|pdt|pdz|popup-plano)[A-Za-z0-9_-]*/g)].map((m) => m[0]));
}

/** One station's drawing, built straight from the data with stand-in services. */
function drawingFor(code: string): string {
  const layout = planos.layouts[code];
  const services = new Set<string>();
  for (const row of layout.rows ?? []) {
    for (const v of row.vagones ?? []) for (const s of [...(v.arriba ?? []), ...(v.abajo ?? [])]) services.add(s);
  }
  const out = buildSheetPlano({
    wagons: { A: [...services].map((codigo) => ({ codigo, nombre: 'R ' + codigo, color: '#888', tipoServicio: 'TRONCAL' })) },
    layout,
    detalle: planos.detalle[code],
    wagonPlan: {},
    sentidos: { positive: 'NORTE', negative: 'SUR' },
    tagColor: () => '#888',
    isZonal: () => false,
  });
  if (!out) throw new Error(code + ' draws nothing');
  return out.html;
}

test.describe('the plan, without a browser', () => {
  test('the app and the prerender style exactly the same classes', () => {
    const app = planoClasses(appCss);
    const pre = planoClasses(prerenderCss);
    // Reported as sorted lists rather than as a boolean: the whole value of this
    // test is naming the class that only one side knows about.
    expect({
      onlyInTheApp: [...app].filter((c) => !pre.has(c)).sort(),
      onlyInThePrerender: [...pre].filter((c) => !app.has(c)).sort(),
    }).toEqual({ onlyInTheApp: [], onlyInThePrerender: [] });
  });

  // Classes the drawing emits as MARKERS: something the markup says about
  // itself that nothing needs to style. Each one is a deliberate entry — a
  // class that turns up here without being added is a rule somebody forgot to
  // write, which is how the app came to draw fourteen stations' dividers as an
  // invisible band with a word floating over it.
  const MARKERS = new Set([
    // The exit's default direction; only the mirrored one is styled.
    '.pdt-salida-izq',
    // Kinds of strip item that `.pdz-item` already covers whole.
    '.pdz-equipo',
    '.pdz-llegada',
    // A divider of no particular kind, and its label, which sits in the flex
    // row between the two rules without needing anything of its own.
    '.pvg-divider-plain',
    '.pvg-divider-name',
  ]);

  test('every class the renderer emits is styled by both, or is a declared marker', () => {
    const emitted = new Set<string>();
    for (const code of drawn) {
      for (const attr of drawingFor(code).matchAll(/class="([^"]+)"/g)) {
        for (const name of attr[1].split(/\s+/)) {
          if (/^(?:pvg|pdt|pdz|popup-plano)/.test(name)) emitted.add('.' + name);
        }
      }
    }
    expect(emitted.size).toBeGreaterThan(30);
    const app = planoClasses(appCss);
    const pre = planoClasses(prerenderCss);
    expect({
      unstyledInTheApp: [...emitted].filter((c) => !app.has(c) && !MARKERS.has(c)).sort(),
      unstyledInThePrerender: [...emitted].filter((c) => !pre.has(c) && !MARKERS.has(c)).sort(),
      // A marker that has since been given a rule is no longer a marker; leaving
      // it listed would exempt it from the check above for good.
      markersThatAreNowStyled: [...MARKERS].filter((c) => app.has(c) || pre.has(c)).sort(),
    }).toEqual({ unstyledInTheApp: [], unstyledInThePrerender: [], markersThatAreNowStyled: [] });
  });

  test('every chip row reads in the order its sheet prints it', () => {
    // The layout's `arriba` and `abajo` lists are the sheet read left to right,
    // and that is the order a rider sees on the sign. The renderer used to sort
    // them alphanumerically — right for the popup, where the order is the
    // catalog's and means nothing — which turned Portal Usme's printed
    // "H27 H13" into "H13 H27" on thirty chip rows across the network.
    const wrong: string[] = [];
    for (const code of drawn) {
      const html = drawingFor(code);
      // One deck cell per <section class="pvg">, in drawing order; its chips are
      // whatever the tag markup carries, in the order it carries them.
      const cells = html.split('<section class="pvg').slice(1);
      const rows: string[][] = [];
      for (const cell of cells) {
        for (const side of cell.split('class="pvg-side').slice(1)) {
          const chips = [...side.matchAll(/data-route-code="([^"]+)"/g)].map((m) => m[1].trim());
          if (chips.length > 1) rows.push(chips);
        }
      }
      const want: string[][] = [];
      for (const row of planos.layouts[code].rows ?? []) {
        for (const v of row.vagones ?? []) {
          for (const side of ['arriba', 'abajo'] as const) {
            const list: string[] = v[side] ?? [];
            if (list.length > 1) want.push(list.map(String));
          }
        }
      }
      // Compared as a SET of rows: the drawing walks its columns, the layout
      // walks its rows, and the two orders of the rows themselves need not agree.
      const key = (rs: string[][]) => rs.map((r) => r.join(' ')).sort().join(' | ');
      if (key(rows) !== key(want)) wrong.push(`${code}: sheet has [${key(want)}], drawing has [${key(rows)}]`);
    }
    expect(wrong).toEqual([]);
  });

  test('no drawing names a corridor along its edge', () => {
    // The NORTE/SUR and OCCIDENTE/ORIENTE bands were hoisted out of the drawing:
    // they put the answer furthest from the chip a rider is reading, and on a
    // portal — where the two platforms face different ways — said something that
    // was true of neither.
    const named = drawn.filter((code) => drawingFor(code).includes('pvg-axis'));
    expect(named).toEqual([]);
  });
});

/** The plan under one stylesheet, measured. */
type Shot = { decks: Array<{ label: string; left: number; top: number }>; bands: number[] };

async function measure(page: Page, html: string, css: string, wrapper: string): Promise<Shot> {
  await page.setContent(
    `<style>:root{color-scheme:dark}body{margin:0;background:#0C0C0C;color:#fff;` +
      `font:14px/1.4 system-ui,sans-serif;width:1400px}</style><style>${css}</style>` +
      `<div ${wrapper}>${html}</div>`,
  );
  return page.evaluate(() => {
    const decks = [...document.querySelectorAll('.pvg-deck')].map((d) => {
      const r = d.getBoundingClientRect();
      return { label: (d.querySelector('.pvg-name')?.textContent ?? '').trim(), left: Math.round(r.left), top: Math.round(r.top) };
    });
    // The alignment rule, per band: decks that share a band share a top edge.
    // Keyed by the band ELEMENT — a split station draws the same band classes
    // once per platform, and keying by class name compared the top platform's
    // decks against the bottom one's, which are meant to be far apart.
    const byBand = new Map<Element | null, number[]>();
    for (const d of document.querySelectorAll('.pvg-deck')) {
      const band = d.closest('.pdt-band') ?? d.closest('.popup-plano-cols');
      const tops = byBand.get(band) ?? [];
      tops.push(Math.round(d.getBoundingClientRect().top));
      byBand.set(band, tops);
    }
    const bands = [...byBand.values()].filter((t) => t.length > 1).map((t) => Math.max(...t) - Math.min(...t));
    return { decks, bands };
  });
}

test.describe('the plan, drawn', () => {
  // Two full renders of every drawn station under two stylesheets.
  test.describe.configure({ timeout: 180_000 });

  test('the app and the prerender draw the same plan', async ({ page }) => {
    const wrong: string[] = [];
    for (const code of drawn) {
      const html = drawingFor(code);
      const app = await measure(page, html, appCss, 'class="tm-plano"');
      const pre = await measure(page, html, prerenderCss, 'id="seo-prerender" style="position:static"');

      if (app.decks.length !== pre.decks.length) {
        wrong.push(`${code}: ${app.decks.length} decks in the app, ${pre.decks.length} prerendered`);
        continue;
      }
      // Not pixel equality — the prerendered copy is written flat, without the
      // app's scale variable, and is meant to differ in size. What must agree is
      // the PLAN: the same platforms, in the same order, on the same lines.
      const order = (s: Shot) =>
        s.decks
          .map((d, i) => ({ ...d, i }))
          .sort((a, b) => a.top - b.top || a.left - b.left)
          .map((d) => d.label || '·')
          .join(' ');
      if (order(app) !== order(pre)) wrong.push(`${code}: app reads "${order(app)}", prerender reads "${order(pre)}"`);
      const drift = Math.max(0, ...app.bands, ...pre.bands);
      if (drift > 2) wrong.push(`${code}: decks in one band sit ${drift}px apart`);
    }
    expect(wrong).toEqual([]);
  });
});

const BOOT_TIMEOUT_MS = 90_000;

/** The app, booted once, then walked from station to station by pushState. */
async function bootApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#loading-overlay').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

/**
 * Opens one estación page in the booted app.
 *
 * The name in front of the código is decoration — `parseStationPathname` reads
 * whatever follows the LAST hyphen — so the walk needs no station names, and a
 * renamed station cannot silently stop being tested.
 */
async function openStation(page: Page, code: string): Promise<void> {
  await page.evaluate((path) => {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/estacion/e-${code.toLowerCase()}/`);
  await page.locator('.popup-plano').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('the plan, on the page', () => {
  test.describe.configure({ timeout: 300_000 });

  test('every station draws its plan, with its decks on one line', async ({ page }) => {
    await bootApp(page);
    const wrong: string[] = [];
    for (const code of drawn) {
      await openStation(page, code);
      const found = await page.evaluate(() => {
        const byBand = new Map<Element | null, number[]>();
        for (const d of document.querySelectorAll('.popup-plano .pvg-deck')) {
          const band = d.closest('.pdt-band') ?? d.closest('.popup-plano-cols');
          const tops = byBand.get(band) ?? [];
          tops.push(Math.round(d.getBoundingClientRect().top));
          byBand.set(band, tops);
        }
        const drift = [...byBand.values()].filter((t) => t.length > 1).map((t) => Math.max(...t) - Math.min(...t));
        return {
          decks: document.querySelectorAll('.popup-plano .pvg-deck').length,
          axis: document.querySelectorAll('.pvg-axis').length,
          drift: Math.max(0, ...drift),
        };
      });
      if (found.decks === 0) wrong.push(code + ': no platform drawn');
      if (found.axis > 0) wrong.push(code + ': names a corridor along its edge');
      if (found.drift > 2) wrong.push(`${code}: decks in one band sit ${found.drift}px apart`);
    }
    expect(wrong).toEqual([]);
  });

  test('the drawing never makes the page scroll sideways', async ({ page }) => {
    // A plan wider than the viewport scrolls INSIDE its own box (`.popup-plano`
    // is the scroller). If the page itself scrolls, the drawing has pushed the
    // whole layout out — which on a phone takes every other section with it.
    await page.setViewportSize({ width: 390, height: 844 });
    await bootApp(page);
    const wrong: string[] = [];
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const code of drawn) {
        await openStation(page, code);
        const over = await page.evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          return el.scrollWidth - el.clientWidth;
        });
        if (over > 1) wrong.push(`${code} at ${width}px: page scrolls ${over}px sideways`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('every service on a plan links to its route', async ({ page }) => {
    await bootApp(page);
    const wrong: string[] = [];
    for (const code of drawn) {
      await openStation(page, code);
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        for (const a of document.querySelectorAll<HTMLAnchorElement>('.popup-plano a[href]')) {
          if (!/^\/ruta\/[^/]+\/$/.test(new URL(a.href, location.href).pathname)) out.push(a.textContent?.trim() ?? '?');
        }
        return out;
      });
      for (const b of bad) wrong.push(`${code}: chip "${b}" does not link to a route page`);
    }
    expect(wrong).toEqual([]);
  });
});
