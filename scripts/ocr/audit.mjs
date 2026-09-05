// Every drawn station → does the page show exactly what the data says?
//
//   node audit.mjs
//
// WHY THIS EXISTS
//
// The sheets are checked by eye, and that is the only way to check them: a
// person has to look at the plano and at the page and agree. What a person is
// bad at is noticing that a change made for one station quietly altered
// another — the single-platform work moved the way-through marks, the divider
// work restyled the access blocks, and neither showed up in the station being
// worked on.
//
// So this checks the other half: that the RENDERER says what the DATA says,
// for all of them, every time. It caught the access block at Biblioteca and
// Parque drawing ramp arrows the key did not name — the key only ever listed
// the ramp for a `paso` column, and those two have none, their crossing being
// the block's own channel.
//
// It does NOT check the data against the sheet. Nothing can; that is the part
// that needs eyes.
import { readFileSync } from 'node:fs';
import { buildSheetPlano } from '../../shared/plano.js';

const p = JSON.parse(readFileSync('../../server/src/data/plano_vagones.json', 'utf8'));
let bad = 0;
const say = (m) => { console.log('  x ' + m); bad++; };


for (const code of Object.keys(p.detalle)) {
  const L = p.layouts[code], D = p.detalle[code];
  const seen = new Set();
  for (const r of L.rows) for (const v of r.vagones) for (const c of [...(v.arriba ?? []), ...(v.abajo ?? [])]) seen.add(c);
  const out = buildSheetPlano({
    wagons: { A: [...seen].map((c) => ({ codigo: c, nombre: 'R ' + c, color: '#888', tipoServicio: 'TRONCAL' })) },
    layout: L, detalle: D, wagonPlan: {}, sentidos: { positive: 'N', negative: 'S' },
    tagColor: () => '#888', isZonal: () => false,
  });
  const h = out.html;
  const solo = L.rows.length < 2;
  console.log(code + '  ' + (solo ? 'one row ' : 'two rows') + '  ' + D.columnas.map((c) => c.t).join(' '));

  if (h.includes('pdt-grid-solo') !== solo) say('grid mode wrong');

  // column order as rendered
  const cols = [...h.matchAll(/class="pdt-col ([a-z- ]+)"/g)].map((m) => m[1].trim());
  const want = D.columnas.map((c) =>
    c.t === 'vagones' ? 'pdt-vagones' :
    c.t === 'paso' ? 'pdt-paso' :
    c.t === 'puente' ? 'pdt-puente' :
    'pdt-vestibulo' + (solo ? ' pdt-vestibulo-solo' : '') + (c.lado === 'der' ? ' pdt-vestibulo-der' : '') + (c.divide ? ' pdt-vestibulo-parte' : ''));
  if (cols.length !== want.length) say('rendered ' + cols.length + ' columns, data has ' + want.length);
  else for (const [i, c] of cols.entries()) if (c !== want[i]) say('column ' + i + ' is "' + c + '", expected "' + want[i] + '"');

  // per-block: exits, icons and the way through
  // Split on column boundaries rather than guessing where a column ends: the
  // solo block closes an inner stack before its channel, and a lookahead for
  // two closing divs cut the channel off and reported it missing.
  // Only the drawing: the key that follows it carries the same icons, and the
  // last column's slice ran straight into it and counted them twice.
  const grid = h.split('<div class="pdt-convenciones"')[0];
  const blocks = grid.split('<div class="pdt-col ').slice(1).filter((x) => x.startsWith('pdt-vestibulo'));
  const dataBlocks = D.columnas.filter((c) => c.t === 'vestibulo');
  if (blocks.length !== dataBlocks.length) say('rendered ' + blocks.length + ' blocks, data has ' + dataBlocks.length);
  for (const [i, b] of blocks.entries()) {
    const d = dataBlocks[i]; if (!d) break;
    const calles = [...b.matchAll(/pdt-salida-calle">([^<]*)/g)].map((m) => m[1]);
    const wantCalles = (d.salidas ?? []).map((s) => s.calle).filter(Boolean);
    if (calles.length !== (d.salidas ?? []).length) say('block ' + i + ': ' + calles.length + ' exits drawn, data has ' + (d.salidas ?? []).length);
    for (const c of wantCalles) if (!calles.includes(c)) say('block ' + i + ': exit "' + c + '" not drawn');
    const icons = [...b.matchAll(/pdt-icono" role="img" aria-label="([^"]+)"/g)].map((m) => m[1]);
    const wantIcons = [...(d.arriba ?? []), ...(d.centro ?? []), ...(d.abajo ?? [])];
    if (icons.length !== wantIcons.length) say('block ' + i + ': ' + icons.length + ' icons drawn, data has ' + wantIcons.length);
    const canal = (b.match(/pdt-canal[" ]/g) ?? []).length;
    const wantCanal = d.paso === false ? 0 : solo ? 1 : 2;
    if (canal !== wantCanal) say('block ' + i + ': ' + canal + ' way-through marks, expected ' + wantCanal);
    if (!!d.divide !== b.includes('pdt-divider-')) say('block ' + i + ': divider crossing is ' + b.includes('pdt-divider-') + ', data says ' + !!d.divide);
  }

  // bridges
  const bridges = [...h.matchAll(/<div class="pdt-col pdt-puente"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
  const dataBridges = D.columnas.filter((c) => c.t === 'puente');
  if (bridges.length !== dataBridges.length) say(bridges.length + ' bridges drawn, data has ' + dataBridges.length);
  for (const [i, br] of dataBridges.entries()) {
    const has = /con /.test(bridges[i] ?? '');
    if (!!(br.sube ?? []).length !== has) say('bridge ' + i + ': access drawn ' + has + ', data says ' + !!(br.sube ?? []).length);
  }

  // the key names exactly what was drawn
  const key = [...h.matchAll(/pdt-conv-txt">([^<]+)/g)].map((m) => m[1]);
  const drawn = new Set([...grid.matchAll(/pdt-icono" role="img" aria-label="([^"]+)"/g)].map((m) => m[1]));
  if (grid.includes('pdt-canal')) drawn.add('Rampa peatonal');
  for (const k of key) if (!drawn.has(k)) say('key names "' + k + '" which is not drawn');
  for (const d of drawn) if (!key.includes(d)) say('"' + d + '" drawn but missing from the key');
}
console.log(bad ? '\n' + bad + ' problems' : '\nall 16 render exactly what the data says');
