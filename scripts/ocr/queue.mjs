// What to read next, busiest first.
//
//   node queue.mjs           # the stations still waiting, most riders first
//   node queue.mjs 10        # just the top 10
//   node queue.mjs --done    # what has already been checked in
//
// WHY THIS EXISTS
//
// `detalle.mjs` drafts a station from its sheet; a person then has to check
// that draft against the sheet before it ships. There are more drafts than
// there is patience, so the order matters: a plano is worth exactly as much as
// the number of people standing on the platform it describes.
//
// The join is not direct. `station_demand.json` keys on the official register's
// node id and the catalog does not carry one — `troncal_stations.json` is what
// pairs a TM code to its node, which is the same file `station_registry.ts`
// reads to decide whether a stop is an estación at all.
import { readFileSync, existsSync } from 'node:fs';

const DRAFTS = '_planos/detalle_draft.json';
const PLATES = '../../server/src/data/plano_vagones.json';
const REGISTRY = '../../server/src/data/troncal_stations.json';
const DEMAND = '../../server/src/data/station_demand.json';
const CATALOG = '../../server/src/data/master_catalog.json';

if (!existsSync(DRAFTS)) {
  console.log('No drafts yet — run `node detalle.mjs` first.');
  process.exit(0);
}

const drafts = JSON.parse(readFileSync(DRAFTS, 'utf8'));
const plates = JSON.parse(readFileSync(PLATES, 'utf8'));
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')).stations ?? {};
const demand = JSON.parse(readFileSync(DEMAND, 'utf8'));
const byNodo = new Map((demand.stations ?? []).map((s) => [String(s.nodo), s]));
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));

/** How many troncal services call at a station, per the catalog. */
function servicios(code) {
  const st = catalog.stations?.[code];
  if (!st) return 0;
  const out = new Set();
  for (const routes of Object.values(st.wagons ?? {})) {
    for (const r of routes ?? []) {
      if (r.tipoServicio === 'TRONCAL' || r.tipoServicio === 'PADRON') out.add(String(r.codigo).trim().toUpperCase());
    }
  }
  return out.size;
}

const argv = process.argv.slice(2);
const done = argv.includes('--done');
const limit = Number(argv.find((a) => /^\d+$/.test(a))) || Infinity;

// A station the catalog serves with NOTHING cannot be read: every chip on its
// sheet would be a service the catalog says does not call there, and the rule
// is that such a chip is not drawn. Calle 76 and Calle 34 are both of these —
// closed for the Metro works, with the Temporal stations standing in for them
// — and both sheets still print a full set of vagones. Calle 76 sat near the
// top of this list on a ridership figure older than its closure.
const cerradas = new Set(
  Object.entries(catalog.stations ?? {})
    .filter(([c, st]) => /^TM/.test(c) && Object.keys(st.wagons ?? {}).length === 0)
    .map(([c]) => c)
);

// Sheets the station-maps API files under a NEIGHBOUR's código, because that
// is the marker they hang off. The catalog knows these three by a código of
// their own, and the drawing is keyed to the catalog, so the sheet has to be
// read under the catalog's name or it looks like an unread station forever.
const ALIAS = { 'TM0085-1': 'TM90011', 'TM0085-2': 'TM90010', 'TM0087-2': 'TM90009' };

const rows = [];
for (const [sheet, d] of Object.entries(drafts)) {
  const code = ALIAS[sheet] ?? sheet;
  const shipped = Boolean(plates.detalle[code]);
  if (shipped !== done) continue;
  if (!d.layout && !done) continue;
  if (cerradas.has(code)) continue;
  // A sheet with no catalog station behind it cannot be checked against
  // anything: Patio Bonito and Juan Pablo II have planos but no troncal entry,
  // and Ricaurte's and Av. Jiménez's second sheets are already drawn as the
  // other half of their own station.
  if (!catalog.stations?.[code]) continue;
  const nodo = registry[code]?.nodo;
  const dem = nodo ? byNodo.get(String(nodo)) : undefined;
  rows.push({
    code,
    name: d.name ?? '',
    riders: dem?.total ?? null,
    servicios: servicios(code),
    rank: dem?.rank ?? null,
    placed: d.placed ?? 0,
    of: d.ofCatalog ?? 0,
    unread: (d.chipNotes ?? []).filter((n) => n.startsWith('chip')).length,
    rows: d.rows,
    shape: d.shape ?? '',
  });
}

// A station the demand file has never heard of is not quiet, it is UNMEASURED,
// and sorting it last buried nine of them — the five temporary Caracas stations
// standing in for the Metro works, which carry up to seventeen services each,
// and the three Soacha stations on TZ022, which the count seems not to reach at
// all. So an unmeasured station is placed by what CAN be counted: how many
// services call there, scaled by what a service is worth at the stations that
// do have a figure. It is an estimate and is printed as one.
const measured = rows.filter((r) => r.riders != null && r.servicios > 0);
const perService = measured.length
  ? measured.map((r) => r.riders / r.servicios).sort((a, b) => a - b)[Math.floor(measured.length / 2)]
  : 0;
for (const r of rows) if (r.riders == null) r.guess = Math.round(r.servicios * perService);
rows.sort((a, b) => (b.riders ?? b.guess ?? 0) - (a.riders ?? a.guess ?? 0));

const n = rows.filter((r) => r.riders != null).length;
console.log(
  (done ? 'CHECKED IN' : 'WAITING TO BE READ') + ` — ${rows.length} stations, ` +
  `${n} with a ridership figure (${demand.days} days to ${String(demand.generatedAt).slice(0, 10)})\n`
);
console.log('  riders/day  code    station                        rows  chips   unread  shape');
console.log('  (~ = estimated from service count; the demand file does not cover it)');
for (const r of rows.slice(0, limit)) {
  console.log(
    '  ' + (r.riders == null ? ('~' + String(r.guess ?? 0)).padStart(9) : String(r.riders).padStart(9)) +
    '  ' + r.code.padEnd(7) +
    ' ' + r.name.slice(0, 29).padEnd(30) +
    ' ' + String(r.rows).padStart(2) +
    '  ' + String(r.placed + '/' + r.of).padStart(6) +
    '   ' + String(r.unread).padStart(4) +
    '   ' + r.shape.slice(0, 46)
  );
}
if (rows.length > limit) console.log(`  … and ${rows.length - limit} more`);
