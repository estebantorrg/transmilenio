/**
 * What survives a catalog sync (spec §5.1.3).
 *
 * The upstream listing drifts from run to run, so a sync merges into the
 * previous catalog instead of replacing it. These pin the rules that decide
 * what is kept — the one place where a wrong answer silently deletes a real
 * service, or keeps a retired one on a platform for weeks.
 *
 * The códigos are made up (`QQ…`) so nothing filed in
 * `recorrido_corrections.json` or a station plano can reach into the fixture.
 */
import { test, expect } from '@playwright/test';
import {
  ROUTE_RETENTION_DAYS,
  dropRenamedInPlace,
  expireUnseenVariants,
  isDuplicateRoute,
  mergeCatalogs,
  pruneUnservedStationRoutes,
  variantKey,
} from '../server/src/services/catalog_merge.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 9);
const TRACE = [[-74.1, 4.6], [-74.09, 4.61]];

const stop = (codigo: string) => ({ nombre: codigo, codigo, coordenada: '4.6,-74.1', posicion: 0 });
const variant = (codigo: string, id: string, nombre: string, extra: object = {}): any => ({
  id, codigo, nombre, color: '#000', sistema: 'TransMilenio', tipoServicio: 'TRONCAL', stops: [stop('S1')], ...extra,
});
const tag = (codigo: string, id: string, nombre: string): any => ({ id, codigo, nombre, color: '#000' });
const station = (codigo: string, wagons: object): any => ({
  id: codigo, codigo, nombre: codigo, direccion: '', coordenada: '4.6,-74.1', wagons,
});

/** The catalog before the sync, and what the sync fetched. */
function fixture() {
  const previous: any = {
    stations: {
      S1: station('S1', { A: [tag('QQ1', '1', 'Calle 116'), tag('QQ2', '2', 'Portal'), tag('QQ4', '4', 'Museo')] }),
      S9: station('S9', { A: [tag('QQ9', '9', 'Domingo')] }),
    },
    routes: {
      QQ1: [variant('QQ1', '1', 'Calle 116', { seenAt: NOW - DAY })],
      QQ2: [variant('QQ2', '2', 'Portal', { seenAt: NOW - DAY })],
      QQ4: [variant('QQ4', '4', 'Museo', { trazado: TRACE, seenAt: NOW - DAY })],
      QQ9: [variant('QQ9', '9', 'Domingo', { stops: [stop('S9')], seenAt: NOW - 6 * DAY })],
    },
  };
  const fresh: any = {
    stations: {
      S1: station('S1', { A: [tag('QQ1', '1', 'Calle 107A'), tag('QQ3', '2', 'Portal'), tag('QQ4', '4', 'Museo')] }),
    },
    routes: {
      // Same id, same código, new name: renamed in place.
      QQ1: [variant('QQ1', '1', 'Calle 107A', { seenAt: NOW })],
      // Same id under a new código: QQ2 became QQ3.
      QQ3: [variant('QQ3', '2', 'Portal', { seenAt: NOW })],
      // Upstream answered with no geometry this run.
      QQ4: [variant('QQ4', '4', 'Museo', { seenAt: NOW })],
    },
  };
  return { previous, fresh };
}

