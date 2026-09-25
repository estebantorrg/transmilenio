/**
 * TransMiZonal nomenclature, as TRANSMILENIO S.A. defines it — not inferred.
 *
 * Everything here comes from two official sources delivered in answer to a
 * public-information request (radicado 2026-ER-47262, septiembre de 2026):
 *
 *   • the *Manual de imagen y normas gráficas* V.6 (Resolución 511 de 2025):
 *     "Colores – identificación de servicios" (zones, colours, number ranges),
 *     "Paradero TransMiZonal" (how corridors are written, how a paradero's
 *     código breaks down);
 *   • the letter itself, which transcribes the manual's list of
 *     "Abreviaturas (hitos y convenciones)" and the infographic "Diagramación
 *     piezas TransMiZonal" that shipped with the route artwork.
 *
 * Plain JS so the server, the client and the OCR scripts import it without a
 * build step, like `rutero.js`. Pure: no I/O, no state.
 */

// ─── Zones ──────────────────────────────────────────────────────────────────

/**
 * The nine TransMiZonal zones. A service's LETTER is its destination zone and
 * its colour is that zone's colour; its three-digit NUMBER falls in the range
 * of the zone it starts from. The manual's own example: A213 starts in D
 * (200–299, Engativá) and ends in A (Chapinero–Centro).
 *
 * There is no zone E, I or J: the lettering skips them (E is the NQS Central
 * troncal, J the Eje Ambiental). H is one zone with two ranges — 600–699
 * Ciudad Bolívar and 700–799 Usme.
 */
export const ZONAS = {
  A: { nombre: 'Chapinero - Centro', color: '#26358C', rangos: [[0, 99, 'Chapinero - Centro']] },
  B: { nombre: 'Usaquén - Auto Norte', color: '#80BA27', rangos: [[900, 999, 'Usaquén - Auto Norte']] },
  C: { nombre: 'Suba', color: '#FCBD1B', rangos: [[100, 199, 'Suba']] },
  D: { nombre: 'Engativá - CL 80', color: '#8064A9', rangos: [[200, 299, 'Engativá - CL 80']] },
  F: { nombre: 'Kennedy - Américas', color: '#DC0814', rangos: [[400, 499, 'Kennedy - Américas']] },
  G: { nombre: 'Bosa - NQS Sur', color: '#009CDE', rangos: [[500, 599, 'Bosa - NQS Sur']] },
  H: { nombre: 'Usme - Ciudad Bolívar', color: '#F18500', rangos: [[600, 699, 'Ciudad Bolívar'], [700, 799, 'Usme']] },
  K: { nombre: 'Fontibón - CL 26', color: '#D5B079', rangos: [[300, 399, 'Fontibón - CL 26']] },
  L: { nombre: 'San Cristóbal - KR 10', color: '#009A9D', rangos: [[800, 899, 'San Cristóbal - KR 10']] },
};

/** Zone letter (and sub-area name) whose range contains `numero`, or null. */
export function zonaPorNumero(numero) {
  const n = Number(numero);
  if (!Number.isInteger(n) || n < 0 || n > 999) return null;
  for (const [letra, zona] of Object.entries(ZONAS)) {
    for (const [desde, hasta, area] of zona.rangos) {
      if (n >= desde && n <= hasta) return { letra, area };
    }
  }
  return null;
}

/**
 * Reads a TransMiZonal código by the official rule. `A213` → one service;
 * `AH605` (the merged form the dispatch programme and GTFS use for a two-way
 * route) → the two services `A605` and `H605`, each with its own destination.
 *
 * Returns null for anything the rule does not cover — numeric routes (`661`),
 * alimentadores (`10-4`), `E…`, `T…`, `SE…`, `TC…` — rather than guessing: the
 * rule is TRANSMILENIO's, and those codes are outside it.
 *
 * @param {string} code
 * @returns {null | Array<{ codigo: string, numero: number, destino: string, destinoNombre: string, origen: string | null, origenArea: string | null }>}
 */
export function leerCodigoZonal(code) {
  const c = String(code ?? '').toUpperCase().replace(/[\s_-]+/g, '');
  const m = c.match(/^([A-Z])([A-Z])?(\d{3})$/);
  if (!m) return null;
  const letras = m[2] ? [m[1], m[2]] : [m[1]];
  if (!letras.every((l) => ZONAS[l])) return null;
  const numero = Number(m[3]);
  const origen = zonaPorNumero(numero);
  return letras.map((letra) => ({
    codigo: `${letra}${m[3]}`,
    numero,
    destino: letra,
    destinoNombre: ZONAS[letra].nombre,
    origen: origen?.letra ?? null,
    origenArea: origen?.area ?? null,
  }));
}

