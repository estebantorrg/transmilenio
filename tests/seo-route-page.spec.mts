import { test, expect } from '@playwright/test';
import { renderRoute, troncalFirst } from '../server/src/prerender_seo.ts';

/**
 * The prerendered `/ruta/<código>/` page (`server/src/prerender_seo.ts`, spec
 * §5.5.4). `7` and `C25` are a TransMilenio service AND a zonal one, and the
 * page, its card and its hub link describe the first variant: with the catalog
 * listing the zonal first, `/ruta/7/` was titled for the Palmitas bus.
 */

const stop = (codigo: string, nombre: string, posicion: number) => ({ codigo, nombre, coordenada: '4.7,-74.08', posicion });

const zonal = {
  id: '7-zonal',
  codigo: '7',
  nombre: 'Palmitas',
  sistema: 'TransMiZonal',
  tipoServicio: 'URBANO',
  origin: 'IED Aulas Colombianas San Luis',
  destination: 'Br. Las Palmitas',
  stops: [stop('101A01', 'IED Aulas Colombianas San Luis', 0), stop('101A02', 'Br. Las Palmitas', 900)],
};
const troncal = {
  id: '7-troncal',
  codigo: '7',
  nombre: 'Portal Suba',
  sistema: 'TransMilenio',
  tipoServicio: 'TRONCAL',
  origin: 'Portal Tunal',
  destination: 'Portal Suba',
  stops: [stop('TM0119', 'Portal Tunal', 0), stop('TM0018', 'Calle 100', 9000), stop('TM0030', 'Portal Suba', 15000)],
};

test('a código in both networks leads with its TransMilenio service', () => {
  expect(troncalFirst([zonal, troncal]).map((v) => v.id)).toEqual(['7-troncal', '7-zonal']);
  // Catalog order is kept otherwise.
  expect(troncalFirst([troncal, { ...troncal, id: 'b' }, zonal]).map((v) => v.id)).toEqual(['7-troncal', 'b', '7-zonal']);
});

test('its page is titled and tagged for the TransMilenio service, and still lists both', () => {
  const page = renderRoute('7', troncalFirst([zonal, troncal]), new Map(), undefined);
  expect(page.title).toBe('Ruta 7: paradas de Portal Tunal a Portal Suba y horario');
  expect(page.description).toContain('desde Portal Tunal hasta Portal Suba');
  expect(page.body).toContain('<span class="tag">TRONCAL</span>');
  expect(page.body).toContain('Hacia Br. Las Palmitas');
});

test('a zonal page names the zones its código runs between', () => {
  const c124 = { ...zonal, id: 'c124', codigo: 'C124', nombre: 'Bilbao' };
  const catalogo = (c: string) => ['A124', 'C124'].includes(c);
  // C124 is A124's way back: from Chapinero - Centro to Suba, not "Suba to Suba".
  const { body } = renderRoute('C124', [c124], new Map(), undefined, null, catalogo);
  expect(body).toContain(
    '<p class="zonas">De <span class="zona"><i style="background:#26358C"></i>Chapinero - Centro</span>' +
      ' a <span class="zona"><i style="background:#FCBD1B"></i>Suba</span></p>'
  );
  // Without the catalog to read the pair from, and on a troncal código, nothing.
  expect(renderRoute('C124', [c124], new Map(), undefined).body).not.toContain('class="zonas"');
  expect(renderRoute('7', [troncal], new Map(), undefined, null, () => true).body).not.toContain('class="zonas"');
});

test("an alimentador's printed rutero takes its portal's colour from the piece; the page keeps its own", () => {
  const sentido = { destino: 'NEBRASKA', filas: [['AV. CARACAS', 0, 'Portal Usme']] as const };
  const alimentador = { ...zonal, id: '3-13', codigo: '3-13', nombre: 'Nebraska', sistema: 'TransMilenio', tipoServicio: 'ALIMENTADOR_V', color: '#009944' };
  const { body } = renderRoute('3-13', [alimentador], new Map(), { formato: 'digital', color: '#ff8525', sentidos: [sentido] });
  expect(body).toContain('--tr-zona:#ff8525');
  // The page is alimentador green, as the app draws it, also where the código
  // carries a zone letter: H728 came out in zone H's colour.
  expect(body).toContain('style="--accent:#009944"');
  const h728 = { ...alimentador, id: 'h728', codigo: 'H728', nombre: 'Danubio' };
  expect(renderRoute('H728', [h728], new Map(), undefined).body).toContain('style="--accent:#009944"');
  // A zonal route keeps its zone colour for the table, whatever the piece's shade.
  const a = { ...zonal, id: 'a818', codigo: 'A818', nombre: 'Galerías' };
  expect(renderRoute('A818', [a], new Map(), { formato: 'digital', color: '#0c3b96', sentidos: [sentido] }).body).not.toContain('--tr-zona:#0c3b96');
});

test('a digital piece gets the zonal LED sign, as the app draws it; a printed table alone gets none', () => {
  const sentido = { destino: 'GALERÍAS', filas: [['CL 1 S', 0, 'Est. Nariño'], [null, 0, 'Teusaquillo']] as const };
  const a = { ...zonal, id: 'a818', codigo: 'A818', nombre: 'Galerías' };
  const { body } = renderRoute('A818', [a], new Map(), { formato: 'digital', color: '#0c3b96', sentidos: [sentido] });
  // Zone A's colour, the printed destino on top, the printed strip scrolling under it.
  expect(body).toContain('fill="#26358C"');
  expect(body).toContain('aria-label="Rutero electrónico de la ruta A818 hacia GALERÍAS, dibujo sin verificar"');
  expect(body).toContain('class="rutero-pasa"');
  expect(body).toContain('Rutero electrónico · dibujo sin verificar');
  // Above the printed table, with the animation and its reduced-motion stop in the page's own stylesheet.
  expect(body.indexOf('rutero-pasa"')).toBeLessThan(body.indexOf('class="tabla-ruteros"'));
  expect(body).toContain('@keyframes rutero-pasa');
  expect(body).toMatch(/prefers-reduced-motion:reduce\)\{#seo-prerender \.rutero-pasa\{animation:none\}/);
  // An alimentador's sign is its portal's line, as its piece prints the código.
  const alimentador = { ...zonal, id: '3-13', codigo: '3-13', nombre: 'Nebraska', sistema: 'TransMilenio', tipoServicio: 'ALIMENTADOR_V', color: '#009944' };
  expect(renderRoute('3-13', [alimentador], new Map(), { formato: 'digital', color: '#ff8525', sentidos: [sentido] }).body).toContain('fill="#ff8525"');
  expect(renderRoute('A818', [a], new Map(), { formato: 'tabla', sentidos: [sentido] }).body).not.toContain('Rutero electrónico');
});
