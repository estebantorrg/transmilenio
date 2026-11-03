/**
 * The printed rutero (`shared/tabla_rutero.js`) — the table from the paradero's
 * plegable on the route page. Pure logic: no page, no network.
 */

import { expect, test } from '@playwright/test';
import { HITOS_DE_ESTACION, agruparFilas, corredoresDe, estacionDeHito, rutasQueLleganA, sentidosHacia, tablaRuteroHtml, type RuteroTradicional } from '../shared/tabla_rutero.js';

test.describe('consecutive rows on one corredor are one cell', () => {
  test('260 prints AV. BOYACÁ once beside MODELIA and NORMANDÍA', () => {
    const grupos = agruparFilas([
      ['DG 64A BIS', 0, 'SEVILLANA'],
      ['AV. BOYACÁ', 1, 'MODELIA'],
      ['AV. BOYACÁ', 1, 'NORMANDÍA'],
      ['CL 127', 0, 'BULEVAR NIZA'],
    ]);
    expect(grupos.map((g) => [g.corredor, g.hitos])).toEqual([
      ['DG 64A BIS', ['SEVILLANA']],
      ['AV. BOYACÁ', ['MODELIA', 'NORMANDÍA']],
      ['CL 127', ['BULEVAR NIZA']],
    ]);
  });

  test('only when seguidos: a corredor left and rejoined is printed again', () => {
    const grupos = agruparFilas([
      ['AV. 1° DE MAYO', 0, 'A'],
      ['KR 10', 0, 'B'],
      ['AV. 1° DE MAYO', 0, 'C'],
      ['AV. 1° DE MAYO', 0, 'D'],
    ]);
    expect(grupos.map((g) => [g.corredor, g.hitos.length])).toEqual([
      ['AV. 1° DE MAYO', 1],
      ['KR 10', 1],
      ['AV. 1° DE MAYO', 2],
    ]);
  });

  test('a different chip colour is a different cell, and rows without a corredor never merge', () => {
    expect(agruparFilas([['AC 26', 0, 'A'], ['AC 26', 1, 'B']])).toHaveLength(2);
    expect(agruparFilas([[null, 0, 'A'], [null, 0, 'B']])).toHaveLength(2);
  });

  test('the merged corredor is one cell spanning its rows', () => {
    const html = tablaRuteroHtml({
      codigo: '260',
      color: '#1c6695',
      sentido: { destino: 'UNICENTRO', filas: [['AV. BOYACÁ', 1, 'MODELIA'], ['AV. BOYACÁ', 1, 'NORMANDÍA']] },
    });
    expect(html.match(/class="tr-corredor/g)).toHaveLength(1);
    expect(html).toContain('rowspan="2"');
    expect(html.match(/class="tr-hito/g)).toHaveLength(2);
  });
});

test.describe('the sentido on screen', () => {
  const ruta: RuteroTradicional = {
    formato: 'tabla',
    sentidos: [
      { destino: 'SABANA DEL DORADO', filas: [] },
      { destino: 'PROVIDENCIA ALTA', filas: [] },
    ],
  };

  test('matches the catalog name despite accents, articles and a letter or two', () => {
    expect(sentidosHacia(ruta, 'Sabana de Dorado').map((s) => s.destino)).toEqual(['SABANA DEL DORADO']);
    expect(sentidosHacia(ruta, 'Providencia Alta').map((s) => s.destino)).toEqual(['PROVIDENCIA ALTA']);
  });

  test('guesses nothing: another direction gets no table', () => {
    expect(sentidosHacia(ruta, 'Portal Tunal')).toEqual([]);
    const calles: RuteroTradicional = { formato: 'tabla', sentidos: [{ destino: 'CALLE 222', filas: [] }] };
    expect(sentidosHacia(calles, 'Calle 197')).toEqual([]);
  });

  test('its corredores for the route list: the main one first, each once', () => {
    const sentido = {
      destino: 'CHICÓ NORTE',
      filas: [['AV. C. CALI', 0, 'HAYUELOS'], ['AV. ESPERANZA', 1, 'CIUDAD SALITRE'], ['AC 63', 0, 'PQ. LOURDES'], ['AC 63', 0, 'CAMPÍN'], [null, 0, 'DIRECTO'], ['KR 15', 0, 'CHICÓ']],
    } as const;
    expect(corredoresDe([sentido])).toEqual(['AV. ESPERANZA', 'AV. C. CALI', 'AC 63']);
    expect(corredoresDe([sentido], 5)).toEqual(['AV. ESPERANZA', 'AV. C. CALI', 'AC 63', 'KR 15']);
    expect(corredoresDe([])).toEqual([]);
  });
});

test.describe('the drawing', () => {
  test('a long avenue breaks after AV., as the chip prints it', () => {
    const html = tablaRuteroHtml({
      codigo: 'A410',
      color: '#26358C',
      sentido: { destino: 'CHICÓ NORTE', filas: [['AV. ESPERANZA', 1, 'CIUDAD SALITRE']] },
    });
    expect(html).toContain('AV.<br>ESPERANZA');
  });

  test('the digital layout is a bar and a strip of hito/CORREDOR pairs', () => {
    const html = tablaRuteroHtml({
      codigo: 'C149',
      color: '#FCBD1B',
      formato: 'digital',
      sentido: { destino: 'BILBAO', filas: [['CL 26', 0, 'CAN'], ['KR 77A', 0, 'Villa Luz']] },
    });
    expect(html).toContain('tr-digital');
    expect(html).toContain('<span aria-hidden="true">CAN</span>');
    expect(html).toContain('/<b title="CALLE 26"><span aria-hidden="true">CL 26</span>');
    expect(html).toContain('Villa Luz/<b title="CARRERA 77A">');
    expect(html).not.toContain('<table');
  });

  test('an abbreviation is drawn as printed, and said and shown spelled out', () => {
    const html = tablaRuteroHtml({
      codigo: 'A410',
      color: '#26358C',
      sentido: { destino: 'CHICÓ NORTE', filas: [['AC 63', 0, 'PQ. LOURDES'], ['KR 15', 0, 'CHICÓ']] },
    });
    // The hito: the print's short form for the eye, the words for a screen reader and a tooltip.
    expect(html).toContain('title="PARQUE LOURDES"><span aria-hidden="true">PQ. LOURDES</span><span class="tr-sr">PARQUE LOURDES</span>');
    // The corredor chip too.
    expect(html).toContain('title="AVENIDA CALLE 63"><span aria-hidden="true">');
    // A hito with nothing to spell out is left alone.
    expect(html).toContain('>CHICÓ</td>');
  });

  test('a row with no corredor runs across the whole table, as printed', () => {
    const html = tablaRuteroHtml({
      codigo: '111',
      color: '#1c6695',
      sentido: { destino: 'GAVIOTAS', filas: [['AC 6', 0, 'RICAURTE'], [null, 0, 'ESTACIÓN AV. 1° DE MAYO'], ['KR 11 E', 0, 'NUEVA GLORIA']] },
    });
    expect(html).toContain('colspan="2">ESTACIÓN AV. 1° DE MAYO<');
    expect(html.match(/class="tr-corredor/g)).toHaveLength(2);
  });

  test('one hito beside two chips is one cell, as the piece prints it', () => {
    // D206: NORMANDÍA beside AV. ROJAS and CL 53.
    const html = tablaRuteroHtml({
      codigo: 'D206',
      color: '#8064A9',
      sentido: { destino: 'BACHUÉ', filas: [['AC 26', 0, 'CAN'], ['AV. ROJAS', 0, 'NORMANDÍA'], ['CL 53', 0, 'NORMANDÍA'], ['AV. C. CALI', 1, 'LA SERENA']] },
    });
    expect(html.match(/>NORMANDÍA</g)).toHaveLength(1);
    expect(html).toContain('rowspan="2">NORMANDÍA<');
    expect(html.match(/class="tr-corredor/g)).toHaveLength(4);
  });

  test('a DIRECTO band runs across the table, dark as printed', () => {
    const html = tablaRuteroHtml({
      codigo: 'T163',
      color: '#1c6695',
      sentido: { destino: 'CALLE 222', filas: [[null, 0, 'DIRECTO NQS'], ['AC 100', 0, 'CHICÓ NORTE'], [null, 0, 'ESTACIÓN AV. 1° DE MAYO']] },
    });
    expect(html).toContain('class="tr-hito tr-ancha tr-directo');
    expect(html.match(/tr-directo/g)).toHaveLength(1);
  });

  test('text is escaped', () => {
    const html = tablaRuteroHtml({ codigo: '1', color: '#000000', sentido: { destino: '<b>', filas: [['KR 1', 0, 'A&B']] } });
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('A&amp;B');
  });
});

test.describe('a hito that names an estación', () => {
  test('is read from what the print marks, whatever the spelling', () => {
    expect(estacionDeHito('EST. BANDERAS')).toBe('TM0083');
    expect(estacionDeHito('Portal de Usme')).toBe('TM0118');
    expect(estacionDeHito('EST. CALLE 1 OO')).toBe('TM0018');
    expect(estacionDeHito('ESTACIÓN AV. 1° DE MAYO')).toBe('TM0143');
    expect(estacionDeHito('P. 20 DE JULIO')).toBe('TM0145');
    expect(estacionDeHito('TERMINAL NORTE')).toBe('TM0031');
  });

  test('a barrio, a market or the bus terminal is no estación', () => {
    for (const hito of ['RESTREPO', 'VENECIA', 'PORTALES DEL NORTE', 'P. MERCADO QUIRIGUA', 'TERMINAL', 'TERMINAL SALITRE', 'EST. PROFAMILIA']) {
      expect(estacionDeHito(hito), hito).toBeNull();
    }
  });

  const sentido = { destino: 'SUBA', filas: [['AV. SUBA', 0, 'PORTAL SUBA'], ['AV. BOYACÁ', 0, 'RESTREPO'], [null, 0, 'EST. BANDERAS']] } as const;
  const estacionHref = (codigo: string) => (codigo === 'TM0045' ? '/estacion/portal-suba-tm0045/' : null);

  test('links to its page in the table, and only it', () => {
    const html = tablaRuteroHtml({ codigo: 'B905', color: '#80BA27', sentido, estacionHref });
    expect(html).toContain('<a href="/estacion/portal-suba-tm0045/">PORTAL SUBA</a>');
    expect(html).toContain('>RESTREPO</td>');
    // The catalog has no page for it here, so it stays text instead of a dead link.
    expect(html).toContain('>EST. BANDERAS</td>');
  });

  test('links in the digital format too, and not at all without a way to build the address', () => {
    expect(tablaRuteroHtml({ codigo: 'B905', color: '#80BA27', formato: 'digital', sentido, estacionHref })).toContain('<a href="/estacion/portal-suba-tm0045/">');
    expect(tablaRuteroHtml({ codigo: 'B905', color: '#80BA27', sentido })).not.toContain('<a ');
  });

  test('the routes that name an estación come back once each, in order', () => {
    const fila = (hito: string) => ({ destino: 'X', filas: [['KR 1', 0, hito]] as const });
    const rutas = {
      B905: { formato: 'tabla', sentidos: [fila('PORTAL SUBA'), fila('Portal Suba')] },
      A151: { formato: 'tabla', sentidos: [fila('PORTAL SUBA')] },
      G505: { formato: 'tabla', sentidos: [fila('PORTAL SUR')] },
    } as Record<string, RuteroTradicional>;
    expect(rutasQueLleganA(rutas, 'TM0045')).toEqual(['A151', 'B905']);
  });

  test('every estación in the table is one the catalog has', async ({ request }) => {
    const res = await request.get('/api/troncal/master-catalog', { timeout: 90_000 });
    const { data } = await res.json();
    expect(Object.keys(HITOS_DE_ESTACION).filter((codigo) => !data.stations[codigo]?.estacion)).toEqual([]);
  });
});
