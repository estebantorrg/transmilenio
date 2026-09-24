/**
 * A portal drawn on its sheet's own coordinates.
 *
 * The column model in `plano.js` lays boxes in a row. That is right for an
 * ordinary estación — a straight platform with blocks at its ends — and cannot
 * say what a portal is: a closed loop, with the buses turning at both ends, one
 * bridge crossing every platform at one point, and the bays cut into the inner
 * edge with their names out on the roadway. This draws that instead.
 *
 * Every number comes from `plano_geo.json`, and every number in there was READ
 * off the operator's sheet rather than estimated — the kerbs and the ring by
 * colour, the furniture by a dark-column profile of its band, the labels by
 * their own bounding boxes. The viewBox is the sheet's own page, so a
 * coordinate here IS a coordinate there and the proportions cannot drift.
 *
 * The output is ONE self-contained SVG string with its colours inline. That is
 * deliberate: the app and the prerender emit the same bytes, so the two cannot
 * disagree the way the two stylesheets did — fourteen stations once drew an
 * invisible divider because only one of them had the rule.
 */
import { ICONOS, escapeHtml } from './plano.js';

/**
 * The drawing's surfaces, named. Geometry is identical in both themes; only the
 * greys move. The troncal colours are NOT in here — those are the operator's
 * identity and stay exactly as printed whichever theme is on.
 */
export const PALETA = {
  papel: {
    papel: '#FFFFFF', anden: '#D9D9D9', trazo: '#231F20', tunel: '#EFEFEF',
    bahia: '#9C9C9C', radios: '#C4C4C4', verde: '#CCDCAD', eje: '#B4B4B4',
    bloque: '#B9B9B9', descanso: '#E9E9E9', escalera: '#BEBEBE', peldano: '#8E8E8E',
    rampa: '#D2D2D2', regla: '#D7D7D7', tinta: '#231F20', tenue: '#5A5A5A',
    punteado: '#A8A8A8', losa: '#A6A6A6', caja: '#F6F6F6', glifo: '#9D9D9D',
  },
  // The app's own surfaces (`client/style.css` :root): the page is
  // --bg-primary, a platform is --bg-secondary, a rule a step above
  // --border-card (at --border-card itself a bay's marker vanished into its bar), and
  // everything between is a step of the same cool grey, so the plan reads as
  // part of the page rather than as a picture pasted onto it.
  oscuro: {
    papel: '#0C0C0C', anden: '#202329', trazo: '#62666F', tunel: '#16181C',
    bahia: '#34373F', radios: '#3A3D45', verde: '#243220', eje: '#2B2E35',
    bloque: '#33373F', descanso: '#1A1C21', escalera: '#2B2E35', peldano: '#4D5059',
    rampa: '#26292F', regla: 'rgba(255,255,255,.14)', tinta: '#FFFFFF',
    tenue: 'rgba(255,255,255,.6)',
    punteado: 'rgba(255,255,255,.3)', losa: '#2E3139', caja: '#2B2E35', glifo: '#C9CCD2',
  },
};

// Sampled off the sheets rather than eyeballed: both Portal Norte and Portal 80
// print their kerbs at 254,237,1, which is a greener yellow than the one this
// drawing used.
const KERB = '#FEED01';
const TILE_BG = '#0E0E10';

/**
 * The sheet's own turnstile.
 *
 * `ICONOS.torniquete` fills about 62% of its tile's width and 48% of its height;
 * the sheet's fills roughly three quarters of both — two tall pillars, notched
 * at the top, with the arm slung between them. At 12x the difference is not
 * subtle, and the furniture rows are half turnstiles, so it was most of what
 * those rows' error was made of.
 */
const TORNIQUETE = {
  label: 'Torniquetes',
  vb: '0 0 24 24',
  svg:
    '<rect x="2.9" y="4.1" width="5.6" height="16.4" rx="0.8" fill="#FFFFFF"/>' +
    '<rect x="15.6" y="4.1" width="5.6" height="16.4" rx="0.8" fill="#FFFFFF"/>' +
    '<path d="M3.9 7.4 5.7 4.3 7.5 7.4z" fill="#0E0E10"/>' +
    '<path d="M16.6 7.4 18.4 4.3 20.2 7.4z" fill="#0E0E10"/>' +
    '<path d="M8.5 10.9 15.6 13.6" stroke="#FFFFFF" stroke-width="1.7" stroke-linecap="round"/>',
};

const num = (v) => (Math.round(v * 100) / 100).toString();

/**
 * The portal, as one SVG string.
 *
 * @param {object} input
 * @param {any} input.geo               the station's measured geometry
 * @param {any} input.detalle           its `planoDetalle`, for what the strips carry
 * @param {any} input.layout            its `planoLayout`, unused today, kept for parity
 * @param {Map<string, any[]>} [input.byCode]   catalog routes, keyed by código
 * @param {(r: any) => string} [input.tagColor] a route's colour
 * @param {(r: any) => (string|null)} [input.routeHref] where a chip links
 * @param {'papel'|'oscuro'} [input.tema]
 * @returns {string}
 */
/**
 * Whether a station's geometry draws a portal at all: a ring, bands, or
 * platforms given as their own outline. Shared with the dispatch in `plano.js`
 * so the two cannot disagree about which stations are portals.
 */
export const esPortal = (geo) =>
  Boolean(geo && (geo.anillo || (geo.andenes ?? []).length || (geo.losas ?? []).length));

