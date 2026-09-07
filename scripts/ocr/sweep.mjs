// Every drawn station, against the CATALOG and against itself.
//
//   node sweep.mjs
//
// WHY THIS EXISTS
//
// `audit.mjs` checks that the renderer draws what the data says. This checks
// the other end: that the data says something the catalog agrees with, and
// that nothing was left half-entered. The rules below are the ones applied by
// eye, sheet after sheet, and a rule applied a hundred and thirty times by
// hand is a rule worth asserting once by machine — the G43 reading was wrong
// twice before Quinta Paredes settled it, and both times the error was a
// código placed on a station or a wagon that could not hold it.
import { readFileSync } from 'node:fs';

const p = JSON.parse(readFileSync('../../server/src/data/plano_vagones.json', 'utf8'));
const c = JSON.parse(readFileSync('../../server/src/data/master_catalog.json', 'utf8'));

let bad = 0;
const say = (code, m) => { console.log('  x ' + code + ': ' + m); bad++; };
const notes = [];

/** Every código the catalog files at a station, wagon "0" included. */
function servicios(code) {
  const out = new Set();
  for (const rs of Object.values(c.stations?.[code]?.wagons ?? {})) {
    for (const r of rs ?? []) out.add(String(r.codigo).trim().toUpperCase());
  }
  return out;
}

const detalle = Object.keys(p.detalle ?? {});
console.log('DRAWN: ' + detalle.length + ' stations\n');

