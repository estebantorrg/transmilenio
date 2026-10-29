/**
 * One palette for the app's chips and the prerendered pages (`shared/route_colors.js`,
 * spec §5.4.3). The server kept a hand mirror of the client's rules, "change both
 * together", and it had drifted: a two-letter prefix took its first letter on
 * the station pages and its last in the app, so SE10 was NQS Sur cyan on one
 * and NQS Central brown on the other.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopTagColor } from '../server/src/services/route_colors.ts';
import { compareRouteListItems, getStopTagColor, TRONCAL_COLORS } from '../client/src/utils/routeColors.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a page and the app draw a service in the same colour', () => {
  for (const [code, catalogColor, zonal] of [
    ['SE10', '#123456', true],
    ['TC30', '#123456', true],
    ['F19', '#ABCDEF', false],
    ['7', '#ABCDEF', false], // ruta fácil
    ['7', '#ABCDEF', true], // the SITP service filed under the same número
    ['12-1', null, true], // alimentador
    ['661', '#2A9D8F', true], // no letter: the catalog's colour
  ] as const) {
    expect(stopTagColor(code, catalogColor, zonal), code).toBe(
      getStopTagColor(code, catalogColor, zonal ? 'zonal' : 'troncal')
    );
  }
});

test('a two-letter prefix takes its last letter, as the app always has', () => {
  expect(stopTagColor('SE10', null, true)).toBe(TRONCAL_COLORS.E);
  expect(stopTagColor('TC30', null, true)).toBe(TRONCAL_COLORS.C);
});

test('the server keeps no palette of its own', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server/src/services/route_colors.ts'), 'utf8');
  expect(server).toContain("from '../../../shared/route_colors.js'");
  expect(server).not.toMatch(/#[0-9A-F]{6}/i);
});

test('the sidebar and the app list routes in one order: troncal first, then código', () => {
  const routes = [
    { code: 'B10', type: 'troncal' },
    { code: '1', type: 'zonal' },
    { code: 'B2', type: 'troncal' },
    { code: '12-1', type: 'zonal' },
    { code: 'A60', type: 'troncal' },
    { code: '2', type: 'zonal' },
  ] as const;
  expect([...routes].sort(compareRouteListItems).map((r) => r.code)).toEqual(['A60', 'B2', 'B10', '1', '2', '12-1']);
  for (const file of ['client/src/ui/sidebar.ts', 'client/mobile/src/views/rutas.ts']) {
    expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toContain('compareRouteListItems');
  }
});
