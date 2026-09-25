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
import { ZONAS } from '../../shared/nomenclatura.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '_ruteros');
const piezas = JSON.parse(readFileSync(join(OUT, 'ruteros.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(HERE, '..', '..', 'server', 'src', 'data', 'master_catalog.json'), 'utf8'));
const routes = (catalog.data ?? catalog).routes ?? {};

const esHorario = (a) => /^horario /.test(a);
const limpia = (t) => Boolean(t.codigo && t.destino && t.filas.length && t.filas.every((f) => f.hito && (f.corredor === null || f.normalizado)));

const porRuta = {};
const sinCodigo = [];
const excluidos = new Map();
for (const p of piezas) {
  if (p.error) continue;
  for (const t of p.tablas ?? []) {
    if (!t.codigo) { sinCodigo.push({ archivo: p.archivo, destino: t.destino }); continue; }
    if (!routes[t.codigo]) { excluidos.set(t.codigo, p.archivo); continue; }
    const r = (porRuta[t.codigo] ??= { formato: t.formato ?? 'tabla', sentidos: [], fuentes: [], revisar: [] });
    if (!r.fuentes.includes(p.archivo)) r.fuentes.push(p.archivo);
    // The same table printed on a plegable and a volante is one table.
    const key = JSON.stringify([t.destino, t.operacion ?? null, t.filas.map((f) => [f.corredor, f.hito])]);
    if (r.sentidos.some((s) => s._key === key)) continue;
    r.sentidos.push({
      _key: key,
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
for (const r of Object.values(porRuta)) {
  for (const s of r.sentidos) delete s._key;
  r.limpia = r.sentidos.every((s) => s.limpia) && r.revisar.length === 0;
}
writeFileSync(join(OUT, 'por_ruta.json'), JSON.stringify(porRuta, null, 1));

// ─── what the site publishes ─────────────────────────────────────────────────
// Only routes with nothing to review: every destino, corredor and hito read and
// checked. The rest join as the review list is cleared. Facts only — códigos,
// destinos, corredores, hitos — drawn by the site's own components; none of
// TRANSMILENIO's artwork. Rows are [corredor | null, destacado 0/1, hito].
const publicar = {};
for (const c of Object.keys(porRuta).sort()) {
  const r = porRuta[c];
  if (!r.limpia) continue;
  // A long rutero is printed as two tables side by side under the same destino
  // (111, 576: the second one carries on where the first stops). Consecutive
  // tables with the same destino and operación are one sentido.
  const sentidos = [];
  for (const s of r.sentidos) {
    // The digital strip's hitos are read in mixed case and can keep a stray
    // mark at the end ("Chapinero Occ_", "Sabana Tibabuyes N-", "campin").
    const hito = (h) => h.replace(/[^\p{L}\d.)]+$/u, '').replace(/^\p{Ll}/u, (c) => c.toLocaleUpperCase('es'));
    const filas = s.filas.map((f) => [f.corredor, f.destacado ? 1 : 0, hito(f.hito)]);
    const prev = sentidos.at(-1);
    if (prev && prev.destino === s.destino && (prev.operacion ?? null) === (s.operacion ?? null)) prev.filas.push(...filas);
    else sentidos.push({ destino: s.destino, ...(s.operacion ? { operacion: s.operacion } : {}), filas });
  }
  publicar[c] = { formato: r.formato, sentidos };
}
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
// so it shows exactly what would be published, and nothing more.
const zoneColor = (code) => {
  const z = ZONAS[String(code)[0]];
  return /^[A-Z]\d{3}$/.test(code) && z ? z.color : '#1c6695';
};
const data = codes.map((c) => ({ c, color: zoneColor(c), ...porRuta[c] }));
const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Ruteros extraídos — ${codes.length} rutas</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --ink:#1d1d1b; --muted:#666; --flag:#d6336c; }
  body { margin:0; font:14px system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { position:sticky; top:0; background:#fff; border-bottom:1px solid #ddd; padding:12px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; z-index:2; }
  header h1 { font-size:16px; margin:0 12px 0 0; }
  input { padding:6px 10px; font-size:14px; border:1px solid #bbb; border-radius:6px; width:220px; }
  button { padding:6px 10px; border:1px solid #bbb; background:#fff; border-radius:6px; cursor:pointer; }
  button.on { background:#1d1d1b; color:#fff; border-color:#1d1d1b; }
  .stats { color:var(--muted); margin-left:auto; }
  main { display:grid; grid-template-columns:repeat(auto-fill, minmax(330px, 1fr)); gap:14px; padding:16px; }
  .route { background:var(--card); border-radius:10px; padding:10px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .route.bad { outline:2px solid var(--flag); }
  .meta { display:flex; justify-content:space-between; color:var(--muted); font-size:12px; margin-bottom:6px; }
  .sent { border:2px solid var(--ink); border-radius:6px; overflow:hidden; margin-bottom:8px; font-weight:700; }
  .dest { color:#fff; padding:4px 8px; display:flex; gap:8px; align-items:baseline; text-transform:uppercase; }
  .dest .cod { font-size:18px; }
  .dest .nom { font-size:15px; }
  .row { display:grid; grid-template-columns:96px 1fr; border-top:1px solid #999; }
  .chip { padding:3px 6px; background:#ffeb3d; color:var(--ink); font-size:13px; }
  .chip.dest-tacado { background:#2c2e35; color:#fff; }
  .chip.nochip { background:#eee; color:#999; }
  .chip.flag { outline:2px dashed var(--flag); outline-offset:-3px; }
  .hito { padding:3px 8px; text-transform:uppercase; font-size:13px; }
  .digital .row { grid-template-columns:1fr 1fr; }
  .tag { font-size:11px; font-weight:400; background:#fff3; padding:1px 5px; border-radius:4px; }
  ul.notes { margin:4px 0 0 18px; padding:0; color:var(--flag); font-size:12px; }
  .src { color:var(--muted); font-size:11px; word-break:break-all; }
</style></head><body>
<header>
  <h1>Ruteros extraídos de las artes</h1>
  <input id="q" placeholder="Buscar código, destino u hito" autofocus>
  <button data-f="all" class="on">Todas</button><button data-f="bad">Para revisar</button><button data-f="ok">Limpias</button><button data-f="digital">Digitales</button>
  <span class="stats" id="stats"></span>
</header>
<main id="grid"></main>
<script>
const DATA = ${JSON.stringify(data)};
let filter = 'all';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
function card(r) {
  const sentidos = r.sentidos.map((s) => \`
    <div class="sent \${r.formato === 'digital' ? 'digital' : ''}">
      <div class="dest" style="background:\${r.color}"><span class="cod">\${esc(r.c)}</span><span class="nom">\${esc(s.destino) || '<i>sin destino</i>'}</span>
        \${s.destinoDelCatalogo ? '<span class="tag">destino del catálogo</span>' : ''}\${s.operacion ? '<span class="tag">' + esc(s.operacion) + '</span>' : ''}</div>
      \${s.filas.map((f) => \`<div class="row"><div class="chip \${f.corredor === null ? 'nochip' : f.destacado ? 'dest-tacado' : ''} \${f.sinNormalizar ? 'flag' : ''}">\${f.corredor === null ? '—' : esc(f.corredor)}</div><div class="hito">\${esc(f.hito) || '<i>vacío</i>'}</div></div>\`).join('')}
    </div>\`).join('');
  const notes = r.revisar.length ? '<ul class="notes">' + r.revisar.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>' : '';
  return \`<div class="route \${r.limpia ? '' : 'bad'}"><div class="meta"><span>\${r.formato}</span><span>\${r.limpia ? '✓ limpia' : 'revisar'}</span></div>\${sentidos}\${notes}<div class="src">\${r.fuentes.map(esc).join('<br>')}</div></div>\`;
}
function render() {
  const q = document.getElementById('q').value.trim().toUpperCase();
  const list = DATA.filter((r) => (filter === 'all' || (filter === 'bad' && !r.limpia) || (filter === 'ok' && r.limpia) || (filter === 'digital' && r.formato === 'digital'))
    && (!q || JSON.stringify([r.c, r.sentidos]).toUpperCase().includes(q)));
  document.getElementById('grid').innerHTML = list.map(card).join('');
  document.getElementById('stats').textContent = list.length + ' de ' + DATA.length + ' rutas · ' + DATA.filter((r) => r.limpia).length + ' limpias';
}
document.getElementById('q').addEventListener('input', render);
for (const b of document.querySelectorAll('button[data-f]')) b.addEventListener('click', () => { filter = b.dataset.f; document.querySelectorAll('button[data-f]').forEach((x) => x.classList.toggle('on', x === b)); render(); });
render();
</script></body></html>`;
writeFileSync(join(OUT, 'ver.html'), html);

console.log(`rutas: ${codes.length} | limpias: ${codes.length - conAvisos.length} | para revisar: ${conAvisos.length} | digitales: ${codes.filter((c) => porRuta[c].formato === 'digital').length}`);
console.log(`tablas sin código: ${sinCodigo.length} | excluidos (no están en el catálogo): ${[...excluidos.keys()].join(', ') || 'ninguno'}`);
console.log(`→ ${join(OUT, 'por_ruta.json')}\n→ ${join(OUT, 'revision.md')}\n→ ${join(OUT, 'ver.html')}`);