test.describe('merging a sync over the previous catalog', () => {
  test('a route the listing missed is kept, with its station', () => {
    const { previous, fresh } = fixture();
    const merged = mergeCatalogs(previous, fresh);
    // Ciclovía services are only listed on Sundays and festivos: absence from
    // one run is not a retirement.
    expect(merged.routes.QQ9.map((v) => v.nombre)).toEqual(['Domingo']);
    expect(merged.stations.S9.wagons.A.map((r) => r.codigo)).toEqual(['QQ9']);
  });

  test('a route and its Ciclovía detour are two variants, and neither replaces the other', () => {
    // K86 kept only `Portal ElDorado Ciclovía` (D-F) after a sync, so on a
    // weekday there was no K86 to Portal El Dorado: the Sunday run and the
    // weekday run shared one key.
    const previous: any = { stations: {}, routes: { QQ5: [variant('QQ5', '5', 'Portal ElDorado', { seenAt: NOW - DAY })] } };
    const fresh: any = { stations: {}, routes: { QQ5: [variant('QQ5', '6', 'Portal ElDorado Ciclovía', { seenAt: NOW })] } };
    const merged = mergeCatalogs(previous, fresh);
    expect(merged.routes.QQ5.map((v) => v.id).sort()).toEqual(['5', '6']);
    expect(variantKey('Portal ElDorado Ciclovía')).not.toBe(variantKey('Portal ElDorado'));
    // A station still lists the service once, whichever run filed it.
    expect(isDuplicateRoute(tag('QQ5', '5', 'Portal ElDorado'), tag('QQ5', '6', 'Portal ElDorado Ciclovía'))).toBe(true);
  });

  test('an id that now answers to another código takes the old one with it', () => {
    const { previous, fresh } = fixture();
    const merged = mergeCatalogs(previous, fresh);
    expect(merged.routes.QQ2).toBeUndefined();
    expect(merged.routes.QQ3.map((v) => v.id)).toEqual(['2']);
    expect(merged.stations.S1.wagons.A.map((r) => r.codigo)).not.toContain('QQ2');
  });

  test('a route renamed in place does not leave its old name behind as a second service', () => {
    const { previous, fresh } = fixture();
    const merged = mergeCatalogs(previous, fresh);
    expect(merged.routes.QQ1.map((v) => v.nombre)).toEqual(['Calle 107A']);
    // The old name's platform tag survives the merge and is reaped by the prune,
    // which finds no recorrido left to vouch for it.
    pruneUnservedStationRoutes(merged);
    expect(merged.stations.S1.wagons.A.map((r) => `${r.codigo} ${r.nombre}`)).toEqual([
      'QQ1 Calle 107A',
      'QQ3 Portal',
      'QQ4 Museo',
    ]);
  });

  test('a missing trazado falls back to the previous one — fresh wins on everything else', () => {
    const { previous, fresh } = fixture();
    const merged = mergeCatalogs(previous, fresh);
    expect(merged.routes.QQ4[0].trazado).toEqual(TRACE);
    expect(merged.routes.QQ4[0].seenAt).toBe(NOW);
  });
});

test.describe('pruning platform tags', () => {
  test('a tag is kept only where its own recorrido calls', () => {
    const catalog: any = {
      stations: { S1: station('S1', { A: [tag('QQ1', '1', 'Norte'), tag('QQ5', '5', 'Sur')], B: [tag('QQ5', '5', 'Sur')] }) },
      routes: {
        QQ1: [variant('QQ1', '1', 'Norte')],
        QQ5: [variant('QQ5', '5', 'Sur', { stops: [stop('S2')] })], // rerouted away from S1
      },
    };
    expect(pruneUnservedStationRoutes(catalog)).toBe(2);
    expect(catalog.stations.S1.wagons).toEqual({ A: [tag('QQ1', '1', 'Norte')] });
  });
});

test.describe('the retention clock', () => {
  const retained = (seenAt?: number): any => ({
    stations: {},
    routes: { QQ7: [variant('QQ7', '7', 'Retenida', seenAt === undefined ? {} : { seenAt })] },
  });

  test('a variant unseen for the whole window is dropped, and not a day sooner', () => {
    const inside = retained(NOW - ROUTE_RETENTION_DAYS * DAY);
    expect(expireUnseenVariants(inside, NOW)).toBe(0);
    expect(inside.routes.QQ7).toHaveLength(1);

    const outside = retained(NOW - ROUTE_RETENTION_DAYS * DAY - 1);
    expect(expireUnseenVariants(outside, NOW)).toBe(1);
    expect(outside.routes.QQ7).toBeUndefined();
  });

  test('an unstamped variant is stamped, not judged', () => {
    // The first sync after the clock shipped must start it, not empty the catalog.
    const catalog = retained();
    expect(expireUnseenVariants(catalog, NOW)).toBe(0);
    expect(catalog.routes.QQ7[0].seenAt).toBe(NOW);
  });
});

test.describe('one id is one variant', () => {
  test('two entries under one código and id collapse to the newest name', () => {
    const catalog: any = {
      stations: {},
      routes: {
        QQ8: [
          variant('QQ8', '8', 'Nombre viejo', { seenAt: NOW - 3 * DAY }),
          variant('QQ8', '8', 'Nombre nuevo', { seenAt: NOW }),
          variant('QQ8', '80', 'Otro sentido', { seenAt: NOW - 3 * DAY }),
        ],
      },
    };
    expect(dropRenamedInPlace(catalog)).toBe(1);
    expect(catalog.routes.QQ8.map((v: any) => v.nombre)).toEqual(['Nombre nuevo', 'Otro sentido']);
  });
});
