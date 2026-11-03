// Turns `_ruteros/ruteros.json` (one entry per PDF) into one entry per route,
// the list of what needs a person's eyes, and a page to look at all of it.
//
//   node ruteros_consolidar.mjs
//
// → _ruteros/por_ruta.json   código → { formato, sentidos, fuentes, limpia, revisar }
// → _ruteros/revision.md     what to check, grouped, with the piece to open
// → _ruteros/ver.html        every rutero drawn from the data, flagged cells marked
//
// Two rules, both Esteban's (2026-09-25):
//   • only códigos the catalog has. A piece can carry one that appears nowhere
//     else (K122); it is listed as excluded, never filed under a likely route.
//   • schedules come from the catalog, not from the pieces. The pieces print
//     windows that often differ from the app's (151 routes); the catalog is the
//     one source the site already uses, so printed windows are not kept here.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABREVIATURAS, ZONAS, normalizarCorredor } from '../../shared/nomenclatura.js';
import { recorteId } from './ruteros.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '_ruteros');
const piezas = JSON.parse(readFileSync(join(OUT, 'ruteros.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(HERE, '..', '..', 'server', 'src', 'data', 'master_catalog.json'), 'utf8'));
const routes = (catalog.data ?? catalog).routes ?? {};

const esHorario = (a) => /^horario /.test(a);
const limpia = (t) => Boolean(t.codigo && t.destino && t.filas.length && t.filas.every((f) => f.hito && (f.corredor === null || f.normalizado)));

// ─── corrections by hand ─────────────────────────────────────────────────────
// `ruteros_correcciones.json` is what a person read on the piece where the
// engine read wrong — made in ver.html, versioned beside this script. Each
// change names the piece, the table as the warnings name it ("tabla 2",
// "digital 0"), the cell, and what was read there: a new extraction that reads
// something else no longer matches, and the cell goes back to review rather
// than being overwritten blind. `es` equal to `leido` approves a reading.
const CORRECCIONES = JSON.parse(readFileSync(join(HERE, 'ruteros_correcciones.json'), 'utf8'));
const usadas = new Set();
function corregir(p) {
  const nTablas = p.tablas.filter((t) => t.formato !== 'digital').length;
  p.tablas.forEach((t, i) => {
    const pos = t.formato === 'digital' ? `digital ${i - nTablas}` : `tabla ${i}`;
    // What the engine read, kept for the review page whatever is changed below.
    t.lectura = { pos, recorte: recorteId(p.archivo, i), destino: t.destino ?? '', filas: t.filas.map((f) => ({ corredor: f.corredor, hito: f.hito ?? '' })) };
    const quitar = (prefijo) => { p.avisos = (p.avisos ?? []).filter((a) => !a.startsWith(prefijo)); };
    const cambio = (celda, fila, leido) => {
      const c = CORRECCIONES.cambios.find((x) => x.pieza === p.archivo && x.tabla === pos && x.celda === celda && (x.fila ?? null) === fila && x.leido === leido)
        ?? (leido ? CORRECCIONES.todas.find((x) => x.celda === celda && x.leido === leido) : undefined);
      if (c) usadas.add(c);
      return c;
    };
    const d = cambio('destino', null, t.destino ?? '');
    if (d) { t.destino = d.es; t.destinoFuente = 'a mano'; quitar(`${pos}: destino`); }
    t.filas.forEach((f, fi) => {
      // A row read without a chip can be given one ("La FlorestaCL 100" on a digital strip).
      const c = cambio('corredor', fi, f.corredor ?? '');
      if (c) { f.corredor = normalizarCorredor(c.es) ?? c.es; f.normalizado = true; quitar(`${pos} fila ${fi}: corredor`); }
      const h = cambio('hito', fi, f.hito ?? '');
      if (h) { f.hito = h.es; quitar(`${pos} fila ${fi}: hito`); }
    });
  });
}

const porRuta = {};
const sinCodigo = [];
const excluidos = new Map();
for (const p of piezas) {
  if (p.error) continue;
  corregir(p);
  for (const t of p.tablas ?? []) {
    if (!t.codigo) { sinCodigo.push({ archivo: p.archivo, destino: t.destino }); continue; }
    if (!routes[t.codigo]) { excluidos.set(t.codigo, p.archivo); continue; }
    const r = (porRuta[t.codigo] ??= { formato: t.formato ?? 'tabla', sentidos: [], fuentes: [], revisar: [] });
    if (!r.fuentes.includes(p.archivo)) r.fuentes.push(p.archivo);
    // The same table printed on a plegable and a volante is one table.
    const key = JSON.stringify([t.destino, t.operacion ?? null, t.filas.map((f) => [f.corredor, f.hito])]);
    const igual = r.sentidos.find((s) => s._key === key);
    // A correction is made once on the page and written for every piece that printed the table.
    if (igual) { igual.copias.push({ pieza: p.archivo, tabla: t.lectura.pos }); continue; }
    r.sentidos.push({
      _key: key,
      lectura: t.lectura,
      copias: [{ pieza: p.archivo, tabla: t.lectura.pos }],
      destino: t.destino,
      ...(t.destinoFuente === 'catálogo' ? { destinoDelCatalogo: true } : {}),
      ...(t.operacion ? { operacion: t.operacion } : {}),
      filas: t.filas.map((f) => (f.corredor === null ? { corredor: null, hito: f.hito } : { corredor: f.corredor, ...(f.destacado ? { destacado: true } : {}), ...(f.normalizado ? {} : { sinNormalizar: true }), hito: f.hito })),
      limpia: limpia(t),
    });
  }
  for (const c of p.codigos) {
    const r = porRuta[c];
    if (!r) continue;
    for (const a of p.avisos ?? []) if (!esHorario(a) && !r.revisar.includes(a)) r.revisar.push(a);
  }
}
// A printed destino a letter or two away from one of the catalog's names for
// that código is a misread or a catalog typo — `SUBA AORPAS` / `Suba Corpas`,
// `BARRANCAS NORTE` / `Barancas Norte` — and only a person can say which. It
// would also be matched to that direction on the site and shown as printed, so
// it goes to review instead of being published.
const STOP = new Set(['DE', 'DEL', 'EL', 'LA', 'LOS', 'LAS', 'Y']);
const clave = (v) => String(v ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()
  .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter((w) => !STOP.has(w)).join('');
function distancia(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
for (const [codigo, r] of Object.entries(porRuta)) {
  const nombres = [...new Set((routes[codigo] ?? []).map((v) => v.nombre).filter(Boolean))];
  for (const s of r.sentidos) {
    const k = clave(s.destino);
    if (nombres.some((n) => clave(n) === k)) continue;
    const cerca = nombres.find((n) => { const d = distancia(k, clave(n)); return d > 0 && d <= 2; });
    if (cerca) {
      const aviso = `destino "${s.destino}" casi igual a "${cerca}" del catálogo: ¿lectura errada o nombre distinto?`;
      if (!r.revisar.includes(aviso)) r.revisar.push(aviso);
    }
  }
}

// An avenue the normaliser accepts on its "AV." alone can still be a misread —
// `AV. IOMAYO` passed as clean on 19 routes. Only the manual's list and the
// names checked against a piece (`avenidas` in the corrections) go unflagged.
const AVENIDAS = new Set([
  ...ABREVIATURAS.vias.filter(([, abbr]) => /^AV\. /.test(abbr)).map(([, abbr]) => abbr.toUpperCase()),
  ...CORRECCIONES.avenidas,
]);
for (const r of Object.values(porRuta)) {
  for (const s of r.sentidos) {
    for (const f of s.filas) {
      if (!f.corredor?.startsWith('AV. ') || AVENIDAS.has(f.corredor)) continue;
      const aviso = `corredor "${f.corredor}" no es una avenida conocida: ¿lectura errada? (${s.destino})`;
      if (!r.revisar.includes(aviso)) r.revisar.push(aviso);
    }
  }
}

for (const [codigo, r] of Object.entries(porRuta)) {
  for (const s of r.sentidos) delete s._key;
  // Warnings a person read the piece for and found right as printed.
  const vistos = CORRECCIONES.aprobados[codigo] ?? [];
  r.revisar = r.revisar.filter((a) => !vistos.includes(a));
  r.limpia = r.sentidos.every((s) => s.limpia) && r.revisar.length === 0;
}
const sinUsar = [...CORRECCIONES.cambios, ...CORRECCIONES.todas].filter((c) => !usadas.has(c));
if (sinUsar.length) console.warn(`correcciones que ya no coinciden con lo leído (${sinUsar.length}):\n${sinUsar.map((c) => `  ${JSON.stringify(c)}`).join('\n')}`);
writeFileSync(join(OUT, 'por_ruta.json'), JSON.stringify(porRuta, null, 1));

// ─── what the site publishes ─────────────────────────────────────────────────
// Only routes with nothing to review: every destino, corredor and hito read and
// checked. The rest join as the review list is cleared. Facts only — códigos,
// destinos, corredores, hitos — drawn by the site's own components; none of
// TRANSMILENIO's artwork. Rows are [corredor | null, destacado 0/1, hito].
// Hitos the engine misreads the same way every time: a place name whose number
// it drops or garbles (the one station "de Mayo" is Av. 1° de Mayo; the barrio
// is Once de Noviembre) and NQS read as NOS. A list of seen cases, each checked
// against its piece — not a rule — so nothing it doesn't name is rewritten.
const HITOS_REPARADOS = new Map([
  ['ESTACIÓN AV. DE MAYO', 'ESTACIÓN AV. 1° DE MAYO'], // 111
  ['EST. AV. 10 DE MAYO', 'EST. AV. 1° DE MAYO'],
  ['EST. DE MAYO', 'EST. AV. 1° DE MAYO'],
  ['DE NOVIEMBRE', '11 DE NOVIEMBRE'],
  ['DIRECTO AV. NOS', 'DIRECTO AV. NQS'], // T26
  ['SAN FERNANDO/7DE AGOSTO', 'SAN FERNANDO/7 DE AGOSTO'],
]);

// The digital strip's hitos are read in mixed case and can keep a stray mark at
// the end ("Chapinero Occ_", "Sabana Tibabuyes N-", "campin").
// The engine also reads the article "El" as "EI" — every time, on 25 routes —
// and Spanish has no word "EI".
function hito(h) {
  const limpio = h.replace(/[^\p{L}\d.)]+$/u, '').replace(/^\p{Ll}/u, (c) => c.toLocaleUpperCase('es'));
  const el = limpio.replace(/\bEI\b/g, limpio === limpio.toLocaleUpperCase('es') ? 'EL' : 'El');
  return HITOS_REPARADOS.get(el.toLocaleUpperCase('es')) ?? el;
}

// The digital strip reads "Hito/CORREDOR - Hito/CORREDOR", and the dot of an
// abbreviation split some hitos in two: "Pq. El Tunal/KR 24" came back as "Pq"
// with no corredor, then "El Tunal" on KR 24. A corredor-less fragment of a few
// letters is the start of the next hito. A last row without a corredor is real:
// the strip ends at its destination ("Portal de Usme").
function unirFragmentos(filas) {
  const out = [];
  let prefijo = '';
  for (const [i, f] of filas.entries()) {
    // "Pq" lost its dot to the split; "Z.I." (F333) kept its own.
    if (f.corredor === null && i < filas.length - 1 && /^(?:\p{L}\.?){1,4}$/u.test(f.hito)) { prefijo += f.hito.endsWith('.') ? `${f.hito} ` : `${f.hito}. `; continue; }
    out.push(prefijo ? { ...f, hito: prefijo + f.hito } : f);
    prefijo = '';
  }
  return out;
}

// A full-width band right under the destino ("DIRECTO NQS" on T163: the route
// runs mostly along NQS) is not read — the same band lower down is, as a row
// without a chip. `filas` in the corrections puts it back: a row without a chip
// before the one whose hito is `antesDe`. Added here, after the review, so the
// review page's row numbers stay those of the reading.
const filasUsadas = new Set();
function insertarFilas(s, filas) {
  const out = [...filas];
  for (const x of CORRECCIONES.filas) {
    if (!s.copias.some((k) => k.pieza === x.pieza && k.tabla === x.tabla)) continue;
    const at = out.findIndex((f) => f.hito === x.antesDe);
    if (at < 0) continue;
    out.splice(at, 0, { corredor: null, hito: x.es, destacado: Boolean(x.oscura) });
    filasUsadas.add(x);
  }
  return out;
}

// Whether the piece prints a chip-less row dark. The word doesn't say: 330's
// DIRECTO AV. BOYACÁ is dark toward El Uval and white toward La Estrellita. The
// reading has no fill for these rows, so `bandas` lists the dark ones, each seen
// on its piece; the flag is the one a dark chip uses.
const oscura = (s, f) => f.destacado
  || (f.corredor === null && CORRECCIONES.bandas.some((b) => b.hito === f.hito && s.copias.some((k) => k.pieza === b.pieza && k.tabla === b.tabla)));

const publicar = {};
for (const c of Object.keys(porRuta).sort()) {
  const r = porRuta[c];
  if (!r.limpia) continue;
  // A long rutero is printed as two tables side by side under the same destino
  // (111, 139, 576). They stay two tables — the site draws them side by side
  // as the piece does; joining them into one tall table was not the piece.
  const sentidos = r.sentidos.map((s) => ({
    // A destino the engine couldn't read was taken from the catalog, and some
    // came from its Sunday variant: no piece prints "CICLOVÍA" in its band (621
    // reads SANTO DOMINGO, A520 EST. LAS NIEVES).
    destino: s.destinoDelCatalogo ? s.destino.normalize('NFC').replace(/\s+CICLOVÍA$/i, '') : s.destino,
    ...(s.operacion ? { operacion: s.operacion } : {}),
    filas: insertarFilas(s, r.formato === 'digital' ? unirFragmentos(s.filas) : s.filas).map((f) => [f.corredor, oscura(s, f) ? 1 : 0, hito(f.hito)]),
  }));
  publicar[c] = { formato: r.formato, sentidos };
}
const filasSinUsar = CORRECCIONES.filas.filter((x) => !filasUsadas.has(x));
if (filasSinUsar.length) console.warn(`filas que no encontraron su lugar (${filasSinUsar.length}):\n${filasSinUsar.map((x) => `  ${JSON.stringify(x)}`).join('\n')}`);
const SITE = join(HERE, '..', '..', 'server', 'src', 'data', 'ruteros_tradicionales.json');
writeFileSync(SITE, JSON.stringify({
  fuente: 'Artes finales de las piezas TransMiZonal entregadas por TRANSMILENIO S.A. (radicado 2026-ER-47262, septiembre de 2026), leídas por scripts/ocr/ruteros.mjs',
  rutas: publicar,
}) + '\n');
console.log(`publicadas en el sitio: ${Object.keys(publicar).length} rutas → ${SITE}`);

// ─── review list ─────────────────────────────────────────────────────────────
const codes = Object.keys(porRuta).sort();
const conAvisos = codes.filter((c) => !porRuta[c].limpia);
const lines = [];
lines.push('# Ruteros extraídos de las artes — revisión', '');
lines.push(`- Rutas con rutero: **${codes.length}** (${codes.filter((c) => porRuta[c].formato === 'digital').length} en formato digital)`);
lines.push(`- Rutas sin nada que revisar: **${codes.length - conAvisos.length}**`);
lines.push(`- Para revisar: **${conAvisos.length}**`);
lines.push(`- Tablas sin código establecido: **${sinCodigo.length}**`);
lines.push(`- Excluidos por no estar en el catálogo: **${excluidos.size}**${excluidos.size ? ` — ${[...excluidos.keys()].join(', ')}` : ''}`);
lines.push('- Horarios: se toman del catálogo; los impresos en las piezas no se usan.', '');
if (sinCodigo.length) {
  lines.push('## Tablas sin código', '');
  for (const x of sinCodigo) lines.push(`- ${x.archivo} — destino "${x.destino}"`);
  lines.push('');
}
lines.push('## Para revisar a ojo', '', 'Abrir la pieza y comparar. Cada aviso dice qué celda.', '');
for (const c of conAvisos) {
  const r = porRuta[c];
  lines.push(`### ${c} — ${r.fuentes.join(', ')}`);
  const notas = [...r.revisar, ...r.sentidos.flatMap((s) => s.filas.filter((f) => f.sinNormalizar).map((f) => `corredor sin normalizar "${f.corredor}" (${s.destino})`)), ...r.sentidos.filter((s) => s.destinoDelCatalogo).map((s) => `destino tomado del catálogo: ${s.destino}`)];
  for (const a of [...new Set(notas)]) lines.push(`- ${a}`);
  lines.push('');
}
writeFileSync(join(OUT, 'revision.md'), lines.join('\n') + '\n');

// ─── viewer ──────────────────────────────────────────────────────────────────
// Drawn from the extracted data in the site's own manner — not TM's artwork —
// so it shows exactly what would be published, with the piece's own table cut
// beside it (`ruteros_recortes.mjs`) to check it against. Every cell can be
// corrected and every warning approved; the page keeps the work in the browser
// and hands it back as the new ruteros_correcciones.json.
const zoneColor = (code) => {
  const z = ZONAS[String(code)[0]];
  return /^[A-Z]\d{3}$/.test(code) && z ? z.color : '#1c6695';
};
const data = codes.map((c) => ({ c, color: zoneColor(c), ...porRuta[c] }));
const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Ruteros extraídos — ${codes.length} rutas</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --ink:#1d1d1b; --muted:#666; --flag:#d6336c; --ok:#067647; }
  body { margin:0; font:14px system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { position:sticky; top:0; background:#fff; border-bottom:1px solid #ddd; padding:12px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; z-index:2; }
  header h1 { font-size:16px; margin:0 12px 0 0; }
  #q { padding:6px 10px; font-size:14px; border:1px solid #bbb; border-radius:6px; width:220px; }
  button { padding:6px 10px; border:1px solid #bbb; background:#fff; border-radius:6px; cursor:pointer; }
  button.on { background:#1d1d1b; color:#fff; border-color:#1d1d1b; }
  button.save { background:var(--ok); color:#fff; border-color:var(--ok); }
  .stats { color:var(--muted); margin-left:auto; }
  main { display:grid; grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); gap:14px; padding:16px; }
  .route { background:var(--card); border-radius:10px; padding:10px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .route.bad { outline:2px solid var(--flag); }
  .meta { display:flex; justify-content:space-between; color:var(--muted); font-size:12px; margin-bottom:6px; }
  .pieza { display:block; max-width:100%; margin:0 auto 6px; border:1px solid #ddd; }
  .sent { border:2px solid var(--ink); border-radius:6px; overflow:hidden; margin-bottom:10px; font-weight:700; }
  .dest { color:#fff; padding:4px 8px; display:flex; gap:8px; align-items:center; }
  .dest .cod { font-size:18px; }
  .row { display:grid; grid-template-columns:110px 1fr; border-top:1px solid #999; }
  .digital .row { grid-template-columns:1fr 1fr; }
  .cell { display:flex; align-items:center; }
  .cell input { flex:1; min-width:0; border:0; background:transparent; font:inherit; text-transform:uppercase; padding:3px 6px; color:inherit; }
  .dest input { font-size:15px; }
  .chip { background:#ffeb3d; }
  .chip.oscuro { background:#2c2e35; color:#fff; }
  .chip.nochip { background:#eee; color:#999; }
  .flag { outline:2px dashed var(--flag); outline-offset:-3px; }
  .editado { box-shadow:inset 0 0 0 2px var(--ok); }
  .editado input { color:var(--ok); }
  .ok { border:0; background:none; padding:0 6px; color:var(--ok); font-weight:700; cursor:pointer; }
  .tag { font-size:11px; font-weight:400; background:#fff3; padding:1px 5px; border-radius:4px; }
  ul.notes { margin:4px 0 0 0; padding:0; list-style:none; color:var(--flag); font-size:12px; }
  ul.notes li { display:flex; gap:6px; align-items:baseline; }
  ul.notes li.visto { color:var(--ok); text-decoration:line-through; }
  .src { color:var(--muted); font-size:11px; word-break:break-all; }
</style></head><body>
<header>
  <h1>Ruteros extraídos de las artes</h1>
  <input id="q" placeholder="Buscar código, destino u hito" autofocus>
  <button data-f="bad" class="on">Para revisar</button><button data-f="all">Todas</button><button data-f="ok">Limpias</button><button data-f="digital">Digitales</button>
  <span id="pend"></span><button class="save" id="save">Descargar ruteros_correcciones.json</button><button id="drop">Descartar lo pendiente</button>
  <span class="stats" id="stats"></span>
</header>
<main id="grid"></main>
<script>
const DATA = ${JSON.stringify(data)};
const BASE = ${JSON.stringify(CORRECCIONES)};
const STORE = 'ruteros-correcciones-pendientes';
let filter = 'bad';
let pend = { cambios: [], aprobados: {}, avenidas: [] };
try { pend = { ...pend, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch {}
const keep = () => { try { localStorage.setItem(STORE, JSON.stringify(pend)); } catch {} count(); };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const mismo = (a, b) => a.pieza === b.pieza && a.tabla === b.tabla && a.celda === b.celda && (a.fila ?? null) === (b.fila ?? null);
function count() {
  const n = pend.cambios.length + Object.values(pend.aprobados).flat().length + pend.avenidas.length;
  document.getElementById('pend').textContent = n ? n + ' pendientes' : '';
}
// One change per copy of the table: the plegable and the volante print the same one.
function cambiar(s, celda, fila, leido, es) {
  for (const copia of s.copias) {
    const c = { pieza: copia.pieza, tabla: copia.tabla, celda, ...(fila === null ? {} : { fila }), leido, es };
    pend.cambios = pend.cambios.filter((x) => !mismo(x, c));
    if (es !== null) pend.cambios.push(c);
  }
  keep();
}
const pendiente = (s, celda, fila) => pend.cambios.find((x) => mismo(x, { pieza: s.copias[0].pieza, tabla: s.copias[0].tabla, celda, fila }));
function celda(s, si, celdaN, fila, actual, leido, flagged, extra = '') {
  const p = pendiente(s, celdaN, fila);
  const valor = p ? p.es : actual;
  const ok = flagged ? '<button class="ok" title="Está bien como se leyó" data-ok>✓</button>' : '';
  return \`<div class="cell \${extra} \${flagged && !p ? 'flag' : ''} \${p ? 'editado' : ''}" data-s="\${si}" data-celda="\${celdaN}" data-fila="\${fila ?? ''}" data-leido="\${esc(leido)}">
    <input value="\${esc(valor)}" spellcheck="false">\${ok}</div>\`;
}
function card(r, ri) {
  const sentidos = r.sentidos.map((s, si) => {
    const L = s.lectura;
    const filas = s.filas.map((f, fi) => {
      const avenida = f.corredor && f.corredor.startsWith('AV. ') && r.revisar.some((a) => a.startsWith('corredor "' + f.corredor + '" no es una avenida'));
      const chip = f.corredor === null ? '<div class="cell chip nochip">—</div>'
        : celda(s, si, 'corredor', fi, f.corredor, L.filas[fi]?.corredor ?? '', f.sinNormalizar || avenida, 'chip ' + (f.destacado ? 'oscuro' : ''));
      return \`<div class="row">\${chip}\${celda(s, si, 'hito', fi, f.hito, L.filas[fi]?.hito ?? '', !f.hito)}</div>\`;
    }).join('');
    return \`<img class="pieza" loading="lazy" src="recortes/\${encodeURIComponent(L.recorte)}" alt="">
    <div class="sent \${r.formato === 'digital' ? 'digital' : ''}" data-r="\${ri}">
      <div class="dest" style="background:\${r.color}"><span class="cod">\${esc(r.c)}</span>\${celda(s, si, 'destino', null, s.destino, L.destino, !s.destino || r.revisar.some((a) => a.includes('destino "' + s.destino + '"') || a.startsWith(L.pos + ': destino')))}
        \${s.operacion ? '<span class="tag">' + esc(s.operacion) + '</span>' : ''}</div>\${filas}
    </div>\`;
  }).join('');
  const vistos = pend.aprobados[r.c] ?? [];
  const notes = r.revisar.length ? '<ul class="notes">' + r.revisar.map((a, ai) => \`<li class="\${vistos.includes(a) ? 'visto' : ''}"><button class="ok" data-aviso="\${ai}" title="Revisado: está bien como está">✓</button>\${esc(a)}</li>\`).join('') + '</ul>' : '';
  return \`<div class="route \${r.limpia ? '' : 'bad'}" data-r="\${ri}"><div class="meta"><span>\${r.c} · \${r.formato}</span><span>\${r.limpia ? '✓ limpia' : 'revisar'}</span></div>\${sentidos}\${notes}<div class="src">\${r.fuentes.map(esc).join('<br>')}</div></div>\`;
}
function render() {
  const q = document.getElementById('q').value.trim().toUpperCase();
  const list = DATA.map((r, ri) => [r, ri]).filter(([r]) => (filter === 'all' || (filter === 'bad' && !r.limpia) || (filter === 'ok' && r.limpia) || (filter === 'digital' && r.formato === 'digital'))
    && (!q || JSON.stringify([r.c, r.sentidos.map((s) => [s.destino, s.filas])]).toUpperCase().includes(q)));
  document.getElementById('grid').innerHTML = list.map(([r, ri]) => card(r, ri)).join('');
  document.getElementById('stats').textContent = list.length + ' de ' + DATA.length + ' rutas · ' + DATA.filter((r) => r.limpia).length + ' limpias';
  count();
}
document.getElementById('grid').addEventListener('change', (e) => {
  const cell = e.target.closest('.cell[data-celda]');
  if (!cell) return;
  const r = DATA[cell.closest('[data-r]').dataset.r];
  const s = r.sentidos[cell.dataset.s];
  const fila = cell.dataset.fila === '' ? null : Number(cell.dataset.fila);
  const es = e.target.value.trim().toLocaleUpperCase('es');
  const actual = cell.dataset.celda === 'destino' ? s.destino : s.filas[fila][cell.dataset.celda];
  cambiar(s, cell.dataset.celda, fila, cell.dataset.leido, es === String(actual ?? '').toLocaleUpperCase('es') ? null : es);
  cell.classList.toggle('editado', es !== String(actual ?? '').toLocaleUpperCase('es'));
});
document.getElementById('grid').addEventListener('click', (e) => {
  const b = e.target.closest('button.ok');
  if (!b) return;
  const r = DATA[b.closest('[data-r]').dataset.r];
  if (b.dataset.aviso !== undefined) {
    const a = r.revisar[b.dataset.aviso];
    const list = (pend.aprobados[r.c] ??= []);
    if (list.includes(a)) list.splice(list.indexOf(a), 1); else list.push(a);
    // An avenue seen right on the piece is right everywhere.
    const av = /^corredor "(AV\\. [^"]+)" no es una avenida/.exec(a);
    if (av && list.includes(a) && !pend.avenidas.includes(av[1])) pend.avenidas.push(av[1]);
    keep(); render(); return;
  }
  const cell = b.closest('.cell');
  const s = r.sentidos[cell.dataset.s];
  const fila = cell.dataset.fila === '' ? null : Number(cell.dataset.fila);
  const leido = cell.dataset.leido;
  cambiar(s, cell.dataset.celda, fila, leido, leido);
  if (cell.dataset.celda === 'corredor' && /^AV\\. /.test(leido) && !pend.avenidas.includes(leido)) { pend.avenidas.push(leido); keep(); }
  render();
});
document.getElementById('save').addEventListener('click', () => {
  const out = structuredClone(BASE);
  for (const c of pend.cambios) { out.cambios = out.cambios.filter((x) => !mismo(x, c)); out.cambios.push(c); }
  for (const [codigo, list] of Object.entries(pend.aprobados)) out.aprobados[codigo] = [...new Set([...(out.aprobados[codigo] ?? []), ...list])];
  out.avenidas = [...new Set([...out.avenidas, ...pend.avenidas])].sort();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2) + '\\n'], { type: 'application/json' }));
  a.download = 'ruteros_correcciones.json';
  a.click();
});
document.getElementById('drop').addEventListener('click', () => { if (confirm('¿Descartar lo pendiente?')) { pend = { cambios: [], aprobados: {}, avenidas: [] }; keep(); render(); } });
document.getElementById('q').addEventListener('input', render);
for (const b of document.querySelectorAll('button[data-f]')) b.addEventListener('click', () => { filter = b.dataset.f; document.querySelectorAll('button[data-f]').forEach((x) => x.classList.toggle('on', x === b)); render(); });
render();
</script></body></html>`;
writeFileSync(join(OUT, 'ver.html'), html);

console.log(`rutas: ${codes.length} | limpias: ${codes.length - conAvisos.length} | para revisar: ${conAvisos.length} | digitales: ${codes.filter((c) => porRuta[c].formato === 'digital').length}`);
console.log(`tablas sin código: ${sinCodigo.length} | excluidos (no están en el catálogo): ${[...excluidos.keys()].join(', ') || 'ninguno'}`);
console.log(`→ ${join(OUT, 'por_ruta.json')}\n→ ${join(OUT, 'revision.md')}\n→ ${join(OUT, 'ver.html')}`);