export function buildPortalSvg(input) {
  const geo = input.geo;
  // A station whose measurements are still being taken draws NOTHING here and
  // falls back to the column drawing. Half a portal — platforms and chips but no
  // bays and no furniture — is worse for a rider than the schematic it replaces,
  // so an unfinished entry stays in version control without shipping.
  if (geo?.borrador) return '';
  if (!geo || !esPortal(geo)) return '';
  // Not a palette but a set of references INTO one. Both palettes are written
  // into the drawing's own <style>, so the paper view is a class on the root
  // rather than a second render, and @media print can force it with nobody
  // toggling anything.
  // The station's OWN surfaces count as references too. A sheet prints things
  // this palette has no name for — Portal 20 de Julio's Super CADE blue, the
  // cream of the shops beside it, the beige of Carrera 5a and the green of its
  // evacuation route — and `tonos` already publishes each as a CSS variable in
  // both themes. Built from the palette's keys alone, a reference to one of
  // them came back undefined and the shape fell through to the platform grey,
  // which is how four coloured blocks were drawn as one grey slab.
  const C = Object.fromEntries(
    [...new Set([...Object.keys(PALETA.oscuro), ...Object.keys(geo.tonos ?? {})])]
      .map((k) => [k, 'var(--pq-' + k + ')'])
  );
  const inicial = input.tema === 'papel' ? ' pq-papel' : '';
  const D = input.detalle ?? {};
  const tiras = Object.fromEntries(
    (Array.isArray(D.zonal) ? D.zonal : D.zonal ? [D.zonal] : []).map((t) => [t.nombre, t])
  );

  /**
   * A platform drawn as a LOZENGE: a thick line with round ends.
   *
   * Portal Norte is a racetrack and its shape is four kerbs and two caps.
   * Portal 80 is nothing like it — two long lozenges lying diagonally, each
   * bending once in the middle — and no amount of parameterising a ring
   * describes that. So a portal's platforms are either a ring or a set of
   * these, and which one a station is comes from its own geometry.
   */
  const trazar = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ');

  const lozenge = (a) =>
    // No outline. The sheet draws these platforms as bare grey against the page
    // — what reads as their edge is the yellow kerb on the boarding side and
    // nothing at all on the other. An outline round the whole lozenge was the
    // single loudest difference at Portal 80: it drew a black racetrack where
    // the sheet has none.
    //
    // `cuadrado` squares the ends. Portal Sur's platforms stop dead and the
    // ROUND thing at each end is the planting behind them, so a platform drawn
    // with the round cap swallowed the green and came out 26px too long.
    '<path d="' + trazar(a.pts) + '" fill="none" stroke-linecap="' + (a.cuadrado ? 'butt' : 'round') +
    // In its own tone where the sheet gives the slab two: Portal Suba's platforms
    // are darker on one side of the spine than the other.
    '" stroke-linejoin="round" stroke="' + (a.tono ? C[a.tono] ?? C.anden : C.anden) + '" stroke-width="' + a.ancho + '"/>';

  /**
   * The line down the middle of an angled platform.
   *
   * It is not the platform's outline and not a kerb: it is the wall the shelters
   * back onto, and every piece of furniture is threaded onto it. Drawn from its
   * own measured points rather than from the axis, because the two are not quite
   * the same line and a degree of difference shows at this length.
   */
  // Given as bare points where it is the ink line Portal 80 draws, or as an
  // object where it is not: Portal Sur rules the same line a pale grey and a
  // third the weight, which at that size is a different mark, not the same one.
  const espina = (e) =>
    '<path d="' + trazar(Array.isArray(e) ? e : e.pts) + '" fill="none" stroke="' +
    (e.tono ? C[e.tono] ?? C.trazo : C.trazo) + '" stroke-width="' + (e.w ?? 1.5) +
    '" stroke-linecap="round"/>';

  /**
   * A point on a platform's axis, and the direction it runs there.
   *
   * On a ring everything can be given an x and a y and be done with it. On an
   * angled platform nothing can: a strip, a bay marker and a caption all sit at
   * an OFFSET from the axis, and the offset has to turn with the platform or it
   * walks off the end of it. So an angled feature is given the x it sits at and
   * how far off the axis it stands, and where that lands is worked out here.
   */
  const sobre = (i, x, off = 0) => {
    const a = (geo.andenes ?? [])[i];
    if (!a) return { x, y: 0, ux: 1, uy: 0 };
    const pts = a.pts;
    let k = 0;
    while (k < pts.length - 2 && x > pts[k + 1][0]) k++;
    const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
    const dx = x1 - x0, dy = y1 - y0, n = Math.hypot(dx, dy) || 1;
    const ux = dx / n, uy = dy / n;
    const t = (x - x0) / (dx || 1);
    return { x: x + -uy * off, y: y0 + dy * t + ux * off, ux, uy };
  };

  /** The angle a feature is set at, so it lies along its platform. */
  const giro = (i, x) => {
    const p = sobre(i, x);
    return (Math.atan2(p.uy, p.ux) * 180) / Math.PI;
  };

  /** A kerb: a straight run on a ring, a polyline on an angled platform. */
  const bordillo = (k) =>
    '<path d="' + (k.pts
      ? k.pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ')
      : 'M' + k.x0 + ',' + k.y + ' H' + k.x1) +
    // Three is Portal Norte's weight. Portal Sur rules its kerbs at half that,
    // so the width belongs to the station rather than to the renderer.
    '" fill="none" stroke="' + KERB + '" stroke-width="' + (k.w ?? geo.kerb ?? 3) +
    // Square where the sheet cuts it square. Portal 20 de Julio's kerbs run in
    // teeth that break at every step, and a round cap put a yellow blob at
    // both ends of all ten runs.
    '" stroke-linecap="' + (k.cuadrado ? 'butt' : 'round') + '" stroke-linejoin="round"/>';

  /**
   * A walled corridor: a light fill inside a DASHED outline.
   *
   * The pedestrian tunnel and the evacuation route are drawn this way — under
   * the station rather than on it, which is why the platforms are painted over
   * them and why their edges are broken rather than solid. Given as an axis and
   * a width, because that is what can be measured off the sheet; the four
   * corners are worked out here.
   */
  const corredor = (c) => {
    // Either an axis and a width, or the four corners outright: the tunnel runs
    // straight and is easiest as the first, while the evacuation route is cut
    // off square against the shopping centre at one end and against the tunnel
    // at the other, so its corners are measured rather than derived.
    let q = c.poly;
    if (!q) {
      const [a, b] = c.pts;
      const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1;
      const px = (-dy / n) * (c.ancho / 2), py = (dx / n) * (c.ancho / 2);
      q = [
        [a[0] + px, a[1] + py], [b[0] + px, b[1] + py],
        [b[0] - px, b[1] - py], [a[0] - px, a[1] - py],
      ];
    }
    return '<path d="' + trazar(q.map((p) => [num(p[0]), num(p[1])])) + ' Z" fill="' + C.tunel +
      '" stroke="' + C.punteado + '" stroke-width="0.7" stroke-dasharray="3 2.4"/>';
  };

  /**
   * A block given as a box rather than as its corners, so it can be rounded:
   * Portal Usme's entrance wing is a slab with soft corners, and four points
   * cannot say that.
   */
  const rectangulo = ([x, y, w, h], r) =>
    r
      ? 'M' + num(x + r) + ',' + y + ' H' + num(x + w - r) + ' A' + r + ',' + r + ' 0 0 1 ' + num(x + w) + ',' +
        num(y + r) + ' V' + num(y + h - r) + ' A' + r + ',' + r + ' 0 0 1 ' + num(x + w - r) + ',' + num(y + h) +
        ' H' + num(x + r) + ' A' + r + ',' + r + ' 0 0 1 ' + x + ',' + num(y + h - r) + ' V' + num(y + r) +
        ' A' + r + ',' + r + ' 0 0 1 ' + num(x + r) + ',' + y + ' Z'
      : 'M' + x + ',' + y + ' h' + w + ' v' + h + ' h' + -w + ' Z';

  /**
   * A round hall, and the stair that winds round inside it.
   *
   * Portal Usme's entrance is two drums — Planta Alta over Planta Baja — each
   * ruled with RADIAL treads: a spiral stair seen from above. The treads belong
   * to their own disc and are drawn with it, because the upper drum covers the
   * lower one's stair except where it shows beneath, and drawn in a pass of
   * their own they came out on top of the floor that hides them.
   */
  const circulo = (c) => {
    let out = '<circle cx="' + c.x + '" cy="' + c.y + '" r="' + c.r + '" fill="' +
      (c.tono ? C[c.tono] ?? C.anden : C.anden) + '"/>';
    const p = c.peldanos;
    if (p) {
      for (let i = 0; i < p.n; i++) {
        const a = ((p.desde ?? 0) + (i * 360) / p.n) * (Math.PI / 180);
        const ux = Math.cos(a), uy = Math.sin(a);
        out += '<line x1="' + num(c.x + ux * p.r0) + '" y1="' + num(c.y + uy * p.r0) + '" x2="' +
          num(c.x + ux * p.r1) + '" y2="' + num(c.y + uy * p.r1) + '" stroke="' +
          (p.tono ? C[p.tono] ?? C.peldano : C.peldano) + '" stroke-width="' + (p.w ?? 0.6) + '"/>';
      }
    }
    return out;
  };

  /** A run of planting: the same thick round-capped line a platform is, in green. */
  const jardin = (g) =>
    '<path d="' + trazar(g.pts) + '" fill="none" stroke="' + C.verde + '" stroke-width="' + g.ancho +
    '" stroke-linecap="round" stroke-linejoin="round"/>';

  /** The street a station stands on, ruled thin and named along itself. */
  // Any surface in the palette, not just the ink one: the rules Portal Sur uses
  // to separate its three platforms are a whisper, and drawn in ink they read as
  // three boxes round the drawing instead.
  const linea = (l) =>
    '<path class="pq-linea" d="' + trazar(l.pts) + '" fill="none" stroke="' + (l.color ? C[l.color] ?? C.trazo : C.trazo) +
    '" stroke-width="' + (l.w ?? 0.9) +
    // Broken where the sheet breaks it: Portal 20 de Julio rules the boundary
    // of the plaza it stands in as a dashed blue line, which drawn solid reads
    // as a wall around a square anyone can walk across.
    (l.guion ? '" stroke-dasharray="' + l.guion : '') +
    '" stroke-linecap="round"/>';

  /**
   * One flight of the escalator bank beside the shopping centre.
   *
   * The sheet draws these in plan as a stubby bar with the nosings stepped along
   * its top edge — not the pictogram tile the platforms use, because these are
   * the structure itself rather than a sign pointing at it.
   */
  const escalon = (e) =>
    '<rect x="' + num(e.x - 5) + '" y="' + num(e.y - 2.4) + '" width="10" height="4.8" rx="2.4" fill="' +
    C.trazo + '"/>' +
    '<path d="M' + num(e.x - 2.8) + ',' + num(e.y - 2.2) + ' l1.3,-1.5 l1.3,1.5 h0.7 l1.3,-1.5 l1.3,1.5 z" fill="' +
    C.trazo + '"/>';

  /**
   * Where the tunnel comes up onto a platform: a ramp with a flight of steps
   * either side of it, laid ALONG the platform and sitting on the spine.
   *
   * The treads are ruled across it rather than drawn as a hatch pattern, so they
   * turn with the platform and stay the same width whatever the drawing is
   * scaled to.
   */
  const desembarco = (d) => {
    // On a platform it hangs off that platform's axis; standing on its own — the
    // flight inside the Acceso peatonal block, which belongs to no platform — it
    // is given its own two rows instead.
    const sueltoY = d.anden === undefined;
    const sobreD = sueltoY
      ? (_i, x, off) => ({ x, y: off < 0 ? d.y0 : d.y1 })
      : sobre;
    const quiebres = ((geo.andenes ?? [])[d.anden]?.pts ?? [])
      .slice(1, -1)
      .map((p) => p[0])
      .filter((x) => x > d.desde && x < d.hasta);
    const xs = [d.desde, ...quiebres, d.hasta];
    const alto = d.h ?? 13;
    const borde = [
      ...xs.map((x) => sobreD(d.anden, x, 0)),
      ...[...xs].reverse().map((x) => sobreD(d.anden, x, -alto)),
    ];
    // In the landing grey, or paler where the sheet draws the slope of a ramp
    // rather than a flight of steps.
    let out = '<path class="pq-desembarco" d="' + trazar(borde.map((p) => [num(p.x), num(p.y)])) + ' Z" fill="' +
      (d.fondo ? C[d.fondo] ?? C.losa : C.losa) + '"/>';
    for (const [a, b] of d.tramos ?? []) {
      for (let x = a; x <= b + 0.01; x += d.paso ?? 2.2) {
        const p0 = sobreD(d.anden, x, 0), p1 = sobreD(d.anden, x, -alto);
        out += '<line x1="' + num(p0.x) + '" y1="' + num(p0.y) + '" x2="' + num(p1.x) + '" y2="' +
          // Knocked out in the page colour, unless the sheet rules them fainter:
          // Portal Usme's tunnel-mouth treads are a whisper on the grey.
          num(p1.y) + '" stroke="' + (d.tono ? C[d.tono] ?? C.papel : C.papel) + '" stroke-width="' + (d.w ?? 0.9) + '"/>';
      }
    }
    return out;
  };

  /**
   * The north point.
   *
   * Every sheet that is not drawn with north up carries one, and a plan without
   * it is a plan a rider cannot turn to face the right way. Drawn rather than
   * lettered so it survives the theme: the disc is the kerb yellow in both.
   */
  const norte = (n) => {
    const r = n.r ?? 15;
    // Two ways a sheet draws it. Portal Sur letters the N inside the disc under a
    // small arrowhead; Portal Usme fills the disc with one large arrowhead, TURNED
    // to where north is on its page, and sets the N underneath.
    const flecha = n.ang === undefined
      ? '<path d="M' + num(n.x) + ',' + num(n.y - r * 0.68) + ' l' + num(r * 0.26) + ',' + num(r * 0.38) +
        ' h-' + num(r * 0.52) + ' z" fill="#231F20"/>'
      : '<path d="M' + num(n.x) + ',' + num(n.y - r * 0.44) + ' l' + num(r * 0.55) + ',' + num(r * 0.74) +
        ' h' + num(-r * 1.1) + ' z" fill="#231F20" transform="rotate(' + n.ang + ' ' + n.x + ' ' + n.y + ')"/>';
    return '<g role="img" aria-label="Norte">' +
      // Not always the kerb's yellow: Portal Usme prints its north disc paler.
      '<circle cx="' + n.x + '" cy="' + n.y + '" r="' + r + '" fill="' + (n.color ?? KERB) + '" stroke="#231F20" stroke-width="' +
      num(n.borde ?? r * 0.1) + '"/>' + flecha +
      (n.abajo === undefined
        ? '<text x="' + n.x + '" y="' + num(n.y + r * 0.45) + '" class="pq-norte">N</text>'
        : '<text x="' + n.x + '" y="' + num(n.y + n.abajo) + '" class="pq-norte pq-norte-fuera">N</text>') +
      '</g>';
  };

  /** A sign on the page rather than on a platform: green, and set at an angle. */
  const senal = (s) => {
    const i = ICONOS[s.icono];
    if (!i) return '';
    const lado = s.lado ?? s.h - 2.6;
    const glifo = '<svg x="' + num(s.x + s.w / 2 - lado - (s.margen ?? 1.3)) + '" y="' + num(s.y - lado / 2) +
      '" width="' + num(lado) + '" height="' + num(lado) + '" viewBox="' + (i.vb || '0 0 24 24') + '">' + i.svg + '</svg>';
    return '<g transform="rotate(' + num(s.ang ?? 0) + ' ' + s.x + ' ' + s.y + ')" role="img" aria-label="' +
      escapeHtml(i.label) + '">' +
      '<rect class="pq-senal" x="' + num(s.x - s.w / 2) + '" y="' + num(s.y - s.h / 2) + '" width="' + s.w +
      '" height="' + s.h + '" fill="' + (i.bg ?? '#2E9E4F') + '"/>' +
      // A route sign faces the way the route runs, so the far side of a tunnel
      // prints the same sign MIRRORED rather than a different one.
      (s.espejo
        ? '<g transform="translate(' + num(s.x * 2) + ' 0) scale(-1 1)">' + glifo + '</g>'
        : glifo) +
      '</g>';
  };

  const A = geo.anillo ?? {};
  const hayAnillo = Boolean(geo.anillo);
  const TILE = geo.teja ?? 18;

  /** Boxes a lane rule has to keep clear of, gathered as the drawing is built. */
  const ocupado = (geo.reservado ?? []).map((b) => ({ ...b }));

  /**
   * A station may print its furniture the other way round.
   *
   * Portal Norte and Portal 80 knock the glyph out of a black tile. Portal Sur
   * sets the same marks as a grey glyph on a PALE one, which at seventeen pixels
   * is the most visible thing about its furniture. The glyphs are shared, so the
   * two colours in them are swapped for the station's own rather than a second
   * set of icons being drawn.
   */
  const claro = geo.tejaEstilo === 'claro';
  const TEJA_BG = claro ? C.caja : TILE_BG;
  const TEJA_TINTA = claro ? C.glifo : null;

  const tile = (name, x, y, s = TILE, fondoPedido) => {
    const i = name === 'torniquete' ? TORNIQUETE : ICONOS[name];
    if (!i) return '';
    // A mark whose colour is part of it keeps it: the priority lift's wheelchair
    // is blue by law, and on a black tile it read as one more piece of furniture.
    const fondo = fondoPedido ?? (i.bg && i.bg !== TILE_BG ? i.bg : TEJA_BG);
    const pad = s * 0.055;
    const glifo = TEJA_TINTA
      ? i.svg.split('#FFFFFF').join(TEJA_TINTA).split(TILE_BG).join(fondo)
      : i.svg;
    return (
      '<g transform="translate(' + num(x) + ' ' + num(y) + ')" role="img" aria-label="' +
      escapeHtml(i.label) + '">' +
      '<rect width="' + num(s) + '" height="' + num(s) + '" fill="' + fondo + '"/>' +
      '<svg x="' + num(pad) + '" y="' + num(pad) + '" width="' + num(s - pad * 2) +
      '" height="' + num(s - pad * 2) + '" viewBox="' + (i.vb || '0 0 24 24') + '">' + glifo + '</svg></g>'
    );
  };

  const TRONCAL = {
    A: '#1B3A8C', B: '#7AB929', C: '#F5A623', D: '#8B6FC4', E: '#8A6A2F', F: '#E32219',
    G: '#29A8DC', H: '#E8730C', J: '#E39BB4', K: '#D6BE95', L: '#12A89D', M: '#5AC8B0',
    P: '#C86AA8', S: '#29A8DC', Z: '#E32219',
  };
  /** A chip's colour: the catalog's where we have the route, the troncal letter's otherwise. */
  const colorDe = (codigo) => {
    const ruta = (input.byCode?.get(String(codigo).toUpperCase()) ?? [])[0];
    if (ruta && input.tagColor) return input.tagColor(ruta);
    // A plain number is the sheet's own black badge; `10-4` is a zonal route,
    // which the catalog prints green and which this fell through to grey on —
    // visible at Portal Sur, where nine bays out of thirteen are zonal.
    if (/^\d+$/.test(codigo)) return '#111111';
    if (/^\d+-/.test(codigo)) return '#3D6739';
    return TRONCAL[codigo[0]] ?? '#555555';
  };
  // A código the station's own routes do not carry is still a route: Portal
  // Usme's notice moved five services onto Plataforma 2 before the catalog
  // re-filed them there, and those five bays were the only ones on the page a
  // rider could not open. The caller answers from the código alone — the
  // prerender with null where the network has no such route.
  const hrefDe = (codigo) => {
    const ruta = (input.byCode?.get(String(codigo).toUpperCase()) ?? [])[0] ?? { codigo: String(codigo) };
    return input.routeHref ? input.routeHref(ruta) : null;
  };

  const CH = geo.chip ?? {};
  // The sheet's badge, or wider where the app's face needs the room: Inter's
  // bold códigos run a fifth wider than the condensed face the sheets set, and
  // measured by the sheet alone "D21" came out through both ends of its badge.
  const anchoChip = (c) =>
    Math.max(CH.min ?? 19, c.length * (CH.k ?? 7.4) + 5, anchoCodigo(c, tam('chip')) + ALTO_CHIP * 0.3);
  const ALTO_CHIP = CH.h ?? 23;
  // The badges are ROUNDED, like every route tag the app draws elsewhere: the
  // sheets print square corners, but a rider meets these códigos as rounded
  // tags on every other surface here — the popup, the estación page, the
  // route list — and a square one on the portal read as a different kind of
  // thing. The app's tag is 22px tall on a 5px radius, so the corner is that
  // proportion of whatever height the station's own badge is.
  const RADIO_CHIP = CH.rx ?? ALTO_CHIP * (5 / 22);
  const SUB_Y = CH.sub ?? 6;

  /**
   * The LEGIBILITY FLOOR: no text on a portal is set smaller than 10 px on
   * screen, at the smallest scale the page ever draws it.
   *
   * The sizes in `tipo` are the sheet's own, and a sheet is printed for a wall.
   * Portal Tunal's is drawn at half the scale of the others, so its bay names
   * came out at three and a half pixels — a grey smudge under each bay — and
   * Portal 20 de Julio's at five; even the portals drawn at full scale set their
   * captions a pixel or two under anything the app sets elsewhere. A plan whose
   * words cannot be read has failed at the one thing a rider opens it for, so
   * the sheet's size is kept where it is legible and raised to the floor where
   * it is not. The page never draws a portal under 1.12 px per pixel of a
   * 1024-wide sheet (`.popup-plano-portal .pq`, `client/style.css`) — times
   * the station's `escala` where its sheet is drawn small — so the floor is
   * fixed in the drawing's own units from that.
   */
  const PISO = 10 / (1.12 * (1024 / (geo.hoja ?? 1024)) * (geo.escala ?? 1));
  const legible = (v) => Math.max(v, PISO);
  /** The sheet's size for a class, the station's own where it measured one. */
  const TIPO = {
    chip: 11.5, 'chip-sub': 4.6, cap: 8, bay: 6.8, tag: 7.4, place: 10.5, 'place-sm': 8, 'place-en': 5.8,
    street: 12.5, anchor: 8.6, ruta: 8, sub: 7, 'sub-sm': 5.6, norte: 14, 'norte-fuera': 24,
    ...(geo.tipo ?? {}),
  };
  const tam = (k) => legible(TIPO[k] ?? PISO);
  // A strapline over a badge's código is text a rider reads — "Portal Usme",
  // "Portal Tunal" — so it is held to the floor too, and the badge grows to
  // carry it rather than the words shrinking to fit the badge.
  const CRECE_SUB = tam('chip-sub') - TIPO['chip-sub'];

  /**
   * How wide a run of text will set, near enough to lay things out by.
   *
   * The drawing cannot measure its own text — it is a string, built where there
   * is no layout engine — so widths are estimated from the character count at
   * Inter's average advance, measured off the app's own font file: 0.49 em for
   * a regular name, 0.52 for a bold one. Generous rather than tight: a tag that
   * is a little roomy reads fine where one that clips its código does not.
   */
  const anchoTexto = (s, fs, k = 0.5) => String(s).length * fs * k;
  /**
   * A código's width in Inter bold, by what it is made of — digits, dashes and
   * a capital or two, not running text: 0.62 em a digit, 0.47 a dash, 0.69 a
   * capital, measured off the font. Averaged like a word, "13-10" came out
   * wider than the room between two of Portal 20 de Julio's bays.
   */
  const anchoCodigo = (c, fs) =>
    [...String(c)].reduce((a, ch) => a + (/\d/.test(ch) ? 0.63 : /[-.]/.test(ch) ? 0.48 : 0.71), 0) * fs;

  // A bay's código is a ROUTE TAG, the same rounded tag the app draws for a
  // route everywhere else, and a link to that route. The sheets set it as a
  // bold word in front of the destination, which at a bay's size was the least
  // legible thing on the page and the one thing a rider came to find.
  const FS_BAY = tam('bay');
  const FS_COD = legible(TIPO['bay-code'] ?? TIPO.bay);
  const ALTO_TAG = FS_COD * 1.34;
  const anchoTag = (c) => anchoCodigo(c, FS_COD) + FS_COD * 0.7;
  // Lines of a name block: a tag line is as tall as its tag, a text line as
  // tall as its face, and the gap between them is a fraction of the face.
  const ALTO_LINEA = FS_BAY * 1.08;
  const HUECO_LINEA = FS_BAY * 0.15;

  /**
   * One bay's name block: each route's código as a tag, its destination beside
   * or under it, the whole of it a link to the route.
   *
   * `lineas` is a list of lines, each `{ tags, texto, ruta }` — tags a list of
   * códigos, texto already escaped, ruta the código the line belongs to (for
   * its link). Laid out from `y` downward, or upward from it where the strip
   * stacks its names up off the kerb, left-aligned from `x` or centred on it.
   */
  function bloqueBahia(lineas, { x, y, arriba = false, centrado = false, fin = false, salto = 0 }) {
    // `salto` drops a name further under its tag: where bays stand closer
    // than their names are wide, every other bay's name goes a row lower, so
    // two neighbours' names never share a row.
    const altos = lineas.map((l, k) =>
      (l.tags ?? []).length
        ? ALTO_TAG + (l.texto || !lineas[k + 1] || (lineas[k + 1].tags ?? []).length ? 0 : salto)
        : ALTO_LINEA
    );
    const total = altos.reduce((a, b) => a + b, 0) + HUECO_LINEA * Math.max(0, lineas.length - 1);
    let top = arriba ? y - total : y;
    const porRuta = new Map();
    lineas.forEach((l, k) => {
      const tags = l.tags ?? [];
      const alto = tags.length ? ALTO_TAG : altos[k];
      const anchos = tags.map(anchoTag);
      const anchoTags = anchos.reduce((a, b) => a + b, 0) + Math.max(0, tags.length - 1) * FS_COD * 0.3;
      const anchoTxt = l.texto ? anchoTexto(l.textoPlano ?? l.texto, FS_BAY, 0.47) : 0;
      const separa = tags.length && l.texto ? FS_BAY * 0.35 : 0;
      // Ending AT x (`fin`), the tag against the bay and the name running back
      // from it: set by its own end, so it needs no estimate of its width.
      let cx = fin ? x - anchoTags : centrado ? x - (anchoTags + separa + anchoTxt) / 2 : x;
      let svg = '';
      // Two códigos on one line each open their OWN route: the line is not
      // one route's, so it cannot be wrapped as one link.
      const varias = tags.length > 1;
      tags.forEach((c, i) => {
        const fondo = colorDe(c);
        const borde = /^#(0|1)/.test(fondo) ? ' stroke="' + C.trazo + '" stroke-width="0.6"' : '';
        const tag = '<rect class="pq-bay-tag" x="' + num(cx) + '" y="' + num(top) + '" width="' + num(anchos[i]) +
          '" height="' + num(ALTO_TAG) + '" rx="' + num(ALTO_TAG * (5 / 22)) + '" fill="' + fondo + '"' + borde + '/>' +
          '<text x="' + num(cx + anchos[i] / 2) + '" y="' + num(top + ALTO_TAG / 2 + FS_COD * 0.36) +
          '" class="pq-bay-cod">' + escapeHtml(c) + '</text>';
        const href = varias ? hrefDe(c) : null;
        svg += href
          ? '<a href="' + escapeHtml(href) + '" class="pq-link pq-bay-link" aria-label="Ruta ' + escapeHtml(c) + '">' + tag + '</a>'
          : tag;
        cx += anchos[i] + FS_COD * 0.3;
      });
      if (l.texto) {
        const tx = fin ? x - anchoTags - separa : tags.length ? cx - FS_COD * 0.3 + separa : x;
        const ty = top + alto / 2 + FS_BAY * 0.35;
        const suelto = !tags.length && centrado;
        svg += '<text x="' + num(tx) + '" y="' + num(ty) + '" class="pq-bay' +
          (fin ? ' pq-bay-fin' : suelto ? '' : ' pq-bay-izq') + '">' + l.texto + '</text>';
      }
      const clave = (varias ? null : l.ruta) ?? '#' + k;
      porRuta.set(clave, (porRuta.get(clave) ?? '') + svg);
      top += altos[k] + HUECO_LINEA;
    });
    return [...porRuta.entries()]
      .map(([ruta, svg]) => {
        const href = ruta.startsWith('#') ? null : hrefDe(ruta);
        if (!href) return svg;
        const destino = lineas.find((l) => l.ruta === ruta && l.textoPlano)?.textoPlano;
        return '<a href="' + escapeHtml(href) + '" class="pq-link pq-bay-link" aria-label="Ruta ' + escapeHtml(ruta) +
          (destino ? ' hacia ' + escapeHtml(destino) : '') + '">' + svg + '</a>';
      })
      .join('');
  }

  /**
   * The lines a bay's names are set in: one route per tag, its destination on
   * the same line where the sheet keeps them together (`una`) and under it
   * otherwise; codes sharing one destination side by side on one line (`junta`).
   */
  function lineasBahia(it, b = {}) {
    const texto = (s) => ({ texto: escapeHtml(s), textoPlano: s });
    // A bay that carries a route keeps its tag even where the sheet words it
    // its own way: Portal Sur prints "Circular San Mateo" for CSM, and without
    // the tag it was the one bay on the page a rider could not open.
    if (b.texto) {
      const cods = (it.rutas ?? []).map((r) => r.codigo);
      if (!b.texto.length || !cods.length) return b.texto.map(texto);
      const lineas = b.texto.map((s) => ({ ...texto(s), ruta: cods[0] }));
      return b.una
        ? [{ tags: cods, ...lineas[0] }, ...lineas.slice(1)]
        : [{ tags: cods, ruta: cods[0] }, ...lineas];
    }
    if (it.llegada) return [texto('Llegada de pasajeros')];
    if ((it.destinos ?? []).length) return (b.partir ?? it.destinos).map(texto);
    const rutas = it.rutas ?? [];
    if (b.junta) {
      return [
        { tags: rutas.map((r) => r.codigo), ruta: rutas[0]?.codigo },
        { ...texto(rutas[0]?.destino ?? ''), ruta: rutas[0]?.codigo },
      ];
    }
    return rutas.flatMap((r) => {
      // A destination too long for the room between two bays is broken where
      // the station says, word by word.
      // Given as a list for a one-route bay, or by código where the bay has two.
      const partes = (Array.isArray(b.partir) ? (rutas.length === 1 ? b.partir : null) : b.partir?.[r.codigo]) ??
        [r.destino ?? ''];
      return b.una
        ? [{ tags: [r.codigo], ...texto(partes[0]), ruta: r.codigo }, ...partes.slice(1).map((p) => ({ ...texto(p), ruta: r.codigo }))]
        : [{ tags: [r.codigo], ruta: r.codigo }, ...partes.map((p) => ({ ...texto(p), ruta: r.codigo }))];
    });
  }

  /** A run of chips, butted together the way the sheet sets them. */
  function chips(grupo) {
    let cx = grupo.x, out = '';
    // On an ANGLED platform a sheet may turn the badges with it: Portal Tunal
    // sets B27 and B13 along Plataforma 2 at the platform's own angle, while
    // Portal 80 leaves its upright. Which it is belongs to the station, so the
    // group carries the platform it turns with or nothing at all.
    const vuelta = grupo.anden === undefined
      ? ''
      : 'rotate(' + num(giro(grupo.anden, grupo.x)) + ' ' + num(grupo.x) + ' ' + num(grupo.y) + ')';
    for (const c of grupo.codigos) {
      const sub = (grupo.sub ?? {})[c];
      const w = anchoChip(c);
      const href = hrefDe(c);
      // A badge printed BLACK — the one the sheet gives a plain service number —
      // disappears on the dark page. The outline is the ink colour, so on paper
      // it is black on black and invisible, and in the dark view it is the only
      // thing saying the badge is there.
      const fondo = colorDe(c);
      const borde = /^#(0|1)/.test(fondo) ? ' stroke="' + C.trazo + '" stroke-width="0.8"' : '';
      // Where the floor raised the strapline, the badge grows UPWARD by as much
      // and WIDER where the words need it, so the código stays where the sheet
      // puts it and the strapline gets the room instead of being squeezed.
      const extra = sub ? CRECE_SUB : 0;
      const ancho = sub ? Math.max(w, anchoTexto(sub, tam('chip-sub'), 0.6) + ALTO_CHIP * 0.3) : w;
      const cuerpo =
        '<rect class="pq-badge" ' + (extra ? 'y="' + num(-extra) + '" ' : '') + 'width="' + num(ancho) +
        '" height="' + num(ALTO_CHIP + extra) + '" rx="' + num(RADIO_CHIP) +
        '" fill="' + fondo + '"' + borde + '/>' +
        (sub ? '<text x="' + num(ancho / 2) + '" y="' + num(SUB_Y + extra * 0.25) + '" class="pq-chip-sub">' +
          escapeHtml(sub) + '</text>' : '') +
        // A badge with a strapline over it sets its code LOWER, not centred: the
        // sheet gives the strapline the room and lets the code sit on the floor.
        '<text x="' + num(ancho / 2) + '" y="' + num(ALTO_CHIP * (sub ? CH.baseSub ?? 0.78 : CH.base ?? 0.71)) +
        '" class="pq-chip">' + escapeHtml(c) + '</text>';
      const g =
        '<g transform="' + (vuelta ? vuelta + ' ' : '') + 'translate(' + num(cx) + ' ' +
        num(grupo.y - ALTO_CHIP / 2) + ')">' + cuerpo + '</g>';
      out += href
        ? '<a href="' + escapeHtml(href) + '" class="pq-link" aria-label="Ruta ' + escapeHtml(c) + '">' + g + '</a>'
        : g;
      cx += ancho + (CH.gap ?? 1);
    }
    ocupado.push({ x0: grupo.x, x1: cx - 1, y0: grupo.y - ALTO_CHIP / 2, y1: grupo.y + ALTO_CHIP / 2 });
    return out;
  }

  /**
   * A lane rule, broken where something sits across it.
   *
   * The sheet runs these straight through the route badges and through the
   * bridge caption — the line crosses the badge and comes out the other side.
   * That is the operator's drawing and it is reproduced faithfully everywhere
   * else, but a rule through a badge is a fault in the original rather than a
   * feature of it, so this one thing is drawn better than the source.
   */
  function regla(y) {
    const [vx, , vw] = geo.vista;
    const x0 = vx + 2, x1 = vx + vw - 2;
    const huecos = ocupado
      .filter((b) => y >= b.y0 - 1 && y <= b.y1 + 1)
      .map((b) => [b.x0 - 5, b.x1 + 5])
      .sort((a, b) => a[0] - b[0]);
    let cursor = x0, d = '';
    for (const [a, b] of huecos) {
      if (b <= cursor) continue;
      if (a > cursor) d += 'M' + num(cursor) + ',' + num(y) + ' H' + num(Math.min(a, x1));
      cursor = Math.max(cursor, b);
    }
    if (cursor < x1) d += 'M' + num(cursor) + ',' + num(y) + ' H' + num(x1);
    return '<path d="' + d + '" stroke="' + C.regla + '" stroke-width="0.9"/>';
  }

  // ── The ring ─────────────────────────────────────────────────────────────
  // Portal Norte's loop, as its sheet draws it: two SEMICIRCLES of one radius
  // joined by the straights, not the squashed ellipses an earlier pass fitted.
  // Measured round, each end is a band between the spine arc (`ri`) and the
  // outer edge (`ro`): hatched with radial stripes over the top and bottom
  // quarters, and at the far end given over to the pedestrian tunnel, which is
  // a PALE sector with dashed edges rather than platform. Inside the spine the
  // deck is a darker band down to the kerb, with the busway's hole cut out of
  // both it and the platform so the tunnel's line shows through, as it does on
  // the sheet.
  // An angle at a cap is measured from the outward horizontal, positive up, so
  // the same numbers describe both ends.
  const enCapa = (lado, r, grados) => {
    const t = (grados * Math.PI) / 180;
    return [(lado < 0 ? A.x0 : A.x1) + lado * r * Math.cos(t), A.cy - r * Math.sin(t)];
  };
  const pt = ([x, y]) => num(x) + ',' + num(y);
  // Where the kerb lines of the hole cross the spine circle.
  const angHueco = (y) => (Math.asin(Math.min(1, Math.abs(A.cy - y) / A.ri)) * 180) / Math.PI;
  const estadio = (r) =>
    'M' + A.x0 + ',' + num(A.cy - r) + ' H' + A.x1 + ' A' + r + ',' + r + ' 0 0 1 ' + A.x1 + ',' + num(A.cy + r) +
    ' H' + A.x0 + ' A' + r + ',' + r + ' 0 0 1 ' + A.x0 + ',' + num(A.cy - r) + ' Z';
  const hueco = () => {
    const a1 = angHueco(A.yi1), a2 = angHueco(A.yi2);
    return 'M' + pt(enCapa(-1, A.ri, a1)) + ' H' + num(enCapa(1, A.ri, a1)[0]) +
      ' A' + A.ri + ',' + A.ri + ' 0 0 1 ' + pt(enCapa(1, A.ri, -a2)) + ' H' + num(enCapa(-1, A.ri, -a2)[0]) +
      ' A' + A.ri + ',' + A.ri + ' 0 0 1 ' + pt(enCapa(-1, A.ri, a1)) + ' Z';
  };

  /** One end of the loop: the pale band, its radial stripes, the tunnel's dashed edges. */
  function capa(lado) {
    const R = A.rayas ?? {};
    const tope = R.hasta ?? 94;
    const giro = lado < 0 ? 1 : 0;
    let out = '<path d="M' + pt(enCapa(lado, A.ro, -tope)) + ' A' + A.ro + ',' + A.ro + ' 0 1 ' + giro + ' ' +
      pt(enCapa(lado, A.ro, tope)) + ' L' + pt(enCapa(lado, A.ri, tope)) + ' A' + A.ri + ',' + A.ri + ' 0 1 ' +
      (1 - giro) + ' ' + pt(enCapa(lado, A.ri, -tope)) + ' Z" fill="' + C.caja + '"/>';
    for (let a = R.desde ?? 40; a <= tope + 0.01; a += R.paso ?? 4.15) {
      for (const s of [1, -1]) {
        const [x1, y1] = enCapa(lado, A.ri, s * a), [x2, y2] = enCapa(lado, A.ro, s * a);
        out += '<line x1="' + num(x1) + '" y1="' + num(y1) + '" x2="' + num(x2) + '" y2="' + num(y2) +
          '" stroke="' + C.radios + '" stroke-width="' + (R.w ?? 2.4) + '"/>';
      }
    }
    // The tunnel's walls: dashed, along the outside of its sector and along the
    // inside only where that faces the open busway.
    const t = A.tunel ?? 37, a1 = angHueco(A.yi1), a2 = angHueco(A.yi2);
    // A whisper on the sheet: paler than the dashed corridors elsewhere.
    const discontinua = '" fill="none" stroke="' + C.radios + '" stroke-width="0.6" stroke-dasharray="3 2.4"/>';
    out += '<path d="M' + pt(enCapa(lado, A.ro, -t)) + ' A' + A.ro + ',' + A.ro + ' 0 0 ' + giro + ' ' +
      pt(enCapa(lado, A.ro, t)) + discontinua +
      '<path d="M' + pt(enCapa(lado, A.ri, -a2)) + ' A' + A.ri + ',' + A.ri + ' 0 0 ' + giro + ' ' +
      pt(enCapa(lado, A.ri, a1)) + discontinua;
    return out;
  }

  /** The spine: straight along each platform and round each end, until it meets the busway's hole. */
  function espinaAnillo() {
    const a1 = angHueco(A.yi1), a2 = angHueco(A.yi2);
    const r = A.ri + ',' + A.ri;
    return '<path d="M' + pt(enCapa(-1, A.ri, a1)) + ' A' + r + ' 0 0 1 ' + A.x0 + ',' + num(A.cy - A.ri) +
      ' H' + A.x1 + ' A' + r + ' 0 0 1 ' + pt(enCapa(1, A.ri, a1)) +
      ' M' + pt(enCapa(-1, A.ri, -a2)) + ' A' + r + ' 0 0 0 ' + A.x0 + ',' + num(A.cy + A.ri) +
      ' H' + A.x1 + ' A' + r + ' 0 0 0 ' + pt(enCapa(1, A.ri, -a2)) +
      '" fill="none" stroke="' + C.trazo + '" stroke-width="' + (A.espina ?? 1.2) + '"/>';
  }

  /**
   * What lies off each end: the green in the corners, and the tunnel running on
   * out to the edge of the sheet.
   *
   * The green is a half disc sitting on the outer kerb's line, cut away by the
   * loop; the tunnel's approach is bounded above and below by two arcs that
   * flare it into the loop's end. Both are drawn whole and the loop is painted
   * over them, which is how the sheet builds them too.
   */
  function entorno() {
    const V = A.verdes, L = A.lenguas;
    let out = '';
    for (const x of V?.x ?? []) {
      const r = V.r;
      out += '<path d="M' + num(x - r) + ',' + num(A.cy - A.ro) + ' A' + r + ',' + r + ' 0 0 0 ' + num(x + r) + ',' +
        num(A.cy - A.ro) + ' Z M' + num(x - r) + ',' + num(A.cy + A.ro) + ' A' + r + ',' + r + ' 0 0 1 ' + num(x + r) +
        ',' + num(A.cy + A.ro) + ' Z" fill="' + C.verde + '"/>';
    }
    (L?.x ?? []).forEach((cx, i) => {
      const r = L.r, s = i ? 1 : -1, giro = i ? 1 : 0;
      out += '<path d="M' + num(cx + s * r) + ',' + num(A.cy - L.dy) + ' A' + r + ',' + r + ' 0 0 ' + giro + ' ' +
        num(cx) + ',' + num(A.cy - L.dy + r) + ' V' + num(A.cy + L.dy - r) + ' A' + r + ',' + r + ' 0 0 ' + giro + ' ' +
        num(cx + s * r) + ',' + num(A.cy + L.dy) + ' Z" fill="' + C.anden + '"/>';
    });
    return out;
  }

  /** One bay strip: the markers cut into the platform, the names on the roadway. */
  function bahias(t) {
    const tira = tiras[t.tira];
    if (!tira) return '';
    const items = (tira.items ?? []).filter((i) => i.t === 'bahia');
    if (!items.length) return '';
    const caja = t.caja;
    const seg = caja.w / items.length;
    const titulo = (tira.nombre.split('· ')[1] ?? '').replace(/^./, (c) => c.toUpperCase());
    // Where the sheet repeats a caption along a long zone, it is set at each of
    // its own points rather than once in the middle.
    let out = (t.capX ?? [caja.x + caja.w / 2])
      .map((x) => '<text x="' + num(x) + '" y="' + t.capY + '" class="pq-cap">' + escapeHtml(titulo) + '</text>')
      .join('');
    // The hairline between two bays is the sheet's own width, not a constant.
    const hueco = caja.gap ?? 3;
    items.forEach((it, i) => {
      const sx = caja.x + i * seg;
      out += '<rect x="' + num(sx) + '" y="' + caja.y + '" width="' + num(seg - hueco) + '" height="' +
        caja.h + '" fill="' + C.bahia + '"/>';
      const tx = sx + (seg - hueco) / 2;
      out += t.arriba
        ? '<path d="M' + num(tx - 4.5) + ',' + num(caja.y + caja.h - 1.5) + ' h9 l-4.5,-7 z" fill="' + C.trazo + '"/>'
        : '<path d="M' + num(tx - 4.5) + ',' + num(caja.y + 1.5) + ' h9 l-4.5,7 z" fill="' + C.trazo + '"/>';
      // An arrival zone is named by the strip's caption and nothing else: the
      // sheet prints no second name under it, and "Llegada de pasajeros" was
      // ours, set in the busway where the sheet has bare page.
      if (it.llegada) return;
      const lineas = (it.destinos ?? []).length
        ? [{ texto: escapeHtml(it.destinos.join(', ')), textoPlano: it.destinos.join(', ') }]
        : lineasBahia(it, { una: t.una });
      // Hung from the sheet's own baseline: the first line's top where its name
      // started, or the last line's foot where the names stack up off the kerb.
      out += bloqueBahia(lineas, {
        x: tx,
        y: t.arriba ? t.nameY + FS_BAY * 0.19 : t.nameY - TIPO.bay * 0.72 - FS_BAY * 0.17,
        arriba: t.arriba,
        centrado: true,
      });
    });
    return out;
  }

  /**
   * The bay bar of an angled platform: ONE band the whole length of it.
   *
   * The sheet does not draw a bar per group of bays the way the column model
   * implies. Portal 80 runs a single darker band down the outer edge of each
   * platform from cap to cap, and the groups — the western zonal bays, the
   * eastern ones, the intermunicipal coaches — are just stretches of it. Drawn
   * per group, the band broke into pieces that are not in the original.
   */
  const barra = (b) => {
    // Along the platform, BENDS INCLUDED. Drawn as one straight run from end to
    // end it left the platform entirely past the bend and came out beyond the
    // kerb — the band has to turn where the platform turns.
    const quiebres = ((geo.andenes ?? [])[b.anden]?.pts ?? [])
      .slice(1, -1)
      .map((p) => p[0])
      .filter((x) => x > b.desde && x < b.hasta);
    const pts = [b.desde, ...quiebres, b.hasta].map((x) => sobre(b.anden, x, b.off));
    return '<path d="' + pts.map((p, i) => (i ? 'L' : 'M') + num(p.x) + ',' + num(p.y)).join(' ') +
      '" fill="none" stroke="' + C.bahia + '" stroke-width="' + (b.h ?? 10) + '" stroke-linejoin="round"/>';
  };

  /**
   * One group of bays on an angled platform: its caption set along the platform,
   * a marker per bay cut into the bar, and the names.
   *
   * The names are NOT rotated. Everything else on an angled platform turns with
   * it, and the sheet turns the caption too — but the bay names are set level,
   * hanging off their marker, and setting them at an angle was one of the things
   * that made the first pass read as a different drawing.
   */
  function tiraAngulada(t) {
    const tira = tiras[t.tira];
    if (!tira) return '';
    const items = (tira.items ?? []).filter((i) => i.t === 'bahia');
    let out = '';
    if (t.cap) {
      const c = sobre(t.anden, t.cap.x, t.cap.off ?? 33);
      const ang = giro(t.anden, t.cap.x);
      // The sheet's own wording, which is not derivable from the strip's name:
      // it names the CONNECTION the bays make, not the side of the station they
      // are on. (Its own sheet prints "bues" for "buses"; that one is the
      // operator's typo and is not reproduced.)
      const texto = t.cap.texto ?? (tira.nombre.split('· ')[1] ?? '').replace(/^./, (ch) => ch.toUpperCase());
      out += '<text x="' + num(c.x) + '" y="' + num(c.y) + '" class="pq-cap" transform="rotate(' +
        num(ang) + ' ' + num(c.x) + ' ' + num(c.y) + ')">' + escapeHtml(texto) + '</text>';
    }
    items.forEach((it, i) => {
      const b = (t.bahias ?? [])[i];
      if (!b) return;
      // Upright, like the names under it. The sheet turns the caption and the
      // platform's tag with the platform and leaves everything else square to
      // the page — the bay markers, the furniture, the badges.
      // A strip on a level platform drawn from its own outline has no axis to
      // hang off, so it is given its own row instead.
      const m = t.y !== undefined ? { x: b.x, y: t.y + (t.off ?? 0) } : sobre(t.anden, b.x, t.off ?? 39);
      const rutas = it.rutas ?? [];
      if (t.marca === 'tick') {
        // Portal Sur does not cut a triangle into a bay bar, because it has no
        // bar: it sets a short bar in the ROUTE'S OWN COLOUR beside the name,
        // out on the page below the platform.
        const w = t.tick?.w ?? 3.5, h = t.tick?.h ?? 15;
        // The sheet's own colour where it was measured off it. A plano is a
        // SNAPSHOT of the operator's printing, and these marks are not the
        // catalog's route colours: Portal Sur inks its alimentadores one blue,
        // its zonales one green and its troncal bay orange, whatever the routes
        // behind them are coloured elsewhere in the app.
        const col = b.color ?? (rutas.length ? colorDe(rutas[0].codigo) : null);
        if (col) {
          out += '<rect class="pq-bahia" x="' + num(m.x - w / 2) + '" y="' + num(m.y - h / 2) + '" width="' + num(w) +
            '" height="' + num(h) + '" fill="' + col + '"/>';
        }
      } else if (t.marca === 'barra') {
        // Portal Usme cuts its bays neither way: each is its OWN grey bar inside
        // the platform edge, butted to the next with a hairline between, and the
        // arrow on it points up at the kerb the bus pulls in against. The
        // arrival zone is simply a longer bar.
        // Hung from the kerb, so a bar the sheet draws shorter keeps its top.
        const w = b.ancho ?? t.barra?.w ?? 59, h = t.barra?.h ?? 9;
        const tw = t.barra?.tw ?? 7.7, th = t.barra?.th ?? 5;
        out += '<rect class="pq-bahia" x="' + num(m.x - w / 2) + '" y="' + num(m.y - h / 2) + '" width="' + num(w) +
          '" height="' + num(b.h ?? h) + '" fill="' + C.bahia + '"/>' +
          // The arrow is not always at the middle of its bar: the arrival bar is
          // long and its arrow sits where the sheet put it, a few pixels off.
          // Up at the kerb it faces (Usme), or down at it (Suba's bays run along
          // the platform's lower edge) — or per bay, where one strip mixes them:
          // Portal Américas points its arrival zones down and its bays up.
          '<path d="M' + num(m.x + (b.tx ?? 0) - tw / 2) + ',' +
          num(m.y + (t.barra?.ty ?? 0) + ((b.abajo ?? t.barra?.abajo) ? -th / 2 : th / 2)) + ' h' +
          num(tw) + ' l' + num(-tw / 2) + ',' +
          num((b.abajo ?? t.barra?.abajo) ? th : -th) + ' z" fill="' + C.trazo + '"/>';
      } else {
        // The triangle cut into a bay bar. Nine by seven is Portal Norte's;
        // Portal Tunal's sheet is drawn at half the scale and cuts a smaller
        // one, so the size belongs to the strip rather than to the renderer.
        const tw = t.tri?.w ?? 9, th = t.tri?.h ?? 7;
        // Pointing down at the kerb the bus pulls in against, or UP at it where
        // the bay is on the other side of the bar: Portal Tunal marks its two
        // arrival zones with the same triangle turned over.
        const sube = b.arriba ?? t.arriba;
        out += '<path class="pq-bahia" d="M' + num(m.x - tw / 2) + ',' + num(m.y + (sube ? th : -th) / 2) +
          ' h' + num(tw) + ' l' + num(-tw / 2) + ',' + num(sube ? -th : th) + ' z" fill="' + C.trazo + '"/>';
      }
      // The sheet's own wording where it is not the route's: the arrival zone
      // is a caption, not a bay, and it says what it says. Otherwise the
      // códigos, as tags, and their destinations — one code per line and its
      // name under it for most bays, the two on one line (`una`) where the
      // sheet keeps them together, and two codes side by side over the one
      // destination they share (`junta`).
      const lineas = lineasBahia(it, { ...b, una: b.una ?? t.una });
      if (!lineas.length) return;
      // A bay with two routes is set as a BLOCK even where single names are
      // centred: both lines share a left edge, which centring each line broke.
      const centrado = (b.centro || t.centrado) && !b.izq;
      // Beside its marker, or centred on its own where there is no marker to
      // hang off: the arrival zone is a caption over a stretch of platform
      // rather than a bay at a point. A sheet that centres every name over its
      // bay still sets some of them a few pixels off the mark, so the offset is
      // the bay's own where it was measured.
      const tx = m.x + (b.dx ?? (centrado ? 0 : t.dx ?? 2));
      // The sheet's baseline for the first line, or — where Portal Usme stacks
      // a bay's names UPWARD off the kerb — for the last, with a second route
      // going above it rather than below. A station may move a bay's block
      // down a row (`fila`) where two neighbours' names would otherwise meet.
      const ty = m.y + (t.dy ?? 15.5) + (b.fila ?? 0) * (t.fila ?? 0);
      const arriba = t.apila === 'arriba';
      const bloque = bloqueBahia(lineas, {
        x: tx,
        y: arriba ? ty + FS_BAY * 0.19 : ty - TIPO.bay * 0.72 - FS_BAY * 0.17,
        arriba,
        centrado,
        fin: Boolean(t.fin),
        // And a strip may hang every name clear of what lies under its tags:
        // Portal 20 de Julio's bays are grey bars along the kerb, and a name
        // set across them read as struck through.
        // Two rows, or three (`escalon: 3`) where even every other bay is too
        // close: Portal 20 de Julio's "Los Libertadores" is wider than two bays.
        salto: (t.bajo ?? 0) + (t.escalon ? (i % (t.escalon === true ? 2 : t.escalon)) * (ALTO_LINEA + HUECO_LINEA) : 0),
      });
      // Level unless the sheet turns them. Portal 80 sets the names of its
      // angled platforms square to the page and Portal Tunal runs them along
      // Plataforma 2, so the choice is the strip's rather than the renderer's.
      out += t.nombresAng
        ? '<g transform="rotate(' + num(giro(t.anden, b.x)) + ' ' + num(tx) + ' ' + num(ty) + ')">' + bloque + '</g>'
        : bloque;
    });
    return out;
  }

  /**
   * A shaft drawn in PLAN: an outlined square, turning with its platform.
   *
   * The lift beside each tunnel landing is not a pictogram tile on this sheet —
   * it is the shaft itself, seen from above, which is why it is hollow and why
   * it is the only square on the platform that is not filled.
   */
  const caja = (c) =>
    '<rect x="' + num(c.x - c.w / 2) + '" y="' + num(c.y - c.h / 2) + '" width="' + c.w + '" height="' + c.h +
    '" fill="none" stroke="' + C.trazo + '" stroke-width="0.9"' +
    (c.anden === undefined ? '' : ' transform="rotate(' + num(giro(c.anden, c.x)) + ' ' + c.x + ' ' + c.y + ')"') +
    '/>';

  /** Furniture on an angled platform, each tile at its own measured point. */
  function equipoAngulado(e) {
    return (e.iconos ?? [])
      .map((n, i) => {
        const p = (e.pts ?? [])[i];
        if (!p) return '';
        // A mark drawn WITHOUT its tile is set larger, because the tile's own
        // padding is what was holding it in: at Portal Sur the bare stair glyph
        // is a fifth bigger than the boxed ones beside it.
        const s = e.s ?? TILE;
        const cuerpo = tile(n, p[0] - s / 2, p[1] - s / 2, s, e.fondo);
        return e.recto
          ? cuerpo
          : '<g transform="rotate(' + num(giro(e.anden, p[0])) + ' ' + num(p[0]) + ' ' + num(p[1]) + ')">' +
            cuerpo + '</g>';
      })
      .join('');
  }

  /** The furniture of one strip, each tile at its own measured x. */
  function equipo(t) {
    const tira = tiras[t.tira];
    if (!tira || !t.run) return '';
    const ic = ((tira.items ?? []).find((i) => i.t === 'equipo') ?? {}).iconos ?? [];
    return ic.map((n, i) => (t.run.xs[i] === undefined ? '' : tile(n, t.run.xs[i], t.run.y))).join('');
  }

  /** A flight of stairs in plan: a landing with the treads ruled across it. */
  function escalera(e) {
    let out = '<rect x="' + e.x + '" y="' + e.y0 + '" width="' + e.w + '" height="' + num(e.y1 - e.y0) +
      '" fill="' + C.escalera + '" stroke="' + C.trazo + '" stroke-width="0.8"/>';
    for (let x = e.x + 2.5; x <= e.x + e.w * 0.43; x += 1.9) {
      out += '<line x1="' + num(x) + '" y1="' + num(e.y0 + 1) + '" x2="' + num(x) + '" y2="' +
        num(e.y1 - 1) + '" stroke="' + C.peldano + '" stroke-width="0.8"/>';
    }
    return out;
  }

  const P = geo.puente ?? null;
  /** The switchback ramp hooked off the shaft, the way down to street level. */
  const rampa = ([yA, yB]) => {
    const r = Math.abs(yB - yA) / 2;
    return '<path d="M' + (P.eje.x + P.eje.w) + ',' + yA + ' h52 a' + r + ',' + r + ' 0 0 ' +
      (yB > yA ? 1 : 0) + ' 0,' + (yB - yA) + ' h-52" fill="' + C.rampa + '" stroke="' + C.trazo +
      '" stroke-width="0.7"/>';
  };

  // What the bridge carries: the ramps it lands on at each platform come from
  // the bridge COLUMN's own `sube`, the rest from its strip. The BRIDGE's
  // column, by name: Portal Norte's tunnels are columns too and come first, so
  // taking the first column that climbs anything stacked their stairs on a
  // bridge that lands on ramps.
  const suben = (D.columnas ?? []).filter((c) => c.t === 'puente' && c.sube);
  const sube = (suben.find((c) => /puente/i.test(c.nombre ?? '')) ?? suben[0] ?? {}).sube ?? [];
  const enTira = ((tiras[P?.tira]?.items ?? []).find((i) => i.t === 'equipo') ?? {}).iconos ?? [];
  const pila = [...sube, ...enTira, ...sube];

  const rotulo = (r) =>
    '<text x="' + r.x + '" y="' + r.y + '" class="pq-' + (r.clase ?? 'place') +
    (r.fin ? '" text-anchor="end' : r.centro ? '" text-anchor="middle' : '') + '"' +
    // What the sheet sets in grey — the neighbours, the yard, the shopping
    // centre across the road — is background to the station, not part of it.
    // And a sheet does not always set the same name at one size: Portal Norte's
    // two "Túnel peatonal" labels differ by two points, one at each end.
    // And a halo in the colour of what the word stands on (`halo`), where a
    // rule runs behind it: Portal 20 de Julio names each bridge where it
    // crosses the platform, across the bridge's own edges.
    (r.tono || r.fs || r.halo
      ? ' style="' + [
          r.tono ? 'fill:' + (C[r.tono] ?? C.tinta) : '',
          r.fs ? 'font-size:' + num(legible(r.fs)) + 'px' : '',
          r.halo ? 'stroke:' + (C[r.halo] ?? C.papel) + ';stroke-width:' + num(tam(r.clase ?? 'place') * 0.24) + 'px' : '',
        ].filter(Boolean).join(';') + '"'
      : '') +
    // A street name runs ALONG its street and a corridor's name along the
    // corridor. Set level they read as labels dropped on the drawing rather
    // than as part of it.
    (r.ang ? ' transform="rotate(' + r.ang + ' ' + r.x + ' ' + r.y + ')"' : '') + '>' +
    escapeHtml(r.texto) + '</text>';

  /**
   * A platform's yellow name tag.
   *
   * On a ring it sits square on the page. On an angled platform the sheet lays
   * it ALONG the platform, so it is given the platform it belongs to and how far
   * off the axis it stands, and it turns with it — drawn square it read as a
   * label stuck on top of the drawing rather than part of it.
   */
  const etiqueta = (dada) => {
    // The plate grows with its words where the floor raised them, about its
    // own centre, so a name set larger than the sheet's is still ON its plate.
    const fs0 = dada.fs ?? TIPO.tag;
    const f = legible(fs0) / fs0;
    // And WIDER where the app's face needs it: the sheet's plate was cut for
    // its own condensed lettering, and Inter's is a fifth wider.
    const h = dada.h * f;
    const w = Math.max(dada.w * f, anchoTexto(dada.texto, legible(fs0), 0.53) + h * 0.7);
    const t = w === dada.w && f === 1 ? dada : {
      ...dada,
      w: +w.toFixed(2), h: +h.toFixed(2),
      x: dada.anden === undefined ? +(dada.x - (w - dada.w) / 2).toFixed(2) : dada.x,
      y: dada.anden === undefined ? +(dada.y - (h - dada.h) / 2).toFixed(2) : dada.y,
      base: (dada.base ?? 3.5) * f,
      fs: dada.fs === undefined ? undefined : legible(dada.fs),
    };
    if (t.anden !== undefined) {
      const c = sobre(t.anden, t.x, t.off ?? 0);
      const g = 'rotate(' + num(giro(t.anden, t.x)) + ' ' + num(c.x) + ' ' + num(c.y) + ')';
      return '<g transform="' + g + '">' +
        '<rect class="pq-placa" x="' + num(c.x - t.w / 2) + '" y="' + num(c.y - t.h / 2) + '" width="' + t.w +
        '" height="' + t.h + '" fill="' + KERB + '"/>' +
        '<text x="' + num(c.x) + '" y="' + num(c.y + t.h / 2 - (t.base ?? 3.5)) + '" class="pq-tag"' +
        (t.fs ? ' style="font-size:' + num(t.fs) + 'px"' : '') + '>' +
        escapeHtml(t.texto) + '</text></g>';
    }
    // The pointer on the side the tag points from: Portal Norte's access tag
    // points left at its bridge, Portal Usme's floor tags point right at the
    // drum they name.
    // Portal Suba's access tag points UP, from under the building's door.
    const izq = t.flecha === true || t.flecha === 'izq';
    const x0 = izq ? t.x + 6 : t.x;
    const punta = !t.flecha ? ''
      : izq
        ? '<path d="M' + t.x + ',' + num(t.y + t.h / 2) + ' l7,-5.5 v11 z" fill="' + KERB + '"/>'
        : t.flecha === 'arriba'
          ? '<path d="M' + num(t.x + (t.punta ?? t.w / 2) - (t.pw ?? 5.5)) + ',' + num(t.y + 0.5) + ' l' +
            (t.pw ?? 5.5) + ',' + -(t.ph ?? 7.5) + ' l' + (t.pw ?? 5.5) + ',' + (t.ph ?? 7.5) + ' z" fill="' +
            (t.fondo ?? KERB) + '"/>'
        : t.flecha === 'abajo'
          ? '<path d="M' + num(t.x + (t.punta ?? t.w / 2) - (t.pw ?? 5.5)) + ',' + num(t.y + t.h - 0.5) + ' l' +
            (t.pw ?? 5.5) + ',' + (t.ph ?? 7.5) + ' l' + (t.pw ?? 5.5) + ',' + -(t.ph ?? 7.5) + ' z" fill="' +
            (t.fondo ?? KERB) + '"/>'
          : '<path d="M' + num(x0 + t.w + 7.5) + ',' + num(t.y + t.h / 2) + ' l-8.5,-5.5 v11 z" fill="' + KERB + '"/>';
    return punta +
      '<rect class="pq-placa" x="' + x0 + '" y="' + t.y + '" width="' + t.w + '" height="' + t.h +
      // Yellow is what a platform tag is; a station may print another kind.
      // Portal Tunal names its TransMiCable station on an orange plate with
      // white lettering, which drawn in the platform yellow read as a third
      // platform rather than as the cable station it points at.
      '" fill="' + (t.fondo ?? KERB) + '"/>' +
      // A sheet does not set every yellow tag at one size: Portal Sur's platform
      // names are a point and a half larger than the two naming the floors of
      // its access block, and at this scale that is a visible difference rather
      // than a typographic nicety.
      '<text x="' + num(x0 + t.w / 2) + '" y="' + num(t.y + t.h - (t.base ?? 3.5)) +
      '" class="pq-tag"' +
      (t.fs || t.tinta
        ? ' style="' + [t.fs ? 'font-size:' + t.fs + 'px' : '', t.tinta ? 'fill:' + t.tinta : '']
          .filter(Boolean).join(';') + '"'
        : '') + '>' +
      escapeHtml(t.texto) + '</text>';
  };

  // The type travels WITH the drawing. Putting it in a stylesheet would rebuild
  // exactly the split that let the app and the prerender disagree; inline, the
  // two surfaces cannot render this differently, because they get the same
  // bytes. The face is the app's own — Inter, self-hosted and loaded by both
  // surfaces — so the plan reads as part of the page rather than as a scan of
  // the operator's sheet dropped into it.
  // A station may print a surface differently from the others: Portal 80's bay
  // band is 189 grey against Portal Norte's 157. On PAPER — the print view,
  // which is the sheet — the sheet's own measurement wins. In the app's view it
  // does not: there every portal is drawn in the app's one set of greys, the
  // same surfaces as the page around it, and each station keeps only what the
  // palette has no name for (20 de Julio's Super CADE blue, El Dorado's rooms,
  // Tunal's cable red). Drawn in each sheet's own greys, no two portals looked
  // alike and none looked like the page they sat on.
  const vars = (base, tema) =>
    Object.entries({
      ...base,
      ...Object.fromEntries(
        Object.entries(geo.tonos ?? {})
          .filter(([k]) => tema === 'papel' || !(k in base))
          .map(([k, v]) => [k, v[tema] ?? base[k]])
      ),
    })
      .map(([k, v]) => '--pq-' + k + ':' + v)
      .join(';');

  const estilo =
    '<style>' +
    '.pq{' + vars(PALETA.oscuro, 'oscuro') + '}' +
    '.pq.pq-papel{' + vars(PALETA.papel, 'papel') + '}' +
    // Paper on paper, always. A dark plan printed is wrong and wastes ink, and
    // printing is the one place the paper view genuinely earns its keep.
    '@media print{.pq{' + vars(PALETA.papel, 'papel') + '}}' +
    // Every rule is scoped '.pq text.x' so it out-specifies the base one. As
    // '.pq-chip' alone it lost to '.pq text' and every chip label came out in
    // the ink colour — invisible on a black badge.
    '.pq text{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:' + C.tinta +
    // A HALO in the page colour, painted under the letters: where a street's
    // centreline, a bridge's edge or a platform's rule runs behind a word it
    // is knocked out around every glyph instead of striking the word through.
    // Zero by default. Only the bay names and the street names take it: they
    // stand on the page, where the halo is invisible but for what it cuts
    // away. On a grey platform it drew a dark outline round every caption.
    ';paint-order:stroke;stroke:' + C.papel + ';stroke-linejoin:round;stroke-width:0}' +
    '.pq text.pq-chip{fill:#fff;font-weight:700;text-anchor:middle}' +
    '.pq text.pq-chip-sub{fill:#fff;font-weight:700;text-anchor:middle}' +
    '.pq text.pq-cap{text-anchor:middle}' +
    '.pq text.pq-bay{text-anchor:middle}' +
    '.pq text.pq-tag{font-weight:700;text-anchor:middle;fill:#231F20}' +
    '.pq text.pq-place{font-weight:700}' +
    '.pq text.pq-place-sm{font-weight:700}' +
    '.pq text.pq-place-en{font-style:italic;fill:' + C.tenue + '}' +
    // What stands AROUND the station — its streets, its neighbours — in the
    // app's secondary grey, the way the page sets everything that is context
    // rather than content. In the sheet's ink they weighed as much as the
    // platforms and the badges.
    '.pq text.pq-street{font-weight:700;fill:' + C.tenue + '}' +
    '.pq text.pq-anchor{font-weight:700;fill:' + C.tenue + '}' +
    '.pq text.pq-sub,.pq text.pq-sub-sm{fill:' + C.tenue + '}' +
    '.pq text.pq-norte{font-weight:700;text-anchor:middle;fill:#231F20}' +
    // Set under the disc it is on the page rather than on the yellow, so it
    // takes the ink colour of the theme instead of the disc's black.
    '.pq text.pq-norte-fuera{fill:' + C.tinta + '}' +
    '.pq text.pq-bay-izq{text-anchor:start}' +
    '.pq text.pq-bay-fin{text-anchor:end}' +
    // The sizes: Portal Norte's by default, measured off its sheet, and the
    // station's own where it carries them. They are not a house style — Portal
    // 80 is drawn half again as large on the same page and its badges are
    // nearly twice the size. Every one of them is held to the legibility floor.
    // 'bay-code' sizes a bay's código apart from its destination, because the
    // sheets set the two differently — Portal 20 de Julio's códigos are a third
    // larger than the names under them — and it is the tag's text below.
    Object.entries(TIPO)
      .filter(([k]) => k !== 'bay-code')
      .map(([k, v]) => '.pq text.pq-' + k + '{font-size:' + num(legible(v)) + 'px}')
      .join('') +
    ['bay', 'street']
      .map((k) => '.pq text.pq-' + k + '{stroke-width:' + num(tam(k) * 0.24) + 'px}')
      .join('') +
    // A bay's código, white on its route's tag.
    '.pq text.pq-bay-cod{fill:#fff;font-weight:700;text-anchor:middle;font-size:' + num(FS_COD) + 'px}' +
    '.pq a{cursor:pointer}' +
    '.pq a:hover rect{stroke:' + C.tinta + ';stroke-width:1.5}' +
    '.pq a:hover text.pq-bay{text-decoration:underline}' +
    '</style>';

  const [vx, vy, vw, vh] = geo.vista;
  const cuerpo =
    estilo +
    // The drawing's own ground. In the app's theme this is the page colour and
    // invisible; in the paper view it is what makes the paper view paper —
    // without it the roadway and everything over it stayed the dark page and a
    // light drawing floated on black.
    '<rect x="' + geo.vista[0] + '" y="' + geo.vista[1] + '" width="' + geo.vista[2] +
    '" height="' + geo.vista[3] + '" fill="' + C.papel + '"/>' +
    // Only where there IS a ring: measured on a lozenge portal it came out as
    // `undefined` and `NaN`, which the browser rejects and reports.
    (hayAnillo ? entorno() : '') +

    // The tunnel: ONE passage the length of the station under the roadway, which
    // is why both ends carry the same name.
    (geo.tunel
      // In its own tone where the sheet gives it one. Portal Norte's tunnel is
      // the platform's own grey and three pixels tall; drawn nine tall in the
      // paler `tunel` it laid a band across eight hundred pixels of white page.
      ? '<rect x="' + geo.tunel.x + '" y="' + geo.tunel.y + '" width="' + geo.tunel.w + '" height="' +
        geo.tunel.h + '" fill="' + (geo.tunel.tono ? C[geo.tunel.tono] ?? C.tunel : C.tunel) + '"/>'
      : '') +

    (hayAnillo
      ? '<path d="' + estadio(A.ro) + ' ' + hueco() + '" fill="' + C.anden + '" fill-rule="evenodd"/>' +
        capa(-1) + capa(1) +
        '<path d="' + estadio(A.ri) + ' ' + hueco() + '" fill="' + C.losa + '" fill-rule="evenodd"/>' +
        espinaAnillo()
      : '') +
    // What the station stands ON, all of it under the platforms: the street, the
    // planting, the shopping centre it shares a wall with, and the corridors
    // running beneath. The sheet paints the platforms over every one of them,
    // which is why the tunnel's dashed edges stop at a kerb and pick up again on
    // the far side rather than being drawn in two pieces.
    (geo.verdes ?? []).map(jardin).join('') +
    (geo.circulos ?? []).map(circulo).join('') +
    (geo.poligonos ?? [])
      .map((p) => '<path class="pq-bloque" d="' + (p.rect ? rectangulo(p.rect, p.rx ?? 0) : trazar(p.pts) + ' Z') +
        '" fill="' + (p.tono ? C[p.tono] ?? C.anden : C.anden) + '"/>')
      .join('') +
    // After the shopping centre's own footprint: the escalator shaft is drawn on
    // it, and ruled first it was simply painted over.
    (geo.lineas ?? []).map(linea).join('') +
    (geo.corredores ?? []).map(corredor).join('') +
    (geo.escalones ?? []).map(escalon).join('') +
    (geo.norte ? norte(geo.norte) : '') +

    (geo.andenes ?? []).map(lozenge).join('') +
    // A platform no band describes — Portal Américas' round ends over a sawtooth
    // kerb — is its own measured outline.
    (geo.losas ?? [])
      .map((l) => '<path class="pq-losa" d="' + trazar(l.pts) + ' Z" fill="' + (l.tono ? C[l.tono] ?? C.anden : C.anden) + '"/>')
      .join('') +
    (geo.barras ?? []).map(barra).join('') +

    (geo.bordillos ?? []).map(bordillo).join('') +
    // Before the spine, not after: the spine's line runs along the landing's
    // lower edge on the sheet rather than under it.
    (geo.desembarcos ?? []).map(desembarco).join('') +
    (geo.espinas ?? []).map(espina).join('') +
    // Ink ON the platforms: the outline of a tunnel mouth cut into one, the
    // hairlines dividing its zones. Ruled with the street lines they went under
    // the platform and vanished.
    (geo.trazos ?? []).map(linea).join('') +
    (geo.muros ?? [])
      .map((m) => '<path d="M' + m.x0 + ',' + m.y + ' H' + m.x1 + '" stroke="' + C.trazo + '" stroke-width="1"/>')
      .join('') +

    (geo.tiras ?? []).map(bahias).join('') +
    (geo.tiras ?? []).map(equipo).join('') +
    (geo.tirasAng ?? []).map(tiraAngulada).join('') +
    // A structure OVER the platforms. Portal Américas' bridge crosses its as a
    // pale veil, the bays and kerbs under it showing paler rather than being
    // painted out; Portal 20 de Julio's two bridges are drawn solid, each with
    // a landing whose nose is round, and its shelters are solid blocks on the
    // platform — so the opacity and the corner radius are the shape's own.
    // Drawn here, after the platform: given as ground, a bridge that crosses a
    // platform was painted over by it and disappeared.
    (geo.velos ?? [])
      .map((v) => '<path class="pq-velo" d="' + rectangulo(v.rect, v.rx ?? 0) + '" fill="' + (C[v.tono] ?? C.papel) +
        '" fill-opacity="' + (v.opacidad ?? 0.3) + '"/>')
      .join('') +
    (geo.cajas ?? []).map(caja).join('') +
    (geo.equipoAng ?? []).map(equipoAngulado).join('') +
    // Signs last among the marks: Portal Usme posts its evacuation signs ON the
    // platforms, which drawn with the ground went under them.
    (geo.senales ?? []).map(senal).join('') +
    (geo.escaleras ?? []).map(([x, y]) => tile('escalera', x, y)).join('') +

    // The bridge: a narrow shaft with a switchback ramp hooked off each end and
    // the access block standing beside it, not on it. Not every portal has one.
    (!P ? '' :
    (P.rampas ?? []).map(rampa).join('') +
    (P.escaleras ?? []).map(escalera).join('') +
    '<rect x="' + P.eje.x + '" y="' + P.eje.y0 + '" width="' + P.eje.w + '" height="' +
    num(P.eje.y1 - P.eje.y0) + '" fill="' + C.eje + '" stroke="' + C.trazo + '" stroke-width="0.7"/>' +
    (P.descansos ?? [])
      .map((d) => '<rect x="' + P.bloque.x + '" y="' + d.y + '" width="' + P.bloque.w + '" height="' +
        d.h + '" fill="' + C.descanso + '" stroke="' + C.trazo + '" stroke-width="0.7"/>')
      .join('') +
    // The line each ramp runs along, ruled across its landing.
    (P.guias ?? [])
      .map((g) => '<path d="M' + g.x0 + ',' + g.y + ' H' + g.x1 + '" stroke="' + C.trazo + '" stroke-width="0.9"/>')
      .join('') +
    '<rect x="' + P.bloque.x + '" y="' + A.yi1 + '" width="' + P.bloque.w + '" height="' +
    num(A.yi2 - A.yi1) + '" fill="' + C.bloque + '" stroke="' + C.trazo + '" stroke-width="0.7"/>' +
    // The ticket window stands in a booth of its own, a darker square round its tile.
    (P.marco
      ? '<rect x="' + P.marco.x + '" y="' + P.marco.y + '" width="' + P.marco.w + '" height="' + P.marco.h +
        '" fill="' + C.bahia + '"/>'
      : '') +
    pila.map((n, i) => (P.pila[i] === undefined ? '' : tile(n, P.bloque.cx - TILE / 2, P.pila[i] - TILE / 2))).join('') +
    // And each turnstile bank its arms, the three short bars beside the tile.
    (P.brazos ?? [])
      .map(([x, y]) => '<rect x="' + num(x - 3) + '" y="' + num(y - 1.75) + '" width="6" height="3.5" rx="1.5" fill="' +
        C.trazo + '"/>')
      .join('')) +

    (geo.etiquetas ?? []).map(etiqueta).join('') +
    (geo.rotulos ?? []).map(rotulo).join('') +
    (geo.chips ?? []).map(chips).join('') +
    (geo.carriles ?? []).map(regla).join('');

  return (
    '<svg class="pq' + inicial + '" viewBox="' +
    vx + ' ' + vy + ' ' + vw + ' ' + vh + '" role="img" ' +
    'aria-label="Plano del portal" xmlns="http://www.w3.org/2000/svg">' + cuerpo + '</svg>'
  );
}
