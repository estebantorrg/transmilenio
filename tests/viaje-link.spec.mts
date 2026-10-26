import { test, expect } from '@playwright/test';
import { cercaDe, planIndexForVia, redondear, viaKey, viajeParams, viajePreview, viajeUrl } from '../shared/viaje_link.js';

/**
 * A planned trip as a link (`shared/viaje_link.js`, spec §5.6.7): the same
 * `#/plan?…` the website planner has always written, now naming the chosen
 * option and never carrying the sharer's exact position.
 */

const ride = (routeCode: string, fromName: string, toName: string) => ({ type: 'ride', routeCode, fromName, toName });
const walk = { type: 'walk', fromName: 'a', toName: 'b' };
const b23g47 = { steps: [walk, ride('B23', 'Calle 100', 'Av. Jiménez'), walk, ride('G47', 'Av. Jiménez', 'Portal Sur'), walk] };
const h15 = { steps: [walk, ride('H15', 'Calle 100', 'Portal Tunal')] };

test.describe('a trip as a link', () => {
  test('the chosen option is the códigos it rides, in order', () => {
    expect(viaKey(b23g47)).toBe('B23.G47');
    expect(viaKey({ steps: [walk] })).toBe('');
    expect(viaKey(null)).toBe('');
  });

  test('it is found again by its códigos, wherever the list put it', () => {
    // Re-ranked: the walking pass and the live refresh reorder the list.
    expect(planIndexForVia([h15, b23g47], 'b23.g47')).toBe(1);
    expect(planIndexForVia([b23g47, h15], 'B23.G47')).toBe(0);
    expect(planIndexForVia([h15], 'B23.G47')).toBe(-1);
    expect(planIndexForVia([h15], null)).toBe(-1);
  });

  test('the parameters the planner always wrote, in its order, defaults left out, the option last', () => {
    const qs = viajeParams({
      origin: { coord: [-74.057666, 4.684501], label: 'Calle 100', code: 'TM0018' },
      destination: { coord: [-74.139575, 4.570912], label: 'Portal Tunal', code: 'TM0119' },
      mode: 'mix',
      sortBy: 'transfers',
      depart: null,
      enforceSchedules: true,
      plan: b23g47,
    });
    expect(qs).toBe('o=4.684501%2C-74.057666&ol=Calle+100&oc=TM0018&d=4.570912%2C-74.139575&dl=Portal+Tunal&dc=TM0119&v=B23.G47');
    const set = new URLSearchParams(viajeParams({ origin: { coord: [-74.05, 4.6] }, mode: 'troncal', sortBy: 'time', depart: '2026-10-27T07:30', enforceSchedules: false }));
    expect([set.get('m'), set.get('p'), set.get('t'), set.get('s'), set.get('v')]).toEqual(['troncal', 'time', '2026-10-27T07:30', '0', null]);
  });

  test("the sharer's own position travels rounded, named after the nearest stop, without a code", () => {
    const sp = new URLSearchParams(
      viajeParams({
        origin: { coord: [-74.057891, 4.684123], label: 'Mi ubicación actual', gps: true },
        destination: { coord: [-74.1201, 4.5915], label: 'Mi ubicación actual', code: 'X', gps: true },
        plan: b23g47,
      })
    );
    expect(sp.get('o')).toBe('4.684000,-74.058000');
    expect(sp.get('ol')).toBe('Cerca de Calle 100');
    expect(sp.get('dl')).toBe('Cerca de Portal Sur');
    expect(sp.get('dc')).toBeNull();
    expect(redondear([-74.0574, 4.6845])).toEqual([-74.057, 4.685]);
    expect(cercaDe(null, 'o')).toBe('Punto cercano');
  });

  test('a stop or an address the sharer chose travels exactly as chosen', () => {
    const sp = new URLSearchParams(viajeParams({ origin: { coord: [-74.057891, 4.684123], label: 'Cra 15 # 100-20', gps: false } }));
    expect(sp.get('o')).toBe('4.684123,-74.057891');
    expect(sp.get('ol')).toBe('Cra 15 # 100-20');
  });

  test('the whole link opens on the website, at an address the server can preview', () => {
    expect(viajeUrl({ origin: { coord: [-74.05, 4.6] }, plan: h15 })).toBe('https://mitrasto.app/viaje?o=4.600000%2C-74.050000&v=H15');
  });
});

test.describe('what a preview of the link says', () => {
  test('where to, from where, on what, and when — from the link alone', () => {
    const p = viajePreview('o=1%2C2&ol=Calle+100&d=3%2C4&dl=Portal+Tunal&v=D10.H13&t=2026-10-27T07:05');
    expect(p.title).toBe('Cómo llegar a Portal Tunal');
    expect(p.description).toBe('Desde Calle 100 · En D10 › H13 · Salida el 27/10 a las 07:05. El viaje en MiTrasto: rutas, horarios y buses en vivo.');
  });

  test('a bare or odd link still reads as a sentence', () => {
    expect(viajePreview('')).toEqual({
      title: 'Cómo llegar en TransMilenio y SITP',
      description: 'El viaje en MiTrasto: rutas, horarios y buses en vivo.',
    });
    // A label is whatever the link says: one line, cut short. Escaping is the page's job.
    expect(viajePreview(`dl=${'x'.repeat(300)}`).title).toHaveLength('Cómo llegar a '.length + 80);
    expect(viajePreview('t=mañana').description).not.toContain('Salida');
  });
});