/**
 * A paradero's cenefa código: three digits for the paradero within its zone,
 * a letter for the módulo (A–E), two digits for the zone where it stands.
 * `078A12` → paradero 78, módulo A, zone 12. The zone here is the numeric
 * operational one (1–13), not a service letter — the two are different
 * partitions and this module does not map one onto the other.
 */
export function leerCodigoParadero(code) {
  const m = String(code ?? '').toUpperCase().trim().match(/^(\d{3})([A-E])(\d{2})$/);
  return m ? { paradero: Number(m[1]), modulo: m[2], zona: Number(m[3]) } : null;
}

// ─── Text limits ─────────────────────────────────────────────────────────────

/** "Los nombres de origen, destino y los hitos de los ruteros no deben superar
 *  los 17 caracteres, incluidos los espacios entre palabras." */
export const MAX_CARACTERES_NOMBRE = 17;

// ─── Abbreviations ───────────────────────────────────────────────────────────

/**
 * The official list, in the manual's own four groups. Each entry is
 * [full name, abbreviation]. Street types and ordinals apply to the corridor
 * column of a rutero; hitos apply to the landmark column.
 */
export const ABREVIATURAS = {
  vias: [
    ['Avenida', 'AV.'], ['Avenida Calle', 'AC'], ['Avenida Carrera', 'AK'], ['Calle', 'CL'],
    ['Carrera', 'KR'], ['Diagonal', 'DG'], ['Transversal', 'TV'], ['Autopista', 'Auto'], ['Quebrada', 'Q.'],
    ['Avenida Agoberto Mejía', 'AV. A. Mejía'], ['Avenida Batallón Caldas', 'AV. Bat. caldas'],
    ['Avenida Boyacá', 'AV. Boyacá'], ['Avenida Caracas', 'AV. Caracas'], ['Avenida Ciudad de Cali', 'AV. C. Cali'],
    ['Avenida Américas', 'AV. Américas'], ['Avenida primero de mayo', 'AV. 1° de Mayo'], ['Avenida NQS', 'AV. NQS'],
    ['Avenida Villavicencio', 'AV. V/cio'], ['Avenida Jorge Gaitán', 'AV. J. Gaitán C.'], ['Avenida Esperanza', 'AV. Esperanza'],
    ['Tercera', '3'], ['Cuarta', '4'], ['Quinta', '5'], ['Sexta', '6'], ['Séptima', '7'], ['Décima', '10'],
  ],
  indicaciones: [
    ['Directo', 'Dto.'], ['Norte', 'Nte.'], ['Oriente', 'Or.'], ['Occidente', 'Occ.'],
    ['Sur', 'S'], ['Este', 'E'], ['Bis', 'Bis'],
  ],
  hitosGenericos: [
    ['Ciudad', 'C.'], ['Clínica', 'Clí.'], ['Colegio', 'Col.'], ['Escuela', 'Esc.'], ['Hospital', 'Hsp.'],
    ['Parque', 'Pq.'], ['Plaza', 'Pl.'], ['Puente', 'Pte.'], ['San', 'San'], ['Santa', 'Santa'],
    ['Universidad', 'U.'], ['Villa', 'Vll.'], ['Villas', 'Vlls.'], ['Zona', 'Zn.'], ['Urbanización', 'Urb.'],
    ['Parroquia', 'Pquia.'], ['Vía La Calera', 'Vía La Calera'], ['Industrial', 'Ind.'],
  ],
  hitosPropios: [
    ['7 de Agosto', '7 de Agosto'], ['20 de Julio', '20 de Julio'], ['Alamos Norte', 'Alamos Nte.'],
    ['Alfonso López', 'Alfso. López'], ['Biblioteca El Tintal', 'Bibl. El Tintal'],
    ['Biblioteca Luis Angel Arango', 'Luis A. Arango'], ['Bosque Popular', 'Bq. Popular'], ['Bulevar Niza', 'Blv. Niza'],
    ['Cementerio Central', 'Cem. Central'], ['Centro Administrativo Distrital', 'CAD'],
    ['Centro Administrativo Nacional', 'CAN'], ['Centro Comercial Andino', 'C.C. Andino'], ['Ciudad Montes', 'C. Montes'],
    ['Ciudadela El Recreo', 'CD. El Recreo'], ['Corporación de Abastos', 'Corabastos'], ['Diana Turbay', 'D. Turbay'],
    ['Escuela de Caballería', 'Esc. Caballería'], ['Fundación Cardio Infantil', 'F. Cardio Infantil'],
    ['Hospital Simón Bolívar', 'Hsp. S. Bolívar'], ['Patio Bonito', 'Ptio. Bonito'], ['Simón Bolívar', 'S. Bolívar'],
    ['Centro Educativo Distrital', 'CED'], ['Instituto Educativo Distrital', 'IED'], ['Minuto de Dios', 'Min. de Dios'],
    ['Parque El Virrey', 'Pq. El Virrey'], ['Puente Aranda', 'Pte. Aranda'], ['Puente Grande', 'Pte. Grande'],
    ['Rincón de Galicia', 'Rcón. de Galicia'], ['Santa Isabel', 'Sta. Isabel'], ['Santa Rita', 'Sta. Rita'],
    ['Villa Cindy', 'Vll. Cindy'],
  ],
};

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

