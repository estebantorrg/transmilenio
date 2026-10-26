/**
 * The question a rider types into a search box, answered in a sentence, for the
 * route and station pages (spec §5.5.4). "¿Dónde para el B11?" was answered by
 * the page — the stop list — but never asked or said in words, so a search had
 * only the title to match it on. One copy for the prerendered body
 * (`server/src/prerender_seo.ts`) and the bundle's page (`ui/routePage.ts`,
 * `ui/stationPage.ts`): the bundle replaces the static body when it boots, so a
 * sentence on one surface only is a sentence Google may not see.
 *
 * Every word comes from the page's own data, never filler: the same template
 * over 360 pages with nothing specific in it reads as boilerplate.
 *
 * Plain JS with a .d.ts beside it, as the rest of shared/, so the server can
 * import it without a build step.
 */

/** "A, B y C". */
function enumerar(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** Ends the sentence, unless its last word already did ("p. m.", "Coop."). */
const punto = (frase) => (frase.endsWith('.') ? frase : `${frase}.`);

/** Up to `count` stops spread along the interior of the trip, endpoints excluded. */
function intermedias(nombres, count = 3) {
  const last = nombres.length - 1;
  const picked = [];
  for (let k = 1; k <= count; k++) {
    const i = Math.round((k * last) / (count + 1));
    if (i > 0 && i < last && !picked.includes(nombres[i])) picked.push(nombres[i]);
  }
  return picked;
}

/**
 * "¿Dónde para el B11?" → "El B11 tiene 17 paradas, desde Portal Sur hasta
 * Terminal, pasando por Ricaurte, Calle 85 y Toberín." Null without stops.
 * @param {string} codigo
 * @param {string[]} paradas stop names in travel order
 */
export function resumenRuta(codigo, paradas) {
  const nombres = paradas.map((p) => String(p ?? '').trim()).filter(Boolean);
  if (!codigo || !nombres.length) return null;
  const pregunta = `¿Dónde para el ${codigo}?`;
  if (nombres.length === 1) return { pregunta, respuesta: punto(`El ${codigo} para en ${nombres[0]}`) };
  const [desde, hasta] = [nombres[0], nombres[nombres.length - 1]];
  const pasando = intermedias(nombres);
  return {
    pregunta,
    respuesta: punto(
      `El ${codigo} tiene ${nombres.length} paradas, desde ${desde} hasta ${hasta}` +
        (pasando.length ? `, pasando por ${enumerar(pasando)}` : '')
    ),
  };
}

/** Catalog `convencion` → the days in words (the same codes `services/schedule.ts` reads). */
const DIAS = {
  'L-V': 'de lunes a viernes',
  'L-S': 'de lunes a sábado',
  'L-D': 'todos los días',
  L: 'los lunes',
  S: 'los sábados',
  D: 'los domingos',
  'D-F': 'los domingos y festivos',
  'D-F-A': 'los domingos y festivos',
  F: 'los festivos',
};

const ORDEN_DIAS = Object.keys(DIAS);

const hora = (t) => t.trim().replace(/\s*AM$/i, ' a. m.').replace(/\s*PM$/i, ' p. m.');

/**
 * "¿A qué hora pasa el B11?" → "El B11 funciona de lunes a viernes de 5:00 a. m.
 * a 9:00 p. m. y los sábados de 6:00 a. m. a 9:30 p. m." Read from the catalog
 * schedule as both surfaces already print it — `L-V 5:00 AM-9:00 PM / S …`
 * (`formatScheduleText`, `data/routeCatalog.ts`). A row with a day code this
 * does not know is left out, never guessed; days with no row are not called
 * closed, since the catalog's silence is not a statement. Null when nothing reads.
 * @param {string} codigo
 * @param {string} horario
 */
export function horarioRuta(codigo, horario) {
  const tramos = String(horario ?? '')
    .split('/')
    .map((tramo) => /^(\S+)\s+(.+?)\s*[-–]\s*(.+)$/.exec(tramo.trim()))
    .filter(Boolean)
    .map(([, conv, desde, hasta]) => {
      const clave = conv.toUpperCase().replace(/[\s.]/g, '');
      return { orden: ORDEN_DIAS.indexOf(clave), texto: DIAS[clave] ? `${DIAS[clave]} de ${hora(desde)} a ${hora(hasta)}` : '' };
    })
    .filter((tramo) => tramo.texto)
    // Weekdays first, whatever order the catalog lists them in (it puts S before L-V).
    .sort((a, b) => a.orden - b.orden)
    .map((tramo) => tramo.texto);
  if (!codigo || !tramos.length) return null;
  return { pregunta: `¿A qué hora pasa el ${codigo}?`, respuesta: punto(`El ${codigo} funciona ${enumerar(tramos)}`) };
}

/**
 * "¿Dónde queda la estación Portal Norte?" → "La estación Portal Norte queda en
 * Autopista Norte - CL 172A, sobre la troncal Autonorte." Null without an address.
 * @param {string} nombre
 * @param {string} [direccion]
 * @param {string} [troncal] the corridor's name, without "Troncal"
 */
export function ubicacionEstacion(nombre, direccion, troncal) {
  const lugar = String(direccion ?? '').trim();
  const via = String(troncal ?? '').trim().replace(/^troncal\s+/i, '');
  if (!nombre || !lugar) return null;
  return {
    pregunta: `¿Dónde queda la estación ${nombre}?`,
    respuesta: punto(`La estación ${nombre} queda en ${lugar}${via ? `, sobre la troncal ${via}` : ''}`),
  };
}

/**
 * A station name without its sponsor, for a title that has to fit:
 * "Portal Sur - JFK Coop. Financiera" → "Portal Sur".
 * shortcut: cuts at the first " - ", so a name whose second half is the real
 * place loses it; fine for titles, never for page text.
 */
const corto = (nombre) => String(nombre ?? '').split(/\s[-–—]\s/)[0].trim();

/** First option under the ~65 characters Google shows of a title, else the last. */
const primero = (...opciones) => opciones.find((t) => t.length <= 65) ?? opciones[opciones.length - 1];

/**
 * The route page's <title>, worded as the search: "Ruta B16: paradas de Portal
 * Suba a Terminal y horario". Both ends tell a rider at a glance it is the bus
 * they mean; the old "Ruta B16 Terminal — paradas, recorrido y horarios" named
 * one end and got 0.1 % of clicks at position 7.8 (Search Console, Oct 2026).
 * Shorter forms take over for long names.
 */
export function tituloRuta(codigo, nombre, origen, destino) {
  const [de, a] = [corto(origen), corto(destino)];
  const ruta = nombre && nombre !== codigo ? `Ruta ${codigo} ${nombre}` : `Ruta ${codigo}`;
  return primero(
    ...(de && a && de !== a ? [`Ruta ${codigo}: paradas de ${de} a ${a} y horario`, `Ruta ${codigo}: paradas de ${de} a ${a}`] : []),
    `${ruta}: paradas y horario`,
    ruta
  );
}

/** The station page's <title>, in the words riders search with ("qué buses paran"). */
export function tituloEstacion(nombre) {
  return primero(`Estación ${nombre}: qué buses paran y en qué vagón`, `Estación ${nombre}: qué buses paran`, `Estación ${nombre}`);
}

/** Each código once, in reading order: B10 before B12, 2-2 before 2-10. */
function ordenar(codigos) {
  return [...new Set(codigos.map((c) => String(c ?? '').trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es', { numeric: true })
  );
}

/**
 * "¿Qué buses paran en Portal Norte?" → "En Portal Norte paran B10, B12, … y
 * K16, y los alimentadores y servicios zonales 2-1, … y 2-11." Troncal first —
 * at a portal the feeders outnumber them, and a list that opens on "2-7, 2-4"
 * buries what most searches are about. No count on purpose: the hero counts
 * services (a código per direction), and "18 rutas" under "20 servicios" would
 * read as a contradiction. Null without routes.
 * @param {string} nombre
 * @param {string[]} troncales troncal route códigos
 * @param {string[]} [zonales] alimentador and zonal códigos (`isZonalService`)
 */
export function resumenEstacion(nombre, troncales, zonales = []) {
  const t = ordenar(troncales);
  const z = ordenar(zonales).filter((c) => !t.includes(c));
  if (!nombre || (!t.length && !z.length)) return null;
  const otros = z.length ? `los alimentadores y servicios zonales ${enumerar(z)}` : '';
  const respuesta = !t.length
    ? punto(`En ${nombre} paran ${otros}`)
    : punto(`En ${nombre} ${t.length === 1 ? 'para el' : 'paran'} ${enumerar(t)}${otros ? `, y ${otros}` : ''}`);
  // "buses", not "rutas": it is the word riders search with.
  return { pregunta: `¿Qué buses paran en ${nombre}?`, respuesta };
}
