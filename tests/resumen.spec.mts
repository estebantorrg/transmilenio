import { test, expect } from '@playwright/test';
import { horarioRuta, resumenEstacion, resumenRuta, ubicacionEstacion } from '../shared/resumen.js';

/**
 * The search question each route and station page answers in a sentence
 * (`shared/resumen.js`, spec §5.5.4): "¿Dónde para el B11?" in the words a rider
 * types, answered from the page's own data. One module for the prerendered body
 * and the bundle's page, so both say the same.
 */

test.describe('resumen de una ruta', () => {
  const paradas = ['Portal Sur', 'Alquería', 'NQS Calle 30 Sur', 'Ricaurte', 'Paloquemao', 'Calle 85', 'Calle 146', 'Toberín', 'Terminal'];

  test('asks where the route stops and answers with its ends and three stops between', () => {
    expect(resumenRuta('B11', paradas)).toEqual({
      pregunta: '¿Dónde para el B11?',
      respuesta: 'El B11 tiene 9 paradas, desde Portal Sur hasta Terminal, pasando por NQS Calle 30 Sur, Paloquemao y Calle 146.',
    });
  });

  test('a short trip names what it has, never an endpoint twice', () => {
    expect(resumenRuta('8', ['A', 'B'])!.respuesta).toBe('El 8 tiene 2 paradas, desde A hasta B.');
    expect(resumenRuta('8', ['A', 'B', 'C'])!.respuesta).toBe('El 8 tiene 3 paradas, desde A hasta C, pasando por B.');
    expect(resumenRuta('8', ['A'])!.respuesta).toBe('El 8 para en A.');
  });

  test('a name that already ends in a period does not get a second one', () => {
    expect(resumenRuta('B11', ['Portal Sur', 'Calle 85', 'Terminal Coop.'])!.respuesta).toBe(
      'El B11 tiene 3 paradas, desde Portal Sur hasta Terminal Coop., pasando por Calle 85.'
    );
    expect(resumenRuta('B11', ['Portal Sur', 'Calle 85', 'C.C.'])!.respuesta).toBe(
      'El B11 tiene 3 paradas, desde Portal Sur hasta C.C., pasando por Calle 85.'
    );
    expect(resumenRuta('8', ['C.C.'])!.respuesta).toBe('El 8 para en C.C.');
  });

  test('says nothing without stops', () => {
    expect(resumenRuta('B11', [])).toBeNull();
    expect(resumenRuta('B11', ['', '  '])).toBeNull();
  });
});

test.describe('horario de una ruta', () => {
  test('asks when the route runs and answers in days and clock words', () => {
    expect(horarioRuta('B11', 'L-V 5:00 AM-9:00 PM / S 6:00 AM-9:30 PM')).toEqual({
      pregunta: '¿A qué hora pasa el B11?',
      respuesta: 'El B11 funciona de lunes a viernes de 5:00 a. m. a 9:00 p. m. y los sábados de 6:00 a. m. a 9:30 p. m.',
    });
    expect(horarioRuta('1', 'D-F 6:00 AM-8:00 PM')!.respuesta).toBe('El 1 funciona los domingos y festivos de 6:00 a. m. a 8:00 p. m.');
  });

  test('weekdays come first, whatever order the catalog lists them in', () => {
    expect(horarioRuta('B11', 'S 6:00 AM-9:30 PM / L-V 5:00 AM-9:00 PM')!.respuesta).toBe(
      'El B11 funciona de lunes a viernes de 5:00 a. m. a 9:00 p. m. y los sábados de 6:00 a. m. a 9:30 p. m.'
    );
  });

  test('leaves out a day code it does not know, and says nothing when no row reads', () => {
    expect(horarioRuta('B11', 'L-V 5:00 AM-9:00 PM / X 6:00 AM-9:30 PM')!.respuesta).toBe(
      'El B11 funciona de lunes a viernes de 5:00 a. m. a 9:00 p. m.'
    );
    expect(horarioRuta('B11', undefined)).toBeNull();
    expect(horarioRuta('B11', 'Q 1:00-2:00')).toBeNull();
  });
});

test.describe('ubicación de una estación', () => {
  test('asks where the station is and answers with its address and corridor', () => {
    expect(ubicacionEstacion('Portal Norte', 'Autopista Norte - CL 172A', 'Autonorte')).toEqual({
      pregunta: '¿Dónde queda la estación Portal Norte?',
      respuesta: 'La estación Portal Norte queda en Autopista Norte - CL 172A, sobre la troncal Autonorte.',
    });
    expect(ubicacionEstacion('Ricaurte', 'AV NQS - CL 13', 'Troncal NQS')!.respuesta).toBe(
      'La estación Ricaurte queda en AV NQS - CL 13, sobre la troncal NQS.'
    );
    expect(ubicacionEstacion('Ricaurte', 'AV NQS - CL 13')!.respuesta).toBe('La estación Ricaurte queda en AV NQS - CL 13.');
    expect(ubicacionEstacion('Ricaurte', '')).toBeNull();
  });
});

test.describe('resumen de una estación', () => {
  test('asks which buses stop there and lists each código once, in reading order', () => {
    expect(resumenEstacion('Calle 100', ['K16', 'B11', 'C17', 'B11', 'B10'])).toEqual({
      pregunta: '¿Qué buses paran en Calle 100?',
      respuesta: 'En Calle 100 paran B10, B11, C17 y K16.',
    });
  });

  test('troncal routes come first, feeders and zonal services after them', () => {
    // A portal's feeders outnumber its troncales; opening on "2-7, 2-4" buried them.
    expect(resumenEstacion('Portal Norte', ['B75', 'H13'], ['2-7', '2-10', '2-2']).respuesta).toBe(
      'En Portal Norte paran B75 y H13, y los alimentadores y servicios zonales 2-2, 2-7 y 2-10.'
    );
    expect(resumenEstacion('Portal Norte', [], ['2-1']).respuesta).toBe(
      'En Portal Norte paran los alimentadores y servicios zonales 2-1.'
    );
  });

  test('one route reads in the singular; none says nothing', () => {
    expect(resumenEstacion('Guatoque', ['G43'])!.respuesta).toBe('En Guatoque para el G43.');
    expect(resumenEstacion('Guatoque', [], [])).toBeNull();
  });
});