// ─── Corridors ───────────────────────────────────────────────────────────────

/**
 * Real spellings of the listed avenues → the official one. Keys are folded
 * with dots and spaces removed. Only spellings seen on the pieces or in the
 * list itself — OCR misreads are the reader's problem, not this table's.
 */
const AVENIDA_ALIAS = new Map([
  ['BOYACA', 'AV. BOYACÁ'], ['CARACAS', 'AV. CARACAS'],
  ['CCALI', 'AV. C. CALI'], ['CIUDADDECALI', 'AV. C. CALI'], ['CALI', 'AV. C. CALI'],
  ['AMERICAS', 'AV. AMÉRICAS'], ['LASAMERICAS', 'AV. AMÉRICAS'],
  ['1/MAYO', 'AV. 1° DE MAYO'], ['1MAYO', 'AV. 1° DE MAYO'], ['1°DEMAYO', 'AV. 1° DE MAYO'],
  ['1DEMAYO', 'AV. 1° DE MAYO'], ['1°MAYO', 'AV. 1° DE MAYO'], ['PRIMERODEMAYO', 'AV. 1° DE MAYO'],
  ['NQS', 'AV. NQS'],
  ['V/CIO', 'AV. V/CIO'], ['VCIO', 'AV. V/CIO'], ['VILLAVICENCIO', 'AV. V/CIO'],
  ['JGAITANC', 'AV. J. GAITÁN C.'], ['JORGEGAITAN', 'AV. J. GAITÁN C.'], ['JORGEGAITANCORTES', 'AV. J. GAITÁN C.'],
  ['ESPERANZA', 'AV. ESPERANZA'], ['LAESPERANZA', 'AV. ESPERANZA'],
  ['AMEJIA', 'AV. A. MEJÍA'], ['AGOBERTOMEJIA', 'AV. A. MEJÍA'],
  ['BATCALDAS', 'AV. BAT. CALDAS'], ['BATALLONCALDAS', 'AV. BAT. CALDAS'],
]);

/** Named avenues, keyed by their folded abbreviation, e.g. `AV. BOYACA`. */
const AVENIDAS = new Map(
  ABREVIATURAS.vias
    .filter(([, abbr]) => /^AV\. |^Auto/.test(abbr))
    .map(([, abbr]) => [fold(abbr).replace(/\s+/g, ''), abbr.toUpperCase()])
);

