import { test, expect } from '@playwright/test';
import { ocupacionDe, ocupacionTexto } from '../shared/ocupacion.js';

/**
 * How full a live bus is (`shared/ocupacion.js`, spec §5.8). A third of the fleet
 * sends no reading, so "no reading" must never come out as "empty".
 */

test.describe('reading ocupacion_bus', () => {
  test('the three levels, however the feed spells them', () => {
    expect(ocupacionDe({ ocupacion_bus: 'LLENO' })).toBe('LLENO');
    expect(ocupacionDe({ ocupacion_bus: ' medio ' })).toBe('MEDIO');
    expect(ocupacionDe({ ocupacion_bus: 'VACÍO' })).toBe('VACIO');
  });

  test('no reading is null, never a level', () => {
    // The four-digit fleets send an empty string.
    expect(ocupacionDe({ ocupacion_bus: '' })).toBeNull();
    expect(ocupacionDe({})).toBeNull();
    expect(ocupacionDe(null)).toBeNull();
    expect(ocupacionDe({ ocupacion_bus: 'SEMI' })).toBeNull();
    expect(ocupacionDe({ ocupacion_bus: 'constructor' })).toBeNull();
    expect(ocupacionTexto(null)).toBeNull();
  });

  test('worded for riders', () => {
    expect(ocupacionTexto('VACIO')).toBe('Vacío');
    expect(ocupacionTexto('MEDIO')).toBe('Medio lleno');
    expect(ocupacionTexto('LLENO')).toBe('Lleno');
  });
});

