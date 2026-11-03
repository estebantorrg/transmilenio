/**
 * Reading a typed barrio against a place's name (shared/barrios.js): word starts,
 * any order, accents and dots ignored, abbreviations both ways.
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { coincideBarrio, palabrasBarrio, textoBarrio } from '../shared/barrios.js';
import { expandirHito } from '../shared/nomenclatura.js';

const pasa = (consulta: string, nombre: string) => coincideBarrio(textoBarrio(nombre), palabrasBarrio(consulta)!);

test('accents, capitals and dots do not matter', () => {
  expect(pasa('galerias', 'GALERÍAS')).toBe(true);
  expect(pasa('MODELIA', 'Br. Modelia Occidental')).toBe(true);
  expect(pasa('cc andino', 'C.C. Andino')).toBe(true);
});

test('an abbreviation matches spelled out, and as printed', () => {
  expect(pasa('hospital kennedy', 'HSP. KENNEDY')).toBe(true);
  expect(pasa('hsp kennedy', 'HSP. KENNEDY')).toBe(true);
  expect(pasa('parque virrey', 'Pq. El Virrey')).toBe(true);
  expect(pasa('centro comercial andino', 'C.C. Andino')).toBe(true);
});

test('words match at their start, in any order', () => {
  expect(pasa('kennedy hospital', 'Hsp. Kennedy')).toBe(true);
  expect(pasa('ria', 'Br. María Paz')).toBe(false);
  expect(pasa('calle 100', 'Suba-Calle 100')).toBe(true);
  expect(pasa('modelia norte', 'Br. Modelia Occidental')).toBe(false);
});

test('what no sign prints is ignored, and a query too short names no place', () => {
  expect(pasa('barrio modelia', 'Br. Modelia')).toBe(true);
  expect(pasa('estación ricaurte', 'Ricaurte')).toBe(true);
  expect(palabrasBarrio('ab')).toBeNull();
  expect(palabrasBarrio('barrio')).toBeNull();
  expect(palabrasBarrio('')).toBeNull();
});

test('expanding every hito twice gives the same text, so the regexes hold no state', () => {
  expect(expandirHito('Hsp. S. Bolívar')).toBe('Hospital Simón Bolívar');
  expect(expandirHito('Hsp. S. Bolívar')).toBe('Hospital Simón Bolívar');
});

test('the app\'s search lists the routes that pass a barrio by the website\'s rule', () => {
  for (const file of ['client/src/ui/sidebar.ts', 'client/mobile/src/views/rutas.ts']) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source, file).toContain('rutasQuePasan(');
    expect(source, file).toContain('Rutas que pasan por ');
  }
});