/**
 * The corridor column of a rutero, written the way the manual writes it, from
 * whatever OCR made of it. The grammar is closed — a street type, a number, an
 * optional letter, optional `BIS`, an optional second letter, and `S`/`E` set
 * apart ("…en los casos en donde no haya el espacio suficiente se usa la letra
 * 'S' para Sur y 'E' para Este, separadas del número o la letra respectiva") —
 * which is what lets a misread be repaired rather than merely flagged:
 *
 *   `AKIO` → `AK 10`      (I and O inside the number are digits)
 *   `CL48LS` → `CL 48L S` (letter kept, Sur set apart)
 *   `KR77A` → `KR 77A`
 *   `AV.Boyaca` → `AV. BOYACÁ`
 *
 * Returns null when the text cannot be a corridor, so a caller never stores a
 * guess dressed as a street.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizarCorredor(raw) {
  const s = fold(raw).replace(/[·•,]/g, '.');
  if (!s) return null;

  const compact = s.replace(/\s+/g, '');
  const avenue = AVENIDAS.get(compact.replace(/^AV(?!\.)/, 'AV.'));
  if (avenue) return avenue;
  const auto = compact.match(/^AUTO(?:PISTA)?(NORTE|SUR)$/);
  if (auto) return `AUTO ${auto[1]}`;

  // Avenues as the pieces actually print them. The list gives one spelling
  // each; the signs also use the bare name (a two-line chip "AV. / BOYACÁ"),
  // the older "1/MAYO", and avenues the list leaves out (Circunvalar, Mutis,
  // Rojas, G. Cortés…). A known name maps to its official spelling; an unknown
  // one is accepted only behind an explicit "AV." — the grammar's own marker.
  // The marker must end at a boundary: "AVE WAO" is not "AV." + "E WAO".
  const hasAv = /^(AV\.|AV\s|AVENIDA\s)/.test(s);
  const nombre = s.replace(/^AVENIDA\s+|^AV\.?\s*/, '');
  const alias = AVENIDA_ALIAS.get(nombre.replace(/[.\s]/g, ''));
  if (alias) return alias;
  if (hasAv && /^[A-Z][A-Z .°/]{3,}$/.test(nombre) && /[AEIOU]/.test(nombre)) {
    // Validated on the folded form, but written as printed: "G. CORTÉS" keeps
    // its accent — folding is for matching, not for what a rider reads.
    const printed = String(raw).toLocaleUpperCase('es').replace(/\s+/g, ' ').trim().replace(/^AVENIDA\s+|^AV\.?\s*/, '');
    return `AV. ${printed}`;
  }

  // A lone trailing S or E is Sur/Este, never a street letter — the manual's
  // rule — so a letter slot may hold S/E only when something follows it.
  // `(?!BIS)` keeps "48BIS" from reading as letter B + "IS".
  const LETRA = '(?:[A-DF-RT-Z]|[SE](?!$))';
  const m = compact.match(new RegExp(`^(AK|AC|CL|KR|DG|TV)([0-9IO|]+)((?!BIS)${LETRA})?(BIS)?(${LETRA})?(SUR|ESTE|S|E)?$`));
  if (!m) return null;
  const [, tipo, rawNum, letra1 = '', bis, letra2 = '', cardinal] = m;
  // The number is read as digits wherever OCR swapped a shape: I/| → 1, O → 0.
  // Only inside the numeric run. L is left alone: folded to capitals, a misread
  // `l` and a real street letter L (`48L`) are the same character.
  let numero = rawNum.replace(/[I|]/g, '1').replace(/O/g, '0');
  if (!/^\d{1,3}$/.test(numero) || Number(numero) === 0) return null;
  // Bogotá's numbering has a ceiling: calles and diagonales run to about 250,
  // carreras and transversales to about 170. A number past it is a misread,
  // and the usual one is a street LETTER read as a digit — B as 8, D as 0,
  // G as 6 (F425's "KR 78B" came back as "KR 788"). Repaired only when that
  // single swap lands inside the range; otherwise it is not a corridor.
  const techo = /^(CL|AC|DG)$/.test(tipo) ? 260 : 170;
  if (Number(numero) > techo) {
    const letra = { 8: 'B', 0: 'D', 6: 'G' }[numero.slice(-1)];
    if (!letra || numero.length < 3 || letra1 || Number(numero.slice(0, -1)) > techo) return null;
    return `${tipo} ${numero.slice(0, -1)}${letra}${bis ? ' BIS' : ''}${letra2 ? ` ${letra2}` : ''}${cardinal ? ` ${cardinal.startsWith('S') ? 'S' : 'E'}` : ''}`;
  }
  const sufijo = `${letra1}${bis ? ' BIS' : ''}${letra2 ? ` ${letra2}` : ''}`;
  const punto = cardinal ? ` ${cardinal.startsWith('S') ? 'S' : 'E'}` : '';
  return `${tipo} ${numero}${sufijo}${punto}`;
}

// ─── Landmarks ───────────────────────────────────────────────────────────────

const EXPANSIONES = [...ABREVIATURAS.hitosPropios, ...ABREVIATURAS.hitosGenericos, ...ABREVIATURAS.indicaciones]
  .filter(([full, abbr]) => full !== abbr && abbr.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

/**
 * A hito with its official abbreviations spelled out — for search and speech,
 * where a rider says "hospital" and the sign reads `Hsp.`. Display should keep
 * the abbreviated form: that is what the bus shows.
 */
export function expandirHito(text) {
  let out = ` ${String(text ?? '')} `;
  for (const [full, abbr] of EXPANSIONES) {
    const esc = abbr.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[\\s(])${esc}(?=[\\s),]|$)`, 'gi'), `$1${full}`);
  }
  return out.trim();
}
