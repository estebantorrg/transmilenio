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
    bahia: '#9C9C9C', radios: '#C4C4C4', verde: '#D5E6B6', eje: '#B4B4B4',
    bloque: '#B9B9B9', descanso: '#E9E9E9', escalera: '#BEBEBE', peldano: '#8E8E8E',
    rampa: '#D2D2D2', regla: '#D7D7D7', tinta: '#231F20', tenue: '#5A5A5A',
  },
  oscuro: {
    papel: '#0C0C0C', anden: '#2A2C31', trazo: '#6B6E76', tunel: '#1A1C20',
    bahia: '#4A4D54', radios: '#3A3D43', verde: '#2C3A22', eje: '#3C3F45',
    bloque: '#40434A', descanso: '#24262B', escalera: '#3C3F45', peldano: '#5A5D64',
    rampa: '#34373D', regla: 'rgba(255,255,255,.16)', tinta: '#FFFFFF',
    tenue: 'rgba(255,255,255,.55)',
  },
};

const KERB = '#FFDD00';
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
export function buildPortalSvg(input) {
  const geo = input.geo;
  if (!geo || !geo.anillo) return '';
  // Not a palette but a set of references INTO one. Both palettes are written
  // into the drawing's own <style>, so the paper view is a class on the root
  // rather than a second render, and @media print can force it with nobody
  // toggling anything.
  const C = Object.fromEntries(Object.keys(PALETA.oscuro).map((k) => [k, 'var(--pq-' + k + ')']));
  const inicial = input.tema === 'papel' ? ' pq-papel' : '';
  const D = input.detalle ?? {};
  const tiras = Object.fromEntries(
    (Array.isArray(D.zonal) ? D.zonal : D.zonal ? [D.zonal] : []).map((t) => [t.nombre, t])
  );

  const A = geo.anillo;
  const CY = (A.yo1 + A.yo2) / 2;
  const RO = (A.yo2 - A.yo1) / 2;
  const RI = (A.yi2 - A.yi1) / 2;
  const TILE = geo.teja ?? 18;

  /** Boxes a lane rule has to keep clear of, gathered as the drawing is built. */
  const ocupado = (geo.reservado ?? []).map((b) => ({ ...b }));

  const tile = (name, x, y, s = TILE) => {
    const i = name === 'torniquete' ? TORNIQUETE : ICONOS[name];
    if (!i) return '';
    const pad = s * 0.055;
    return (
      '<g transform="translate(' + num(x) + ' ' + num(y) + ')" role="img" aria-label="' +
      escapeHtml(i.label) + '">' +
      '<rect width="' + num(s) + '" height="' + num(s) + '" fill="' + TILE_BG + '"/>' +
      '<svg x="' + num(pad) + '" y="' + num(pad) + '" width="' + num(s - pad * 2) +
      '" height="' + num(s - pad * 2) + '" viewBox="' + (i.vb || '0 0 24 24') + '">' + i.svg + '</svg></g>'
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
    return /^\d+$/.test(codigo) ? '#111111' : TRONCAL[codigo[0]] ?? '#555555';
  };
  const hrefDe = (codigo) => {
    const ruta = (input.byCode?.get(String(codigo).toUpperCase()) ?? [])[0];
    return ruta && input.routeHref ? input.routeHref(ruta) : null;
  };

  const anchoChip = (c) => Math.max(19, c.length * 7.4 + 5);
  const ALTO_CHIP = 23;

  /** A run of chips, butted together the way the sheet sets them. */
  function chips(grupo) {
    let cx = grupo.x, out = '';
    for (const c of grupo.codigos) {
      const sub = (grupo.sub ?? {})[c];
      const w = anchoChip(c);
      const href = hrefDe(c);
      const cuerpo =
        '<rect width="' + num(w) + '" height="' + ALTO_CHIP + '" fill="' + colorDe(c) + '"/>' +
        (sub ? '<text x="' + num(w / 2) + '" y="6" class="pq-chip-sub">' + escapeHtml(sub) + '</text>' : '') +
        '<text x="' + num(w / 2) + '" y="' + (sub ? 18 : 16.4) + '" class="pq-chip">' + escapeHtml(c) + '</text>';
      const g =
        '<g transform="translate(' + num(cx) + ' ' + num(grupo.y - ALTO_CHIP / 2) + ')">' + cuerpo + '</g>';
      out += href
        ? '<a href="' + escapeHtml(href) + '" class="pq-link" aria-label="Ruta ' + escapeHtml(c) + '">' + g + '</a>'
        : g;
      cx += w + 1;
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
  // The turnaround caps are ELLIPSES, not semicircles: at mid-height the ring is
  // only a few pixels thick, so the caps are squashed horizontally. Drawn round
  // they bulged half a platform-width past the sheet at both ends.
  const anillo =
    'M' + A.x0 + ',' + A.yo1 + ' H' + A.x1 + ' A' + A.rxo + ',' + RO + ' 0 0 1 ' + A.x1 + ',' + A.yo2 +
    ' H' + A.x0 + ' A' + A.rxo + ',' + RO + ' 0 0 1 ' + A.x0 + ',' + A.yo1 + ' Z' +
    'M' + A.x0 + ',' + A.yi1 + ' H' + A.x1 + ' A' + A.rxi + ',' + RI + ' 0 0 1 ' + A.x1 + ',' + A.yi2 +
    ' H' + A.x0 + ' A' + A.rxi + ',' + RI + ' 0 0 1 ' + A.x0 + ',' + A.yi1 + ' Z';

  /** The bus lane's taper, ruled ACROSS the turnaround rather than outside it. */
  function radios(cx, dir) {
    const x0 = cx + dir * 10, x1 = cx + dir * 54;
    let out = '';
    for (let i = 0; i <= 11; i++) {
      const f = i / 11;
      const x = x0 + (x1 - x0) * f;
      const lean = dir * (1 - f) * 9;
      for (const [ya, yb] of [[A.yo1, A.yi1], [A.yi2, A.yo2]]) {
        out += '<line x1="' + num(x - lean) + '" y1="' + ya + '" x2="' + num(x + lean) +
          '" y2="' + yb + '" stroke="' + C.radios + '" stroke-width="1.2"/>';
      }
    }
    return out;
  }

  /** The green: a CORNER FILLET, closing where the cap curve reaches it. */
  function verde(cx, dir) {
    const DX = geo.verde ?? 63;
    const th = Math.acos(Math.min(1, DX / A.rxo));
    const yEnd = RO * Math.sin(th);
    let out = '';
    for (const sgn of [-1, 1]) {
      const x0 = cx + dir * DX, y0 = CY + sgn * yEnd;
      out += '<path d="M' + num(x0) + ',' + num(CY + sgn * RO) + ' L' + cx + ',' + num(CY + sgn * RO) +
        ' A' + A.rxo + ',' + RO + ' 0 0 ' + (dir * sgn > 0 ? 1 : 0) + ' ' + num(x0) + ',' + num(y0) +
        ' Z" fill="' + C.verde + '"/>';
    }
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
    let out = '<text x="' + num(caja.x + caja.w / 2) + '" y="' + t.capY + '" class="pq-cap">' +
      escapeHtml(titulo) + '</text>';
    items.forEach((it, i) => {
      const sx = caja.x + i * seg;
      out += '<rect x="' + num(sx) + '" y="' + caja.y + '" width="' + num(seg - 3) + '" height="' +
        caja.h + '" fill="' + C.bahia + '"/>';
      const tx = sx + (seg - 3) / 2;
      out += t.arriba
        ? '<path d="M' + num(tx - 4.5) + ',' + num(caja.y + caja.h - 1.5) + ' h9 l-4.5,-7 z" fill="' + C.trazo + '"/>'
        : '<path d="M' + num(tx - 4.5) + ',' + num(caja.y + 1.5) + ' h9 l-4.5,7 z" fill="' + C.trazo + '"/>';
      const nombres = it.llegada
        ? ['Llegada de pasajeros']
        : (it.destinos ?? []).length
          ? [escapeHtml(it.destinos.join(', '))]
          : (it.rutas ?? []).map(
              (r) => '<tspan class="pq-bay-code">' + escapeHtml(r.codigo) + '</tspan> ' + escapeHtml(r.destino ?? '')
            );
      nombres.forEach((n, k) => {
        const ny = t.arriba ? t.nameY - (nombres.length - 1 - k) * 8.5 : t.nameY + k * 8.5;
        out += '<text x="' + num(tx) + '" y="' + num(ny) + '" class="pq-bay">' + n + '</text>';
      });
    });
    return out;
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

  const P = geo.puente;
  /** The switchback ramp hooked off the shaft, the way down to street level. */
  const rampa = ([yA, yB]) => {
    const r = Math.abs(yB - yA) / 2;
    return '<path d="M' + (P.eje.x + P.eje.w) + ',' + yA + ' h52 a' + r + ',' + r + ' 0 0 ' +
      (yB > yA ? 1 : 0) + ' 0,' + (yB - yA) + ' h-52" fill="' + C.rampa + '" stroke="' + C.trazo +
      '" stroke-width="0.7"/>';
  };

  // What the bridge carries: the ramps it lands on at each platform come from
  // the bridge COLUMN's own `sube`, the rest from its strip.
  const sube = ((D.columnas ?? []).find((c) => c.t === 'puente' && c.sube) ?? {}).sube ?? [];
  const enTira = ((tiras[P.tira]?.items ?? []).find((i) => i.t === 'equipo') ?? {}).iconos ?? [];
  const pila = [...sube, ...enTira, ...sube];

  const rotulo = (r) =>
    '<text x="' + r.x + '" y="' + r.y + '" class="pq-' + (r.clase ?? 'place') +
    (r.fin ? '" text-anchor="end' : r.centro ? '" text-anchor="middle' : '') + '">' +
    escapeHtml(r.texto) + '</text>';

  const etiqueta = (t) =>
    (t.flecha ? '<path d="M' + t.x + ',' + num(t.y + t.h / 2) + ' l7,-5.5 v11 z" fill="' + KERB + '"/>' : '') +
    '<rect x="' + (t.flecha ? t.x + 6 : t.x) + '" y="' + t.y + '" width="' + t.w + '" height="' + t.h +
    '" fill="' + KERB + '"/>' +
    '<text x="' + num((t.flecha ? t.x + 6 : t.x) + t.w / 2) + '" y="' + num(t.y + t.h - 3.5) +
    '" class="pq-tag">' + escapeHtml(t.texto) + '</text>';

  // The type travels WITH the drawing. Putting it in a stylesheet would rebuild
  // exactly the split that let the app and the prerender disagree; inline, the
  // two surfaces cannot render this differently, because they get the same
  // bytes. The stack is condensed because the sheet's own face is.
  const estilo =
    '<style>' +
    '.pq{' + Object.entries(PALETA.oscuro).map(([k, v]) => '--pq-' + k + ':' + v).join(';') + '}' +
    '.pq.pq-papel{' + Object.entries(PALETA.papel).map(([k, v]) => '--pq-' + k + ':' + v).join(';') + '}' +
    // Paper on paper, always. A dark plan printed is wrong and wastes ink, and
    // printing is the one place the paper view genuinely earns its keep.
    '@media print{.pq{' + Object.entries(PALETA.papel).map(([k, v]) => '--pq-' + k + ':' + v).join(';') + '}}' +
    // Every rule is scoped '.pq text.x' so it out-specifies the base one. As
    // '.pq-chip' alone it lost to '.pq text' and every chip label came out in
    // the ink colour — invisible on a black badge.
    '.pq text{font-family:"Arial Narrow","Roboto Condensed","Segoe UI",system-ui,sans-serif;fill:' + C.tinta + '}' +
    '.pq text.pq-chip{fill:#fff;font-size:11.5px;font-weight:700;text-anchor:middle}' +
    '.pq text.pq-chip-sub{fill:#fff;font-size:4.6px;font-weight:700;text-anchor:middle}' +
    '.pq text.pq-cap{font-size:8px;text-anchor:middle}' +
    '.pq text.pq-bay{font-size:6.8px;text-anchor:middle}' +
    '.pq tspan.pq-bay-code{font-weight:700}' +
    '.pq text.pq-tag{font-size:7.4px;font-weight:700;text-anchor:middle;fill:#231F20}' +
    '.pq text.pq-place{font-size:10.5px;font-weight:700}' +
    '.pq text.pq-place-sm{font-size:8px;font-weight:700}' +
    '.pq text.pq-place-en{font-size:5.8px;font-style:italic;fill:' + C.tenue + '}' +
    '.pq text.pq-street{font-size:12.5px;font-weight:700}' +
    '.pq text.pq-anchor{font-size:8.6px;font-weight:700}' +
    '.pq a{cursor:pointer}' +
    '.pq a:hover rect{stroke:' + C.tinta + ';stroke-width:1.5}' +
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
    '<defs><clipPath id="pq-anillo"><rect x="' + (vx - 40) + '" y="' + A.yo1 + '" width="' + (vw + 80) +
    '" height="' + num(A.yo2 - A.yo1) + '"/></clipPath></defs>' +

    // Everything outside the ring is confined to the ring's own rows: the sheet
    // has bare page beside the turnaround at mid-height, not surface.
    '<g clip-path="url(#pq-anillo)">' +
    verde(A.x0, -1) + verde(A.x1, 1) + radios(A.x0, 1) + radios(A.x1, -1) +
    '</g>' +

    // The tunnel: ONE passage the length of the station under the roadway, which
    // is why both ends carry the same name.
    (geo.tunel
      ? '<rect x="' + geo.tunel.x + '" y="' + geo.tunel.y + '" width="' + geo.tunel.w + '" height="' +
        geo.tunel.h + '" fill="' + C.tunel + '"/>'
      : '') +

    '<path d="' + anillo + '" fill="' + C.anden + '" stroke="' + C.trazo +
    '" stroke-width="0.9" fill-rule="evenodd"/>' +

    (geo.bordillos ?? [])
      .map((k) => '<path d="M' + k.x0 + ',' + k.y + ' H' + k.x1 + '" stroke="' + KERB + '" stroke-width="3"/>')
      .join('') +
    (geo.muros ?? [])
      .map((m) => '<path d="M' + m.x0 + ',' + m.y + ' H' + m.x1 + '" stroke="' + C.trazo + '" stroke-width="1"/>')
      .join('') +

    (geo.tiras ?? []).map(bahias).join('') +
    (geo.tiras ?? []).map(equipo).join('') +
    (geo.escaleras ?? []).map(([x, y]) => tile('escalera', x, y)).join('') +

    // The bridge: a narrow shaft with a switchback ramp hooked off each end and
    // the access block standing beside it, not on it.
    (P.rampas ?? []).map(rampa).join('') +
    (P.escaleras ?? []).map(escalera).join('') +
    '<rect x="' + P.eje.x + '" y="' + P.eje.y0 + '" width="' + P.eje.w + '" height="' +
    num(P.eje.y1 - P.eje.y0) + '" fill="' + C.eje + '" stroke="' + C.trazo + '" stroke-width="0.7"/>' +
    (P.descansos ?? [])
      .map((d) => '<rect x="' + P.bloque.x + '" y="' + d.y + '" width="' + P.bloque.w + '" height="' +
        d.h + '" fill="' + C.descanso + '" stroke="' + C.trazo + '" stroke-width="0.7"/>')
      .join('') +
    '<rect x="' + P.bloque.x + '" y="' + A.yi1 + '" width="' + P.bloque.w + '" height="' +
    num(A.yi2 - A.yi1) + '" fill="' + C.bloque + '" stroke="' + C.trazo + '" stroke-width="0.7"/>' +
    pila.map((n, i) => (P.pila[i] === undefined ? '' : tile(n, P.bloque.cx - TILE / 2, P.pila[i] - TILE / 2))).join('') +

    (geo.etiquetas ?? []).map(etiqueta).join('') +
    (geo.rotulos ?? []).map(rotulo).join('') +
    (geo.chips ?? []).map(chips).join('') +
    (geo.carriles ?? []).map(regla).join('');

  return (
    '<svg class="pq' + inicial + '" viewBox="' + vx + ' ' + vy + ' ' + vw + ' ' + vh + '" role="img" ' +
    'aria-label="Plano del portal" xmlns="http://www.w3.org/2000/svg">' + cuerpo + '</svg>'
  );
}
