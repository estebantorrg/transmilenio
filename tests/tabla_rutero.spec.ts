/**
 * The printed rutero (`shared/tabla_rutero.js`) — the table from the paradero's
 * plegable on the route page. Pure logic: no page, no network.
 */

import { expect, test } from '@playwright/test';
import { agruparFilas, sentidosHacia, tablaRuteroHtml, type RuteroTradicional } from '../shared/tabla_rutero.js';

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
    expect(html).toContain('CAN/<b>CL 26</b>');
    expect(html).not.toContain('<table');
  });

  test('text is escaped', () => {
    const html = tablaRuteroHtml({ codigo: '1', color: '#000000', sentido: { destino: '<b>', filas: [['KR 1', 0, 'A&B']] } });
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('A&amp;B');
  });
});
