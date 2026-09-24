import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The renderer itself — the same module the app and the prerender both call, so
// a drawing can be produced here without a browser or a catalog.
import { buildSheetPlano } from '../shared/plano.js';
import { buildPortalSvg, PALETA } from '../shared/plano_svg.js';

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
        const svg = document.querySelector('.popup-plano-portal svg.pq');
        const css = svg?.querySelector('style')?.textContent ?? '';
        return {
          // A PORTAL is not a row of decks but one SVG on its sheet's own
          // coordinates, so the alignment rule does not apply and different
          // things matter: that it drew its loop, that both palettes travel
          // with it, and that print is forced to the paper one.
          portal: Boolean(svg),
          anillo: (svg?.querySelectorAll('path').length ?? 0) > 5,
          paletas: css.includes('.pq{--pq-') && css.includes('.pq.pq-papel{--pq-'),
          imprime: css.includes('@media print'),
          decks: document.querySelectorAll('.popup-plano .pvg-deck').length,
          axis: document.querySelectorAll('.pvg-axis').length,
          drift: Math.max(0, ...drift),
        };
      });
      if (found.portal) {
        if (!found.anillo) wrong.push(code + ': portal drawn without its loop');
        if (!found.paletas) wrong.push(code + ': portal carries only one palette');
        if (!found.imprime) wrong.push(code + ': portal does not force paper for print');
        continue;
      }
      if (found.decks === 0) wrong.push(code + ': no platform drawn');
      if (found.axis > 0) wrong.push(code + ': names a corridor along its edge');
      if (found.drift > 2) wrong.push(`${code}: decks in one band sit ${found.drift}px apart`);
    }
    expect(wrong).toEqual([]);
  });

  test('nothing paints over what a divider is called', async ({ page }) => {
    // The divider is drawn as a BAND inside every column it crosses, and its name
    // goes on the middle column of that run — which at Guatoque is the crossing
    // between two vagones, 51px wide. The word is wider than that, and the next
    // column's band painted its own background straight over the overflow: the
    // caño read "CAÑ".
    await bootApp(page);
    const wrong: string[] = [];
    for (const code of drawn) {
      if (!planos.layouts[code]?.divider) continue;
      await openStation(page, code);
      const covered = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll('.pdt-divider-name, .pvg-divider-name')) {
          const box = el.getBoundingClientRect();
          if (box.width === 0) continue;
          // Whatever is painted at the last glyph has to be the name itself.
          const top = document.elementFromPoint(box.right - 3, box.top + box.height / 2);
          if (top !== el && !el.contains(top)) out.push((el.textContent ?? '').trim());
        }
        return out;
      });
      for (const name of covered) wrong.push(`${code}: "${name}" is painted over`);
    }
    expect(wrong).toEqual([]);
  });

  test('a portal is never drawn smaller than its own sheet', async ({ page }) => {
    // The estación page's column is 760px and a portal's window onto its sheet
    // is up to 840 units across, so drawn in the column Portal Norte came out at
    // 0.86 of the operator's own scale — bay names at six pixels and badges too
    // small to tap. The plan now steps out of the column and holds a floor of
    // 1.12x whatever ITS sheet measures, which is why the floor is expressed
    // against the viewBox rather than in pixels.
    await bootApp(page);
    const wrong: string[] = [];
    for (const width of [390, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const code of drawn) {
        await openStation(page, code);
        const medida = await page.evaluate(() => {
          const svg = document.querySelector('.popup-plano-portal svg.pq');
          if (!svg) return null;
          const caja = svg.parentElement as HTMLElement | null;
          // Against the window in 1024-sheet pixels the box carries, not the
          // viewBox: Portal Américas' sheet is 1920 wide, and its own pixels
          // would demand a drawing wider than any screen.
          const vb = Number(caja?.style.getPropertyValue('--pq-vb') || 0);
          return {
            escala: svg.getBoundingClientRect().width / (vb || 1),
            // And it must not drag the PAGE sideways while it does it: the plan
            // scrolls inside its own box or not at all.
            pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            desborde: (caja?.scrollWidth ?? 0) - (caja?.clientWidth ?? 0),
            // And it has to stay on the page's own axis. Widened without being
            // CENTRED on the column it read as a fault rather than as a figure:
            // a slab running off one edge of a page whose every other block is
            // inset. The figure is wider than the measure; it is not off it.
            desvio: (() => {
              const figura = caja?.getBoundingClientRect();
              const columna = document.querySelector('.page-inner')?.getBoundingClientRect();
              if (!figura || !columna) return 0;
              return Math.abs((figura.left + figura.right) / 2 - (columna.left + columna.right) / 2);
            })(),
          };
        });
        if (!medida) continue;
        if (medida.desvio > 2) {
          wrong.push(`${code} at ${width}px: the plan sits ${Math.round(medida.desvio)}px off the page's axis`);
        }
        if (medida.escala < 1.1) {
          wrong.push(`${code} at ${width}px: drawn at ${medida.escala.toFixed(2)}x its sheet`);
        }
        if (medida.pagina > 1) wrong.push(`${code} at ${width}px: page scrolls ${medida.pagina}px sideways`);
        if (width >= 1024 && medida.desborde > 1) {
          wrong.push(`${code} at ${width}px: still has to scroll ${medida.desborde}px inside its box`);
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(wrong).toEqual([]);
  });

  test('a portal is drawn as large as the screen can show it whole', async ({ page }) => {
    // Held to a 1040px card, Portal Norte stopped at 1.2x its sheet on every
    // desktop — at 1920 across, with 440px of empty page either side of it — and
    // the card's lighter ground around a drawing whose ground is the page colour
    // set it back in a mat. The loop looked seen from a distance. So on a desktop
    // the drawing reaches one of the two things that can actually stop it: the
    // widest a figure is on this page (1320px, or a 24px gutter), or the height
    // of the view under the page bar. And it never passes the second, because a
    // plan you have to scroll down through is not one you can see whole.
    await bootApp(page);
    const wrong: string[] = [];
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
      [1920, 960],
    ]) {
      await page.setViewportSize({ width, height });
      for (const code of drawn) {
        await openStation(page, code);
        const medida = await page.evaluate(() => {
          const svg = document.querySelector('.popup-plano-portal svg.pq');
          const caja = svg?.parentElement as HTMLElement | null;
          if (!svg || !caja) return null;
          const dibujo = svg.getBoundingClientRect();
          const marco = caja.getBoundingClientRect();
          // What stands between the drawing and the page: anything painting a
          // ground of its own, or padding it out, is a mat.
          const mates: string[] = [];
          for (let el: HTMLElement | null = caja; el && !el.matches('.page-section'); el = el.parentElement) {
            const cs = getComputedStyle(el);
            if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none') mates.push(el.className + ' paints a ground');
            if (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingTop) > 0) mates.push(el.className + ' pads the drawing');
          }
          return { ancho: marco.width, alto: dibujo.height, vista: innerWidth, vistaAlto: innerHeight, mates };
        });
        if (!medida) continue;
        const lienzo = Math.min(1320, medida.vista - 48);
        const entero = medida.vistaAlto - 120;
        if (medida.alto > entero + 1) {
          wrong.push(`${code} at ${width}x${height}: ${Math.round(medida.alto)}px tall, more than the ${entero}px it can be seen whole in`);
        }
        if (medida.ancho < lienzo - 1 && medida.alto < entero - 1) {
          wrong.push(
            `${code} at ${width}x${height}: ${Math.round(medida.ancho)}x${Math.round(medida.alto)}px, ` +
              `short of both the ${lienzo}px figure width and the ${entero}px view height`
          );
        }
        for (const m of medida.mates) wrong.push(`${code} at ${width}x${height}: ${m}`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
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
        // `getAttribute`, not `.href`: a portal's chips are SVG anchors, whose
        // `href` is an SVGAnimatedString. Read as a string it stringifies to
        // "[object SVGAnimatedString]" and every one of them looked broken.
        for (const a of document.querySelectorAll('.popup-plano a[href]')) {
          const href = a.getAttribute('href') ?? '';
          if (!/^\/ruta\/[^/]+\/$/.test(new URL(href, location.href).pathname)) {
            out.push(a.textContent?.trim() ?? '?');
          }
        }
        return out;
      });
      for (const b of bad) wrong.push(`${code}: chip "${b}" does not link to a route page`);
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * A PORTAL drawn on its sheet's own coordinates (`shared/plano_svg.js`).
 *
 * Two shapes exist: a ring (Portal Norte) and a set of angled lozenges (Portal
 * 80), and the second one is measured feature by feature — an axis, a spine, a
 * bay band, a marker per bay, a tile per piece of furniture. Nothing here checks
 * the NUMBERS, which only the sheet can settle; what it checks is that every
 * feature the geometry records reaches the page, because the way this has failed
 * is a whole class of them silently not being drawn.
 *
 * A station still being measured carries `borrador` and the app draws its
 * columns instead. That gate is bypassed HERE on purpose: the drawing has to be
 * complete before the gate comes off, so the test has to be able to see it.
 */
test.describe('a portal on its sheet', () => {
  const geos = JSON.parse(readFileSync(root('server/src/data/plano_geo.json'), 'utf8')) as Record<string, any>;
  // The file opens with a `_` note about how the measuring was done.
  const portales = Object.keys(geos).filter((k) => /^TM\d+$/.test(k));
  // An empty list here would make every test below pass without looking at
  // anything, which is the one way this file could lie.
  test('there are portals to check', () => {
    expect(portales.length).toBeGreaterThan(0);
  });

  /** The portal's SVG, drawn whether or not its measurements are finished. */
  function portalFor(code: string): string {
    const svg = buildPortalSvg({
      geo: { ...geos[code], borrador: false },
      detalle: planos.detalle[code],
      layout: planos.layouts[code],
      tema: 'papel',
    });
    if (!svg) throw new Error(code + ' draws nothing');
    return svg;
  }

  test('every measured feature of a portal reaches the drawing', () => {
    const wrong: string[] = [];
    for (const code of portales) {
      const geo = geos[code];
      const svg = portalFor(code);
      const cuenta = (re: RegExp): number => (svg.match(re) ?? []).length;

      // One path per platform and one per spine, each with as many points as
      // the geometry gives it.
      for (const a of geo.andenes ?? []) {
        const d = a.pts.map((p: number[]) => p.join(',')).join(' L');
        if (!svg.includes('M' + d)) wrong.push(code + ': a platform is not drawn along its own axis');
        // And in its own tone where the slab has two, as Portal Suba's do.
        if (a.tono && !svg.includes('stroke="var(--pq-' + a.tono + ')" stroke-width="' + a.ancho + '"')) {
          wrong.push(code + ': a platform band is not drawn in its ' + a.tono + ' tone');
        }
      }
      // Bare points where the spine is the ink line, an object where it carries
      // its own weight and tone.
      for (const e of geo.espinas ?? []) {
        const d = (Array.isArray(e) ? e : e.pts).map((p: number[]) => p.join(',')).join(' L');
        if (!svg.includes('M' + d)) wrong.push(code + ': a platform is drawn without its spine');
      }
      // A bay band bends where its platform bends; drawn end to end it leaves
      // the platform past the bend and comes out beyond the kerb.
      for (const b of geo.barras ?? []) {
        const quiebres = (geo.andenes?.[b.anden]?.pts ?? []).slice(1, -1)
          .filter((p: number[]) => p[0] > b.desde && p[0] < b.hasta).length;
        const esperados = quiebres + 2;
        const usados = [...svg.matchAll(/<path d="(M[^"]*)" fill="none" stroke="var\(--pq-bahia\)/g)]
          .map((m) => m[1].split('L').length);
        if (!usados.includes(esperados)) {
          wrong.push(code + ': a bay band skips a bend in its platform');
        }
      }
      // A marker and a name per bay the sheet draws.
      // Every bay that HAS a marker: an arrival zone is a caption over a
      // stretch of platform, and the sheet gives it none.
      const bahias = (geo.tirasAng ?? []).reduce(
        (n: number, t: any) => n + (t.bahias ?? []).filter((b: any) => !b.centro).length, 0);
      if (bahias) {
        // A triangle cut into a bay bar, or a short bar in the route's own
        // colour beside the name: two sheets, two marks, one thing counted.
        // Counted by class, on the one shape per bay that IS its marker: a bar
        // bay's arrow is drawn with the same path as a triangle marker, and
        // matched by its geometry it was counted twice.
        const marcas = cuenta(/class="pq-bahia"/g);
        if (marcas !== bahias) wrong.push(code + ': ' + bahias + ' bays measured, ' + marcas + ' markers drawn');
        for (const t of geo.tirasAng ?? []) {
          const tira = (planos.detalle[code]?.zonal ?? []).find((z: any) => z.nombre === t.tira);
          if (!tira) { wrong.push(code + ': strip "' + t.tira + '" is not in the station data'); continue; }
          (tira.items ?? []).filter((i: any) => i.t === 'bahia').forEach((it: any, i: number) => {
            // A bay the geometry gives its own wording is checked against THAT:
            // a sheet may print a bay differently from how the catalog files it,
            // and where it does, the sheet wins.
            const b = (t.bahias ?? [])[i - (t.desde ?? 0)] ?? {};
            // Or, where a name is too long for the room between two bays, the
            // words it is broken into — a list for a one-route bay, by código
            // where the bay has two.
            const esperados: string[] = b.texto ?? (Array.isArray(b.partir) ? b.partir : null) ?? it.destinos ??
              (it.rutas ?? []).flatMap((r: any) => b.partir?.[r.codigo] ?? [r.destino]);
            for (const nombre of esperados) {
              if (nombre && !svg.includes(nombre)) wrong.push(code + ': bay "' + nombre + '" is not named');
            }
          });
        }
      }
      // A tile per measured piece of furniture.
      const tejas = (geo.equipoAng ?? []).reduce((n: number, e: any) => n + (e.pts ?? []).length, 0);
      if (tejas) {
        const dibujadas = cuenta(/role="img"/g);
        if (dibujadas < tejas) wrong.push(code + ': ' + tejas + ' tiles measured, ' + dibujadas + ' drawn');
      }

      // And what the station stands on. Each of these is a whole class of thing
      // that has gone missing at some point in the drawing's life — the tunnel
      // twice — so each is counted rather than eyeballed.
      const cuentas: Array<[string, number, RegExp]> = [
        ['corridor', (geo.corredores ?? []).length, /stroke-dasharray="3 2\.4"/g],
        ['run of planting', (geo.verdes ?? []).length, /stroke="var\(--pq-verde\)"/g],
        // By class: a ramp's slope is drawn paler than a flight of steps, so the
        // landing grey no longer marks every landing.
        ['tunnel landing', (geo.desembarcos ?? []).length, /<path class="pq-desembarco"/g],
        // The street's rules and the ink ON the platforms are one primitive
        // drawn in two passes: a tunnel mouth's outline ruled with the street
        // went under the platform it is cut into.
        // Counted by class: the round-capped stroke it used to be matched on is
        // also inside every turnstile glyph, so the count could not fall short.
        ['ruled line', (geo.lineas ?? []).length + (geo.trazos ?? []).length, /<path class="pq-linea"/g],
        // A tag's pointer on the side it points from.
        ['tag pointing left', (geo.etiquetas ?? []).filter((t: any) => t.flecha === true || t.flecha === 'izq').length, / l7,-5\.5 v11 z"/g],
        ['tag pointing up', (geo.etiquetas ?? []).filter((t: any) => t.flecha === 'arriba').length, / l[\d.]+,-[\d.]+ l[\d.]+,[\d.]+ z" fill="#FEED01"/g],
        ['veil over a platform', (geo.velos ?? []).length, /<path class="pq-velo"/g],
        ['platform outline', (geo.losas ?? []).length, /<path class="pq-losa"/g],
        // A mark whose colour is part of it keeps it on its tile.
        ['blue priority-lift tile',
          (geo.equipoAng ?? []).reduce((n: number, e: any) => n + (e.iconos ?? []).filter((i: string) => i === 'ascensor').length, 0),
          /aria-label="Ascensor prioritario"><rect [^>]*fill="#03518F"/g],
        ['tag pointing right', (geo.etiquetas ?? []).filter((t: any) => t.flecha === 'der').length, / l-8\.5,-5\.5 v11 z"/g],
        ['circle', (geo.circulos ?? []).length, /<circle cx=/g],
        // By its class, not its green: an emergency exit and an evacuation-route
        // sign are two greens on the sheets, and counting one missed the other.
        ['sign', (geo.senales ?? []).length, /<rect class="pq-senal"/g],
        ['escalator flight', (geo.escalones ?? []).length, /width="10" height="4\.8" rx="2\.4"/g],
        ['filled block', (geo.poligonos ?? []).length, /<path class="pq-bloque"/g],
        ['north point', geo.norte ? 1 : 0, /aria-label="Norte"/g],
      ];
      for (const [nombre, esperados, re] of cuentas) {
        if (!esperados) continue;
        const hallados = cuenta(re);
        if (hallados < esperados) {
          wrong.push(code + ': ' + esperados + ' × ' + nombre + ' measured, ' + hallados + ' drawn');
        }
      }
      // A round hall's spiral stair is its treads: every one of them is ruled
      // between the two radii it was measured at, around the disc it belongs to.
      const lineas = [...svg.matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/g)]
        .map((m) => m.slice(1, 5).map(Number));
      for (const c of geo.circulos ?? []) {
        const p = c.peldanos;
        if (!p) continue;
        const cerca = (x: number, y: number, r: number): boolean => Math.abs(Math.hypot(x - c.x, y - c.y) - r) < 0.05;
        const ruladas = lineas.filter(([x1, y1, x2, y2]) => cerca(x1, y1, p.r0) && cerca(x2, y2, p.r1)).length;
        if (ruladas < p.n) wrong.push(code + ': a round hall at ' + c.x + ',' + c.y + ' has ' + ruladas + ' of its ' + p.n + ' treads');
      }
      // A bar bay's arrow points the way its own bay does: Portal Américas points
      // its arrival zones down into the platform and its bays up at the kerb.
      if (!(geo.tiras ?? []).length) {
        const barras = (geo.tirasAng ?? []).filter((t: any) => t.marca === 'barra');
        const abajo = barras.reduce((n: number, t: any) =>
          n + (t.bahias ?? []).filter((b: any) => b.abajo ?? t.barra?.abajo).length, 0);
        const flechas = cuenta(/<path d="M[^"]* l-[\d.]+,[\d.]+ z" fill="var\(--pq-trazo\)"\/>/g);
        if (barras.length && flechas !== abajo) wrong.push(code + ': ' + abajo + ' bays point down, ' + flechas + ' arrows do');
      }
      // A ring's ends, as the sheet builds them: the radial hatch over the top and
      // bottom of each end, the green in its corners, and the bridge stacking the
      // marks of its OWN column — not the first column that climbs anything,
      // which at Portal Norte is a tunnel and stacked stairs on a bridge that
      // lands on ramps.
      const A = geo.anillo;
      if (A) {
        const R = A.rayas ?? {};
        const porLado = Math.floor(((R.hasta ?? 94) - (R.desde ?? 40)) / (R.paso ?? 4.15) + 1e-6) + 1;
        const rayas = cuenta(/<line [^>]*stroke="var\(--pq-radios\)"/g);
        if (rayas !== porLado * 4) wrong.push(code + ': ' + porLado * 4 + ' stripes across the ring\'s ends, ' + rayas + ' drawn');
        const verdes = cuenta(/<path d="M[^"]*" fill="var\(--pq-verde\)"\/>/g);
        if (verdes < (A.verdes?.x ?? []).length) wrong.push(code + ': the ring\'s green corners are not drawn');
        if (svg.includes('Llegada de pasajeros')) wrong.push(code + ': an arrival zone carries a name the sheet does not print');
      }
      const P = geo.puente;
      if (P) {
        const cols = (planos.detalle[code]?.columnas ?? []).filter((c: any) => c.t === 'puente' && c.sube);
        const propia = cols.find((c: any) => /puente/i.test(c.nombre ?? '')) ?? cols[0];
        const primera = (propia?.sube ?? [])[0];
        if (primera) {
          const t = geo.teja ?? 18;
          const pos = 'translate(' + (P.bloque.cx - t / 2) + ' ' + (P.pila[0] - t / 2) + ')" role="img" aria-label="';
          const i = svg.indexOf(pos);
          const etiqueta = i < 0 ? null : svg.slice(i + pos.length).split('"')[0];
          const esperada = { rampa: 'Rampa peatonal', escalera: 'Escalera peatonal' }[primera as 'rampa' | 'escalera'];
          if (etiqueta !== esperada) wrong.push(code + ': the bridge stack starts with ' + etiqueta + ', its column climbs by ' + primera);
        }
      }
      // Names stacked UPWARD off the kerb end on one baseline: the last line of
      // every bay sits where a one-line bay does, and a second route goes above
      // it rather than down into the platform. The last line is the last
      // route's destination — under its tag, or beside it on one line, which
      // centres it on the tag and lifts it a point or two.
      for (const t of geo.tirasAng ?? []) {
        if (t.apila !== 'arriba') continue;
        const tira = (planos.detalle[code]?.zonal ?? []).find((z: any) => z.nombre === t.tira);
        const eje = t.y ?? geo.andenes?.[t.anden]?.pts?.[0]?.[1];
        (tira?.items ?? []).filter((i: any) => i.t === 'bahia').forEach((it: any, i: number) => {
          const rutas = it.rutas ?? [];
          if (rutas.length < 2) return;
          // A bay may stand at its own height and hang its names at its own
          // distance (Bicentenario's Piso 2), and a strip may start part-way
          // through its list.
          const bb = (t.bahias ?? [])[i - (t.desde ?? 0)];
          if (!bb) return;
          const base = (bb.y ?? eje + (t.off ?? 0)) + (bb.dy ?? t.dy) + (bb.fila ?? 0) * (t.fila ?? 0);
          const ultima = rutas[rutas.length - 1];
          const y = [...svg.matchAll(/<text x="[\d.-]+" y="([\d.-]+)" class="pq-bay[^"]*">(.*?)<\/text>/g)]
            .filter((m) => m[2] === ultima.destino).pop()?.[1];
          if (y === undefined || Math.abs(Number(y) - base) > 2) {
            wrong.push(code + ': ' + ultima.codigo + ' is not on the bays\' baseline (' + y + ' against ' + base + ')');
          }
        });
      }
      // A landing without its treads is a grey slab: the steps ARE the drawing.
      for (const d of geo.desembarcos ?? []) {
        const pasos = (d.tramos ?? []).reduce((n: number, [a, b]: number[]) => n + Math.floor((b - a) / (d.paso ?? 2.2)), 0);
        if (pasos && cuenta(/<line x1=/g) < pasos) wrong.push(code + ': a tunnel landing is drawn without its treads');
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * What a station says about its own drawing that the palette and the shared
   * defaults have no name for.
   *
   * Every one of these is a line in the renderer that a sheet asked for and
   * nothing else uses yet, which is exactly the kind of thing a refactor drops
   * without a sound: a surface named by the station falls back to the platform
   * grey, a veil loses its round nose, a kerb grows a blob at every step, a
   * boundary is ruled solid, a bay's código is set at its destination's size.
   */
  /** The angle a platform runs at where a feature sits on it (`giro`). */
  function anguloDe(geo: any, anden: number, x: number): number {
    const pts = geo.andenes?.[anden]?.pts ?? [];
    let k = 0;
    while (k < pts.length - 2 && x > pts[k + 1][0]) k++;
    const [x0, y0] = pts[k] ?? [0, 0];
    const [x1, y1] = pts[k + 1] ?? [1, 0];
    return (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  }

  test("a station's own surfaces, cuts, dashes and turns reach its drawing", () => {
    const base = new Set(Object.keys(PALETA.oscuro));
    const wrong: string[] = [];
    for (const code of portales) {
      const geo = geos[code];
      const svg = portalFor(code);
      // A tone the palette does not carry, published by the station itself.
      const propios = Object.keys(geo.tonos ?? {}).filter((k) => !base.has(k));
      for (const t of propios) {
        if (!svg.includes('--pq-' + t + ':')) wrong.push(code + ': ' + t + ' is never defined');
        const usada = [...(geo.poligonos ?? []), ...(geo.losas ?? []), ...(geo.velos ?? [])]
          .some((f: any) => f.tono === t);
        if (usada && !svg.includes('var(--pq-' + t + ')')) {
          wrong.push(code + ': a shape measured in ' + t + ' is not drawn in it');
        }
      }
      // A veil with a corner radius is a rounded rectangle, arcs and all.
      for (const v of (geo.velos ?? []).filter((x: any) => x.rx)) {
        const esquina = 'A' + v.rx + ',' + v.rx;
        if (!svg.includes(esquina)) wrong.push(code + ': a veil loses the round end it was measured with');
        if (v.opacidad !== undefined && !svg.includes('fill-opacity="' + v.opacidad + '"')) {
          wrong.push(code + ': a veil is not drawn at the opacity it was measured at');
        }
      }
      // A kerb the sheet cuts square keeps its ends square.
      if ((geo.bordillos ?? []).some((k: any) => k.cuadrado) && !svg.includes('stroke-linecap="butt"')) {
        wrong.push(code + ': a kerb cut square is drawn with round caps');
      }
      // A line the sheet breaks is drawn broken.
      for (const l of (geo.lineas ?? []).filter((x: any) => x.guion)) {
        if (!svg.includes('stroke-dasharray="' + l.guion + '"')) {
          wrong.push(code + ': a dashed rule is drawn solid');
        }
      }
      // A bay's código is its own size, not its destination's — raised to the
      // legibility floor like every other size on the page.
      const codigo = geo.tipo?.['bay-code'];
      const piso = 10 / (1.12 * (1024 / (geo.hoja ?? 1024)) * (geo.escala ?? 1));
      const talla = Math.round(Math.max(codigo ?? 0, piso) * 100) / 100;
      if (codigo && !new RegExp('text\\.pq-bay-cod\\{[^}]*font-size:' + talla + 'px\\}').test(svg)) {
        wrong.push(code + ": a bay's código is not set at the size it was measured at");
      }
      // An ANGLED platform may turn what stands on it. Portal Tunal turns its
      // badges and its bay names with Plataforma 2 where Portal 80 leaves both
      // square to the page, so each is the station's own call — and each is a
      // line in the renderer that a refactor can quietly drop.
      // The badge's OWN turn, not any turn on the page: a platform tag and a
      // bay name may share the angle, and matched loosely this passed with
      // every badge left square to the page.
      const vueltas = [...svg.matchAll(/rotate\((-?[\d.]+)[^)]*\) translate\(/g)].map((m) => Number(m[1]));
      for (const grupo of (geo.chips ?? []).filter((c: any) => c.anden !== undefined)) {
        const ang = anguloDe(geo, grupo.anden, grupo.x);
        if (!vueltas.some((v) => Math.abs(v - ang) < 0.6)) {
          wrong.push(code + ': badge ' + grupo.codigos[0] + ' does not turn with its platform');
        }
      }
      for (const t of (geo.tirasAng ?? []).filter((s: any) => s.nombresAng)) {
        const nombre = (planos.detalle[code]?.zonal ?? [])
          .find((z: any) => z.nombre === t.tira)?.items
          ?.find((i: any) => i.t === 'bahia' && i.rutas?.length)?.rutas[0]?.destino;
        // The bay's whole block turns as one — tag and name together — so the
        // name sits inside a turned group rather than carrying a turn itself.
        const girado = nombre &&
          new RegExp('<g transform="rotate\\([^"]*\\)">(?:(?!</g>).)*>' + nombre + '</text>').test(svg);
        if (nombre && svg.includes('>' + nombre + '</text>') && !girado) {
          wrong.push(code + ': a bay name on an angled platform is set level');
        }
      }
      // A bay marker the sheet draws smaller than Portal Norte's nine by seven,
      // and one it turns over because the bus pulls in on the other side.
      for (const t of geo.tirasAng ?? []) {
        if (t.tri && !svg.includes('h' + t.tri.w)) {
          wrong.push(code + ': a bay marker is not the size it was measured at');
        }
        const sube = (t.bahias ?? []).some((b: any) => b.arriba) || t.arriba;
        if (sube && !svg.includes(',-' + (t.tri?.h ?? 7) + ' z')) {
          wrong.push(code + ": an arrival zone's marker is not turned over");
        }
      }
      // Every badge is ROUNDED, at the proportion the app's own route tags use
      // — 5 on 22 — whatever height the station's badge is. The sheets print
      // square corners; these are the same códigos a rider meets as rounded
      // tags on every other surface here, and drawn square on the portal they
      // read as a different kind of thing.
      const radio = geo.chip?.rx ?? (geo.chip?.h ?? 23) * (5 / 22);
      const badges = [...svg.matchAll(/<rect class="pq-badge"[^>]*?rx="([\d.]+)"/g)].map((m) => Number(m[1]));
      const todos = (svg.match(/<rect class="pq-badge"/g) ?? []).length;
      if (badges.length !== todos) wrong.push(code + ': a badge is drawn with square corners');
      if (badges.some((v) => Math.abs(v - radio) > 0.02)) {
        wrong.push(code + ': a badge is not rounded at the proportion its height asks for');
      }
      // A tag the sheet prints in another colour, lettered in another ink, or
      // pointing down at what it names.
      for (const e of (geo.etiquetas ?? []).filter((x: any) => x.fondo && x.fondo !== 'none')) {
        if (!svg.includes('fill="' + e.fondo + '"')) wrong.push(code + ': a tag is not drawn in its own colour');
        if (e.tinta && !svg.includes('fill:' + e.tinta)) wrong.push(code + ': a tag is not lettered in its own ink');
      }
      for (const e of (geo.etiquetas ?? []).filter((x: any) => x.flecha === 'abajo')) {
        const pw = e.pw ?? 5.5, ph = e.ph ?? 7.5;
        if (!svg.includes(' l' + pw + ',' + ph + ' l' + pw + ',-' + ph + ' z')) {
          wrong.push(code + ': a tag that points down is drawn pointing up');
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test('no portal measures something it does not have', () => {
    // A ring's clip rectangle was worked out whether or not the station had a
    // ring, so every lozenge portal shipped `y="undefined" height="NaN"` — which
    // the browser rejects and logs, twice, on a page that looked fine.
    const wrong: string[] = [];
    for (const code of portales) {
      const svg = portalFor(code);
      for (const m of svg.matchAll(/[a-z-]+="[^"]*(?:NaN|undefined)[^"]*"/g)) wrong.push(code + ': ' + m[0]);
    }
    expect(wrong).toEqual([]);
  });

  test("a portal's key names exactly the marks it draws", () => {
    const wrong: string[] = [];
    for (const code of portales) {
      const svg = portalFor(code);
      // The tiles, not the drawing itself: the root carries its own label, and
      // so does the north point, which is a mark on the page rather than a piece
      // of furniture the key has anything to say about.
      const dibujadas = new Set(
        [...svg.matchAll(/<g transform="translate[^>]*role="img" aria-label="([^"]*)"/g)].map((m) => m[1]),
      );
      const html = buildSheetPlano({
        wagons: {},
        layout: planos.layouts[code],
        detalle: planos.detalle[code],
        geo: { ...geos[code], borrador: false },
        wagonPlan: {},
        sentidos: { positive: 'NORTE', negative: 'SUR' },
        tagColor: () => '#888',
        isZonal: () => false,
      })?.html ?? '';
      const nombradas = new Set(
        [...html.matchAll(/<span class="pdt-conv-txt">([^<]*)<\/span>/g)].map((m) => m[1]),
      );
      // The key may name a mark the SVG spells differently (the ramps and the
      // bridge stairs are drawn as shapes, not as tiles), but it must never
      // leave one of the tiles on the page unexplained.
      for (const n of dibujadas) {
        if (!nombradas.has(n)) wrong.push(code + ': the key does not name "' + n + '"');
      }
      // The other direction, for the marks the drawing makes as shapes rather
      // than as tiles: a key that promises a ramp where there is none sends a
      // rider looking for a way through the platform edge that is not there.
      // `fill="var(--pq-rampa)"`, not `--pq-rampa`: every drawing DECLARES the
      // whole palette in its own style block, so looking for the variable name
      // matched every portal and the check could never fail.
      if (nombradas.has('Rampa peatonal') && !svg.includes('fill="var(--pq-rampa)"') && !svg.includes('aria-label="Rampa peatonal"')) {
        wrong.push(code + ': the key promises a ramp the drawing does not have');
      }
    }
    expect(wrong).toEqual([]);
  });

  test("in the app's view a portal is drawn in the page's own surfaces, unframed", () => {
    // Drawn in each sheet's own greys, no two portals looked alike and none
    // looked like the page it sat on — Tunal's and El Dorado's platforms were a
    // step lighter than the rest — and a bordered box set the plan apart as a
    // pasted-in picture. The app's view takes the page's tokens; each sheet's
    // greys stay for print, where the plan IS the sheet.
    const token = (n: string) => new RegExp('--' + n + ':\\s*([^;]+);').exec(appCss)?.[1].trim().toUpperCase();
    expect(PALETA.oscuro.papel.toUpperCase()).toBe(token('bg-primary'));
    expect(PALETA.oscuro.anden.toUpperCase()).toBe(token('bg-secondary'));
    // And no ground of its own: the page's orange glow runs on behind the
    // plan, where an opaque ground cut it off square at the drawing's top edge.
    expect(PALETA.oscuro.suelo).toBe('transparent');
    const wrong: string[] = [];
    for (const code of portales) {
      // The first `.pq{...}` block is the app's view; `.pq.pq-papel` follows it.
      const oscuro = /\.pq\{([^}]*)\}/.exec(portalFor(code))?.[1] ?? '';
      for (const [k, v] of Object.entries(PALETA.oscuro)) {
        if (!oscuro.includes('--pq-' + k + ':' + v + ';') && !oscuro.endsWith('--pq-' + k + ':' + v)) {
          wrong.push(code + ': draws ' + k + ' in its own grey, not the page\'s');
        }
      }
    }
    expect(wrong).toEqual([]);
    const caja = /\.station-plano \.popup-plano-portal \{([^}]*)\}/.exec(appCss)?.[1] ?? '';
    expect(caja).not.toMatch(/border|background|box-shadow/);
  });

  test('a badge printed black is still visible on the dark page', () => {
    // The sheet gives a plain service number a BLACK badge. On the dark view
    // that is black on black; the outline is the ink colour, so it disappears
    // on paper and is the only thing holding the badge together in the dark.
    const wrong: string[] = [];
    for (const code of portales) {
      for (const m of portalFor(code).matchAll(/<rect class="pq-badge"[^>]*fill="(#[0-9a-fA-F]{6})"([^/]*)\/>/g)) {
        const claro = parseInt(m[1].slice(1, 3), 16) + parseInt(m[1].slice(3, 5), 16) + parseInt(m[1].slice(5), 16);
        if (claro < 120 && !m[2].includes('stroke=')) wrong.push(code + ': badge ' + m[1] + ' has no outline');
      }
    }
    expect(wrong).toEqual([]);
  });

  test('every word on a portal can be read, and every bay links to its route', async ({ page }) => {
    // The sheets set their bay names for a wall: Portal Tunal's came out at
    // three and a half pixels, 20 de Julio's at five, and a rider could not tell
    // which feeder left from where. Each portal is drawn here at the SMALLEST
    // scale the page ever gives it — 1.12 px per 1024-sheet pixel, times the
    // station's `escala` — in the app's own Inter, loaded from the file the app
    // ships, because a label's width is the face's and a fallback would pass
    // what Inter does not. There:
    //   · every word is at least 10 px, and set in Inter;
    //   · no two words come within 4 px of each other, and no word within
    //     2 px of a tag, badge, plate or pictogram — measured on each shape's
    //     TURNED box, so a caption along an angled platform is held to it too.
    //     The drawings are laid out to twice that (`scripts/ocr/_legible.mjs
    //     --pad=4`): Linux sets the same Inter a pixel or two wider than
    //     Windows over a long name, and laid out to the test's own margin
    //     "Garcés Navas" passed on one and ran into its neighbour on the other;
    //   · every código, strapline and plate name fits inside its own shape;
    //   · nothing is cut off by the edge of the drawing;
    //   · no kerb strikes a word through — Tunal's Plataforma 2 caption ran
    //     across its kerb — and no ruled line does unless the word's halo
    //     knocks it out, which it can only do from on top;
    //   · every bay's código is a tag that opens its route.
    const inter = readFileSync(root('client/public/fonts/inter-latin-var.woff2')).toString('base64');
    const wrong: string[] = [];
    for (const code of portales) {
      const geo = geos[code];
      const detalle = planos.detalle[code];
      const zonal = Array.isArray(detalle?.zonal) ? detalle.zonal : detalle?.zonal ? [detalle.zonal] : [];
      // With NO routes filed at the station: a bay links from its código alone,
      // because the sheet — or an operator notice — can place a service before
      // the catalog files it there, as Portal Usme's notice did with five.
      const svg = buildPortalSvg({
        geo: { ...geo, borrador: false },
        detalle,
        layout: planos.layouts[code],
        tema: 'oscuro',
        byCode: new Map(),
        routeHref: (r: any) => '/ruta/' + r.codigo + '/',
      } as any).replace(/<a href/g, '<a data-x href');
      const escala = 1.12 * (1024 / (geo.hoja ?? 1024)) * (geo.escala ?? 1);
      const ancho = Math.round(geo.vista[2] * escala);
      await page.setViewportSize({ width: ancho + 20, height: Math.round(geo.vista[3] * escala) + 20 });
      await page.setContent('<!doctype html><meta charset="utf-8"><style>@font-face{font-family:Inter;' +
        'font-weight:400 800;src:url(data:font/woff2;base64,' + inter + ') format("woff2")}' +
        'body{margin:0}.pq{display:block;width:' + ancho + 'px;height:auto}</style>' + svg);
      await page.evaluate(() => document.fonts.ready);
      const hallado = await page.evaluate(() => {
        const out: string[] = [];
        type P = [number, number];
        // A shape's box, turned as it is on the page: four corners on screen.
        const quad = (el: any, trim = 0): P[] => {
          const b = el.getBBox(), m = el.getScreenCTM();
          const t = b.height * trim;
          return ([[b.x, b.y + t], [b.x + b.width, b.y + t], [b.x + b.width, b.y + b.height - t], [b.x, b.y + b.height - t]] as P[])
            .map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as P);
        };
        // Separating axes: how deep two convex quads interpenetrate (0 = apart).
        const hondo = (A: P[], B: P[]) => {
          let min = Infinity;
          for (const Q of [A, B]) {
            for (let i = 0; i < 4; i++) {
              const [x1, y1] = Q[i], [x2, y2] = Q[(i + 1) % 4];
              const nx = y1 - y2, ny = x2 - x1, n = Math.hypot(nx, ny) || 1;
              const pa = A.map(([x, y]) => (x * nx + y * ny) / n), pb = B.map(([x, y]) => (x * nx + y * ny) / n);
              const o = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
              if (o <= 0) return 0;
              min = Math.min(min, o);
            }
          }
          return min;
        };
        // Whether a point is inside a quad, `m` px in from its edges (negative: out).
        const enQuad = (Q: P[], [x, y]: P, m: number) => {
          for (let i = 0; i < 4; i++) {
            const [x1, y1] = Q[i], [x2, y2] = Q[(i + 1) % 4];
            if ((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1) < m * Math.hypot(x2 - x1, y2 - y1)) return false;
          }
          return true;
        };
        const svgEl = document.querySelector('svg.pq')!;
        const textos = [...svgEl.querySelectorAll('text')].filter((t) => t.textContent?.trim());
        const cajas: { n: string; q: P[]; el: Element; texto: boolean }[] = [];
        for (const t of textos) {
          const cs = getComputedStyle(t);
          if (!/^"?Inter/.test(cs.fontFamily)) out.push('«' + t.textContent + '» is not set in Inter');
          const m = (t as any).getScreenCTM();
          const px = parseFloat(cs.fontSize) * Math.hypot(m.a, m.b);
          if (px < 9.95) out.push('«' + t.textContent + '» is set at ' + px.toFixed(1) + ' px');
          // The box runs from ascender to descender; a line's ink does not. And
          // it is widened 2 px each way along its own line: two words closer
          // than 4 px read as one.
          const q = quad(t, 0.18);
          const dx = q[1][0] - q[0][0], dy = q[1][1] - q[0][1], n = Math.hypot(dx, dy) || 1;
          const ux = (dx / n) * 2, uy = (dy / n) * 2;
          cajas.push({
            n: '«' + t.textContent + '»',
            q: [[q[0][0] - ux, q[0][1] - uy], [q[1][0] + ux, q[1][1] + uy], [q[2][0] + ux, q[2][1] + uy], [q[3][0] - ux, q[3][1] - uy]],
            el: t,
            texto: true,
          });
        }
        const formas = [...svgEl.querySelectorAll('rect.pq-badge, rect.pq-bay-tag, rect.pq-placa, g[role="img"] > rect')]
          .filter((r) => r.getAttribute('fill') !== 'none');
        for (const f of formas) cajas.push({ n: '[' + (f.parentElement?.textContent || f.classList[0]) + ']', q: quad(f), el: f, texto: false });
        // A shape's own words: inside its group, or the text right after it.
        const propio = (f: Element, t: Element) =>
          (f.parentElement === t.parentElement && !['svg', 'a'].includes(f.parentElement!.tagName)) || f.nextElementSibling === t;
        // Lettering laid ON another plate, on a plate of its own with no fill.
        const encima = (t: Element, f: Element) =>
          t.previousElementSibling?.getAttribute('fill') === 'none' && f.classList.contains('pq-placa');
        for (let i = 0; i < cajas.length; i++) {
          for (let j = i + 1; j < cajas.length; j++) {
            const a = cajas[i], c = cajas[j];
            if (!a.texto && !c.texto) continue;
            if ((a.texto && !c.texto && (propio(c.el, a.el) || encima(a.el, c.el))) ||
                (c.texto && !a.texto && (propio(a.el, c.el) || encima(c.el, a.el)))) continue;
            if (hondo(a.q, c.q) > 0.8) out.push(a.n + ' runs into ' + c.n);
          }
        }
        for (const f of formas.filter((f) => !f.parentElement?.matches('g[role="img"]'))) {
          const fq = quad(f);
          for (const t of textos.filter((t) => propio(f, t))) {
            if (!quad(t, 0.18).every((p) => enQuad(fq, p, -0.6))) out.push('«' + t.textContent + '» spills out of its ' + f.classList[0]);
          }
        }
        // No badge, tag or plate sits on a tunnel, a crossing, a pictogram or
        // another one: AV. 1° de Mayo's M83 hung over the tunnel's mouth. Each
        // is sampled on a grid, every point asked of the obstacle in its own
        // coordinates. Two plates stacked into one sign only meet at an edge.
        const piezas = formas.filter((f) => !f.parentElement?.matches('g[role="img"]'));
        const estorbos = [...piezas, ...svgEl.querySelectorAll('path.pq-tunel, rect.pq-paso, ' +
          'g[role="img"]:not([aria-label="Paso entre vagones"]) > rect')] as any[];
        piezas.forEach((a: any, ia) => {
          const b = a.getBBox(), ma = a.getScreenCTM();
          const pts: DOMPoint[] = [];
          for (let i = 0; i <= 6; i++) {
            for (let j = 0; j <= 3; j++) {
              pts.push(new DOMPoint(b.x + b.width * (0.04 + (0.92 * i) / 6), b.y + b.height * (0.08 + (0.84 * j) / 3)).matrixTransform(ma));
            }
          }
          for (const e of estorbos) {
            const ie = piezas.indexOf(e);
            if (e === a || (ie >= 0 && ie < ia)) continue;
            // One route's badges share a group; so do a tag and its link.
            if (a.parentElement === e.parentElement && a.parentElement.tagName !== 'svg') continue;
            if (a.classList.contains('pq-placa') && e.classList.contains('pq-placa')) {
              const ra = a.getBoundingClientRect(), re = e.getBoundingClientRect();
              if (Math.min(ra.bottom, re.bottom) - Math.max(ra.top, re.top) < 3) continue;
            }
            const inv = e.getScreenCTM().inverse();
            if (pts.some((p) => e.isPointInFill(p.matrixTransform(inv)))) {
              out.push('[' + (a.parentElement?.textContent || a.nextElementSibling?.textContent || a.classList[0]) + '] sits on ' +
                (e.classList[0] ?? e.parentElement?.getAttribute('aria-label')));
            }
          }
        });
        const lienzo = svgEl.getBoundingClientRect();
        for (const t of textos) {
          if (!quad(t, 0.18).every(([x, y]) => x >= lienzo.left - 0.5 && x <= lienzo.right + 0.5 && y >= lienzo.top - 0.5 && y <= lienzo.bottom + 0.5)) {
            out.push('«' + t.textContent + '» is cut off by the edge of the drawing');
          }
        }
        // Kerbs and ruled lines, sampled along their length.
        for (const p of [...svgEl.querySelectorAll('path, line')] as any[]) {
          const kerb = (p.getAttribute('stroke') ?? '').toUpperCase() === '#FEED01';
          if (!kerb && !p.classList.contains('pq-linea')) continue;
          const m = p.getScreenCTM();
          const sw = (parseFloat(p.getAttribute('stroke-width') ?? '1') * Math.hypot(m.a, m.b)) / 2;
          const pts: P[] = [];
          for (let l = 0, L = p.getTotalLength(); l <= L; l += 0.5) {
            const q = p.getPointAtLength(l);
            pts.push([m.a * q.x + m.c * q.y + m.e, m.b * q.x + m.d * q.y + m.f]);
          }
          for (const t of textos) {
            // On its own badge, tag or plate, painted over the line: hidden.
            const suyo = formas.find((f) => propio(f, t));
            if (suyo && p.compareDocumentPosition(suyo) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
            // A rule under a haloed word is knocked out around its letters.
            const cs = getComputedStyle(t);
            const halo = parseFloat(cs.strokeWidth) > 0 && cs.stroke !== 'none';
            if (!kerb && halo && p.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
            // A line that only grazes a word's ascenders is not striking it through.
            const Q = quad(t, 0.22);
            if (pts.some((pt) => enQuad(Q, pt, -sw + 1))) out.push('«' + t.textContent + '» is struck through by a ' + (kerb ? 'kerb' : 'rule'));
          }
        }
        return out;
      });
      for (const h of hallado) wrong.push(code + ': ' + h);
      // Every route a bay carries is a tag, and the tag is a link.
      const dibujadas = new Set([...(geo.tirasAng ?? []), ...(geo.tiras ?? [])].map((t: any) => t.tira));
      for (const tira of zonal.filter((z: any) => dibujadas.has(z.nombre))) {
        for (const it of (tira.items ?? []).filter((i: any) => i.t === 'bahia')) {
          for (const r of it.rutas ?? []) {
            const enlace = new RegExp('<a data-x href="/ruta/' + r.codigo + '/" class="pq-link pq-bay-link"[^>]*>' +
              '(?:(?!</a>).)*<rect class="pq-bay-tag"(?:(?!</a>).)*>' + r.codigo + '</text>');
            if (!enlace.test(svg)) wrong.push(code + ': bay ' + r.codigo + ' is not a tag linked to its route');
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