for (const code of detalle) {
  const D = p.detalle[code];
  const L = p.layouts?.[code];

  // 1. A drawing needs the layout that supplies its services.
  if (!L) { say(code, 'has detalle but no layout'); continue; }

  // 2. Both halves say where they came from and why.
  for (const [what, obj] of [['layout', L], ['detalle', D]]) {
    if (!obj.source) say(code, what + ' has no source');
    if (!obj.why) say(code, what + ' has no why');
  }

  // 3. Exactly one of columnas / filas, and neither empty.
  const cols = D.filas ? D.filas.flatMap((f) => f.columnas ?? []) : D.columnas ?? [];
  if (D.filas && D.columnas) say(code, 'has both columnas and filas');
  if (cols.length === 0) say(code, 'draws no columns');
  if (D.filas && D.filas.length !== (L.rows ?? []).length) {
    say(code, D.filas.length + ' column sets for ' + (L.rows ?? []).length + ' layout rows');
  }

  // 4. Every código drawn is one the catalog actually runs here. This is the
  //    rule: a chip the catalog does not have is not a service, whatever the
  //    sheet prints.
  const have = servicios(code);
  const drawn = new Set();
  for (const r of L.rows ?? []) {
    for (const v of r.vagones ?? []) {
      for (const s of [...(v.arriba ?? []), ...(v.abajo ?? [])]) drawn.add(String(s).toUpperCase());
    }
  }
  for (const s of drawn) if (!have.has(s)) say(code, 'draws "' + s + '", which the catalog does not run here');

  // 5. Every vagón the columns name has a deck to point at, and every deck is
  //    named by a column — a column naming a vagón the layout lacks renders an
  //    empty box, and a vagón no column names is drawn nowhere.
  const decks = new Set();
  for (const r of L.rows ?? []) for (const v of r.vagones ?? []) decks.add(String(v.vagon));
  const named = new Set();
  for (const col of cols) {
    if (col.t !== 'vagones') continue;
    for (const n of [col.arriba, col.abajo]) {
      if (n === undefined) continue;
      named.add(String(n));
      if (!decks.has(String(n))) say(code, 'column names vagón "' + n + '", which the layout does not have');
    }
  }
  for (const d of decks) if (!named.has(d)) say(code, 'layout has vagón "' + d + '" that no column draws');

  // 6. An exit needs a street, an icon has to exist, and a bay has to carry
  //    either services or the arrivals mark.
  const ICONOS = ['taquilla', 'torniquete', 'rampa', 'escalera', 'emergencia', 'ascensor', 'bici', 'cable', 'zonal'];
  for (const col of cols) {
    for (const s of col.salidas ?? []) if (!s.calle) say(code, 'an exit has no street');
    // Only a block carries icons. On a `vagones` column `arriba` is the vagón's
    // NAME — a string — and reading it as a list of icons spells it out one
    // letter at a time.
    const iconos =
      col.t === 'vestibulo' ? [...(col.arriba ?? []), ...(col.centro ?? []), ...(col.abajo ?? [])] :
      col.t === 'puente' ? [...(col.sube ?? [])] : [];
    for (const n of iconos) if (!ICONOS.includes(n)) say(code, 'unknown icon "' + n + '"');
  }
  for (const tira of Array.isArray(D.zonal) ? D.zonal : D.zonal ? [D.zonal] : []) {
    for (const it of tira.items ?? []) {
      if (it.t === 'bahia' && !it.llegada && !(it.rutas ?? []).length) say(code, 'a zonal bay names nothing');
      for (const n of it.iconos ?? []) if (!ICONOS.includes(n)) say(code, 'unknown zonal icon "' + n + '"');
      // A bay has to name a real service. That is the hard rule, and the one
      // that matters: these codes are printed beside a coloured bar four
      // pixels tall, and reading the bar as part of the code turns H728 into
      // HH728 — a service that does not exist, on a page that says it does.
      //
      // The two SOFTER questions are noted rather than failed. A bay naming a
      // route the catalog does not file at this station is almost always the
      // catalog's gap, not the sheet's: the zonal routes are attached to
      // troncal stations only patchily, and every one flagged so far names
      // that very station in its own destination. And a destination that
      // reads differently from the catalog's is usually the SHEET's wording,
      // which is what this drawing reproduces — Molinos prints "Molinos II"
      // where the catalog says "Molinos", and the sheet is what a rider is
      // standing in front of.
      for (const r of it.rutas ?? []) {
        if (!c.routes?.[r.codigo]) { say(code, 'zonal bay names "' + r.codigo + '", which is not a route'); continue; }
        if (!have.has(String(r.codigo).toUpperCase())) {
          notes.push(code + ': bay ' + r.codigo + ' — catalog files no zonal link here (' +
            [...new Set(c.routes[r.codigo].map((v) => String(v.nombre)))].join(' / ') + ')');
        }
        const nombres = new Set(c.routes[r.codigo].map((v) => String(v.nombre)));
        if (r.destino && !nombres.has(r.destino)) {
          notes.push(code + ': bay ' + r.codigo + ' drawn "' + r.destino + '", catalog "' + [...nombres].join(' / ') + '"');
        }
      }
    }
  }

  // 7. The numbering published for this station must agree with the sheet.
  //    Where `printed` names a wagon, every one of that wagon's services must
  //    actually be drawn on the vagón it points at — that is the whole reason
  //    the map exists, and an entry that disagrees is worse than none.
  const printed = p.printed?.[code];
  if (printed) {
    const onVagon = new Map();
    for (const r of L.rows ?? []) {
      for (const v of r.vagones ?? []) {
        for (const s of [...(v.arriba ?? []), ...(v.abajo ?? [])]) {
          const k = String(s).toUpperCase();
          if (!onVagon.has(k)) onVagon.set(k, new Set());
          onVagon.get(k).add(String(v.vagon));
        }
      }
    }
    for (const [letra, numero] of Object.entries(printed)) {
      const rs = c.stations?.[code]?.wagons?.[letra] ?? [];
      for (const r of rs) {
        const k = String(r.codigo).trim().toUpperCase();
        const at = onVagon.get(k);
        if (at && !at.has(String(numero))) {
          say(code, 'printed says wagon ' + letra + ' is vagón ' + numero + ', but ' + k + ' is drawn on ' + [...at].join('/'));
        }
      }
    }
  }
}

// 8. Coverage: a troncal station the catalog serves is either drawn, or the
//    file says why not.
// A station is expected to be drawn when a sheet was published for it — which
// is what `counts` records, one entry per plano read. The rest of the TM-prefixed
// codes are zonal stops the catalog files under a troncal-looking código and
// draws no plano for; nothing can be drawn from a sheet that does not exist.
const missing = [];
for (const [code, st] of Object.entries(c.stations ?? {})) {
  if (Object.keys(st.wagons ?? {}).length === 0) continue;
  if (p.counts?.[code] === undefined) continue;
  if (p.detalle?.[code] || p.sinDetalle?.[code]) continue;
  missing.push(code + ' ' + (st.nombre ?? st.name));
}
console.log('\nUNACCOUNTED FOR: ' + missing.length);
for (const m of missing) console.log('  ' + m);

// Noted, not failed: the two questions where the sheet and the catalog may
// legitimately differ, kept visible so the difference is a decision rather
// than something nobody looked at.
if (notes.length) {
  console.log('\nNOTED — ' + notes.length + ' (sheet and catalog differ; the sheet is what is drawn)');
  for (const n of notes) console.log('  · ' + n);
}

console.log(bad ? '\n' + bad + ' problems' : '\nno problems');
