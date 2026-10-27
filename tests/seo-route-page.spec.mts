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
