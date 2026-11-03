/**
 * TransMiZonal nomenclature (`shared/nomenclatura.js`) — the official rules from
 * the Manual de imagen y normas gráficas V.6, delivered by TRANSMILENIO in answer
 * to radicado 2026-ER-47262. Pure logic: no page, no network.
 */

import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  ABREVIATURAS,
  MAX_CARACTERES_NOMBRE,
  ZONAS,
  corredoresRecorridos,
  expandirCorredor,
  expandirHito,
  leerCodigoParadero,
  leerCodigoZonal,
  normalizarCorredor,
  zonaPorNumero,
  zonasDeRuta,
  zonasFrase,
} from '../shared/nomenclatura.js';

test.describe('zones and service codes', () => {
  test('the manual\'s own example: A213 starts in Engativá and ends in Chapinero–Centro', () => {
    const [a213] = leerCodigoZonal('A213')!;
    expect(a213).toMatchObject({ codigo: 'A213', destino: 'A', origen: 'D', numero: 213 });
    expect(a213.destinoNombre).toBe('Chapinero - Centro');
  });

  test('a merged two-way código reads as its two services', () => {
    const services = leerCodigoZonal('AH605')!;
    expect(services.map((s) => s.codigo)).toEqual(['A605', 'H605']);
    expect(services.map((s) => s.destino)).toEqual(['A', 'H']);
    // Both start in H: 605 is in Ciudad Bolívar's range.
    expect(services.every((s) => s.origen === 'H' && s.origenArea === 'Ciudad Bolívar')).toBe(true);
  });

  test('H is one zone with two ranges', () => {
    expect(zonaPorNumero(650)).toEqual({ letra: 'H', area: 'Ciudad Bolívar' });
    expect(zonaPorNumero(705)).toEqual({ letra: 'H', area: 'Usme' });
  });

  test('every number 000–999 belongs to exactly one zone', () => {
    for (let n = 0; n <= 999; n++) expect(zonaPorNumero(n), String(n)).not.toBeNull();
  });

  test('codes outside the rule are not guessed at', () => {
    for (const code of ['661', '10-4', 'E17', 'T11', 'SE10', 'TC30', 'Z13', 'A21']) {
      expect(leerCodigoZonal(code), code).toBeNull();
    }
  });

  test('a route page names the zones a código runs between', () => {
    const catalogo = (...codigos: string[]) => (codigo: string) => codigos.includes(codigo);
    const zonas = (code: string, existe: (codigo: string) => boolean) => {
      const z = zonasDeRuta(code, existe);
      return z && [z.origen.nombre, z.destino.nombre, z.dentro];
    };
    // The number names another zone: the manual's rule.
    expect(zonas('A124', catalogo('A124', 'C124'))).toEqual(['Suba', 'Chapinero - Centro', false]);
    // The letter is the number's own zone: the way back, from its pair's zone.
    expect(zonas('C124', catalogo('A124', 'C124'))).toEqual(['Chapinero - Centro', 'Suba', false]);
    expect(zonas('L800', catalogo('D800', 'L800'))).toEqual(['Engativá - CL 80', 'San Cristóbal - KR 10', false]);
    // No pair: it stays inside, in the area its number names.
    expect(zonas('H729', catalogo('H729'))).toEqual(['Usme', 'Usme', true]);
    // Two pairs, or a código outside the rule: nothing.
    expect(zonasDeRuta('C124', catalogo('A124', 'B124', 'C124'))).toBeNull();
    expect(zonasDeRuta('B75', catalogo('B75'))).toBeNull();
    expect(zonasDeRuta('AH605', catalogo('AH605'))).toBeNull();
    expect(zonasDeRuta('F410', catalogo())?.origen.color).toBe(ZONAS.F.color);
  });

  test('the zones are said in one sentence: "De … a …", or "Dentro de …"', () => {
    const catalogo = (...codigos: string[]) => (codigo: string) => codigos.includes(codigo);
    const nombre = (zona: { nombre: string }) => `[${zona.nombre}]`;
    expect(zonasFrase(zonasDeRuta('C124', catalogo('A124', 'C124'))!, nombre)).toBe('De [Chapinero - Centro] a [Suba]');
    expect(zonasFrase(zonasDeRuta('H729', catalogo('H729'))!, nombre)).toBe('Dentro de [Usme]');
  });

  test('the website, its prerender and the app all read the zones from zonasDeRuta, and say them with zonasFrase', () => {
    for (const file of ['client/src/ui/routePage.ts', 'server/src/prerender_seo.ts', 'client/mobile/src/ui/detailSheets.ts']) {
      const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain('zonasDeRuta(');
      expect(source, file).toContain('zonasFrase(');
    }
  });

  test('zone colours are the official corridor colours', () => {
    expect(ZONAS.A.color).toBe('#26358C');
    expect(ZONAS.F.color).toBe('#DC0814');
    expect(ZONAS.L.color).toBe('#009A9D');
  });

  test('a paradero código reads as número · módulo · zone', () => {
    expect(leerCodigoParadero('078A12')).toEqual({ paradero: 78, modulo: 'A', zona: 12 });
    expect(leerCodigoParadero('TM0119')).toBeNull();
  });
});

