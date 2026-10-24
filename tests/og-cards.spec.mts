import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { prepareWordmark, routeCardSvg, stationCardSvg } from '../server/src/seo_og.ts';

/**
 * The link-preview cards of /ruta/ and /estacion/ (`server/src/seo_og.ts`, spec
 * §5.5.4): map first, the identity in the band below it, badges as pills. Read
 * off the SVG, before resvg, so no font or native binary is needed here.
 */

test.beforeAll(() => prepareWordmark(fileURLToPath(new URL('../client/public/wordmark.svg', import.meta.url))));

const at = (svg: string, re: RegExp) => [...svg.matchAll(re)].map((m) => m.slice(1));

const station = (codigos: string[]) =>
  stationCardSvg({
    nombre: 'Calle 146',
    direccion: 'Autopista Norte - CL 147',
    serviceCount: codigos.length,
    vagones: [{ label: '1', sentido: null, codigos: codigos.map((codigo) => ({ codigo, color: '#80BA27' })) }],
    unassigned: [],
    feeders: [],
    point: [-74.0498, 4.7309],
    lines: [{ color: '#80BA27', paths: [[[-74.05, 4.70], [-74.0498, 4.7309], [-74.049, 4.76]]] }],
    backdrop: [[[-74.2, 4.6], [-74.0, 4.75]]],
  });

test.describe('the share cards', () => {
  test('an estación is the centre of its map, its pin tip on the spot', () => {
    const svg = station(['B75']);
    // The map is the top 1200×450; the teardrop's path ends at its tip.
    const [tip] = at(svg, /L(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) Z" fill="#D8102D"/g);
    expect(tip.map(Number)).toEqual([600, 225]);
  });

  test('every badge is a pill, and the ones that do not fit are counted, not dropped', () => {
    const codigos = Array.from({ length: 30 }, (_, i) => `B${10 + i}`);
    const svg = station(codigos);
    const pills = at(svg, /<rect [^>]*height="(\d+)" rx="([\d.]+)"/g).filter(([h]) => h === '48');
    expect(pills.length).toBeGreaterThan(5);
    for (const [h, rx] of pills) expect(Number(rx)).toBe(Number(h) / 2);
    const shown = at(svg, />(B\d+)<\/text>/g).length;
    expect(svg).toContain(`>+${codigos.length - shown}</text>`);
  });

  test('a route card puts its código on a pill and its destination beside it', () => {
    const svg = routeCardSvg({
      codigo: 'G47',
      nombre: 'Portal Sur',
      color: '#00A3E0',
      origin: 'Museo Nacional',
      destination: 'Portal Sur',
      stopCount: 12,
      paths: [[[-74.15, 4.59], [-74.08, 4.61]]],
      stops: [[-74.15, 4.59], [-74.08, 4.61]],
      backdrop: [],
    });
    const [[h, rx]] = at(svg, /<rect [^>]*height="(112)" rx="([\d.]+)" fill="#00A3E0"/g);
    expect(Number(rx)).toBe(Number(h) / 2);
    expect(svg).toContain('>G47</text>');
    expect(svg).toContain('>Portal Sur</text>');
    expect(svg).toContain('desde Museo Nacional');
  });
});
