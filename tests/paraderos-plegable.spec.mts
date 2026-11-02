/**
 * The icons of a plegable's "Listado de Paraderos", read from the drawing
 * (scripts/ocr/paraderos.mjs): the grid gives the módulos, the outline the one
 * this route uses, and the alignment with the catalog decides what is published.
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { alinear, leerPagina } from '../scripts/ocr/paraderos.mjs';

const rect = (x0: number, y0: number, w: number, h: number, fill: string) => ({ x0, y0, x1: x0 + w, y1: y0 + h, w, h, fill, rect: true });
const curva = (x0: number, y0: number, w: number, h: number, fill: string) => ({ ...rect(x0, y0, w, h, fill), rect: false });

/** A grid at (x, y); `letras` are the squares with a letter drawn in, `elegida` the outlined one. */
function grilla(x: number, y: number, letras: string, elegida?: string) {
  const pos = (l: string) => { const i = 'ABCD'.indexOf(l); return [x + (i % 2) * 5.5, y + Math.floor(i / 2) * 5.5]; };
  return [...'ABCD'].flatMap((l) => {
    const [cx, cy] = pos(l);
    return [
      rect(cx, cy, 5, 5, '#ffc83c'),
      ...(letras.includes(l) ? [curva(cx + 1, cy + 0.4, 2.8, 4.2, '#2c2e35')] : []),
      ...(l === elegida ? [curva(cx - 0.3, cy - 0.3, 6.1, 6.1, '#063579')] : []),
    ];
  });
}
const simple = (x: number, y: number) => [curva(x, y, 9.2, 9.2, '#063579'), curva(x + 0.6, y + 0.6, 8.1, 8.1, '#ffffff'), { ...curva(x + 2, y + 2, 4.9, 5.7, '#2c2e35'), n: 275 }];

test('leerPagina reads each column down, the grid by position and the outline as the módulo', () => {
  const [bloque, ...resto] = leerPagina({
    W: 612,
    H: 792,
    fills: [
      rect(65, 76, 532, 22, '#0a389d'),
      ...simple(14, 140),
      ...grilla(14, 105, 'AB', 'B'),
      ...simple(100, 105),
      ...grilla(100, 140, 'ABCD', 'C'),
      // The legend above the first block is no stop.
      ...simple(14, 40),
    ],
  });
  expect(resto).toEqual([]);
  expect(bloque.paradas).toEqual([
    { tipo: 'multiple', modulos: ['A', 'B'], modulo: 'B' },
    { tipo: 'simple' },
    { tipo: 'simple' },
    { tipo: 'multiple', modulos: ['A', 'B', 'C', 'D'], modulo: 'C' },
  ]);
});

test('alinear agrees by módulo, lets an estación pass, and reports what only one side has', () => {
  const stops = [{ codigo: '603A08' }, { codigo: '160B08' }, { codigo: 'TM0085' }, { codigo: '604A08' }];
  const paradas = [{ tipo: 'simple' }, { tipo: 'multiple', modulos: ['A', 'B'], modulo: 'B' }, { tipo: 'simple' }, { tipo: 'simple' }];
  expect(alinear(paradas, stops).acuerdo).toBe(1);

  const contradice = alinear([{ tipo: 'simple' }, { tipo: 'multiple', modulos: ['A', 'B'], modulo: 'A' }], [{ codigo: '603A08' }, { codigo: '160B08' }]);
  expect(contradice.pares.map((p) => p.ok)).toEqual([true, false]);

  const falta = alinear([{ tipo: 'simple' }], [{ codigo: '603A08' }, { codigo: '604A08' }]);
  expect(falta.pares.filter((p) => p.i === null)).toHaveLength(1);
});

test('the published file holds well-formed módulos and stop códigos', () => {
  const { bahias, dudas } = JSON.parse(readFileSync('server/src/data/paraderos_plegable.json', 'utf8'));
  expect(Object.keys(bahias).length).toBeGreaterThan(500);
  for (const [key, letras] of Object.entries<string[]>(bahias)) {
    expect(key).toMatch(/^\d{3}-\d{2}$/);
    expect(letras.join('')).toMatch(/^A?B?C?D?E?F?$/);
  }
  for (const code of dudas) expect(code).toMatch(/^(\d{3}[A-E]\d{2}|\S+)$/);
});