test.describe('corridors', () => {
  const cases: Array<[string, string | null]> = [
    ['AKIO', 'AK 10'], //        OCR: I and O inside the number are digits
    ['CL48LS', 'CL 48L S'], //   letter kept, Sur set apart
    ['KR77A', 'KR 77A'],
    ['CL13S', 'CL 13 S'], //     a lone trailing S is Sur, not a letter
    ['CL 13 SUR', 'CL 13 S'],
    ['KR7E', 'KR 7 E'],
    ['CL48BIS', 'CL 48 BIS'], // BIS is not letter B + "IS"
    ['CL 48A BIS B', 'CL 48A BIS B'],
    ['AV.Boyaca', 'AV. BOYACÁ'],
    ['Auto Norte', 'AUTO NORTE'],
    // Avenues as the pieces print them: the older "1/MAYO", a bare name from a
    // two-line chip, and avenues the official list leaves out.
    ['AV. 1/MAYO', 'AV. 1° DE MAYO'],
    ['BOYACÁ', 'AV. BOYACÁ'],
    ['NQS', 'AV. NQS'],
    ['AV. CIRCUNVALAR', 'AV. CIRCUNVALAR'],
    ['AV. G. CORTÉS', 'AV. G. CORTÉS'], // an unlisted avenue keeps its printed accent
    ['AVENIDA MUTIS', 'AV. MUTIS'],
    // Past Bogotá's numbering ceiling, a trailing 8/0/6 is the letter B/D/G
    // misread (F425's KR 78B came back as KR 788); anything else is rejected.
    ['KR 788', 'KR 78B'],
    ['CL 245', 'CL 245'],
    ['KR 999', null],
    // …but an unknown name needs an explicit "AV." marker at a word boundary.
    ['GUAYACANES', null],
    ['Ave wao', null],
    ['68', null],
    ['CL O', null],
    ['hola', null],
  ];
  for (const [input, expected] of cases) {
    test(`${input} → ${expected}`, () => expect(normalizarCorredor(input)).toBe(expected));
  }
});

test.describe('abbreviations', () => {
  test('the official list is complete in its four groups', () => {
    expect(ABREVIATURAS.vias.map(([, a]) => a)).toEqual(expect.arrayContaining(['AC', 'AK', 'CL', 'KR', 'DG', 'TV']));
    expect(ABREVIATURAS.hitosGenericos.find(([f]) => f === 'Hospital')?.[1]).toBe('Hsp.');
    expect(ABREVIATURAS.hitosPropios.length).toBeGreaterThanOrEqual(30);
    expect(MAX_CARACTERES_NOMBRE).toBe(17);
  });

  test('hitos expand for search and speech, longest abbreviation first', () => {
    expect(expandirHito('Hsp. S. Bolívar')).toBe('Hospital Simón Bolívar');
    expect(expandirHito('Pq. El Virrey')).toBe('Parque El Virrey');
    expect(expandirHito('GALERÍAS')).toBe('GALERÍAS');
  });

  test('corredores expand as they are said', () => {
    expect(expandirCorredor('AC 13')).toBe('Avenida Calle 13');
    expect(expandirCorredor('AK 7 S')).toBe('Avenida Carrera 7 Sur');
    expect(expandirCorredor('KR 68B BIS')).toBe('Carrera 68B Bis');
    expect(expandirCorredor('AV. C. CALI')).toBe('Avenida Ciudad de Cali');
    expect(expandirCorredor('AV. SUBA')).toBe('Avenida SUBA');
    expect(expandirCorredor('DIRECTO')).toBe('DIRECTO');
  });
});

test.describe('the streets a run of stops rides', () => {
  const en = (corredor: string, n: number) => Array.from({ length: n }, (_, i) => `${corredor} - CL ${i + 1}`);

  test('three stops in a row on one street make a corredor, in the order ridden', () => {
    const direcciones = [...en('AV. Esperanza', 4), 'KR 81 - CL 24', ...en('AC 63', 3), ...en('KR 15', 5)];
    expect(corredoresRecorridos(direcciones)).toEqual(['AV. ESPERANZA', 'KR 15']);
    expect(corredoresRecorridos(direcciones, 3)).toEqual(['AV. ESPERANZA', 'AC 63', 'KR 15']);
  });

  test('a turn, a missing address or a street met twice is not counted twice', () => {
    expect(corredoresRecorridos(['KR 81 - CL 24', 'CL 26 - KR 1', undefined, null])).toEqual([]);
    expect(corredoresRecorridos([...en('AV. Caracas', 3), 'CL 13 – KR 16', ...en('AV. Caracas', 4)], 3)).toEqual(['AV. CARACAS']);
  });
});
