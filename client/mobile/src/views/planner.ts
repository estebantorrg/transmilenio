/** Journey planner sheet — reuses the shared graph router (spec §6.1). */

import { initRouter, findRoutes, sortJourneyPlans, type JourneyPlan, type RouteSearchParams } from '@shared/services/router';
import { getRouteAccentColor } from '@shared/utils/routeColors';
import { h, haptic, toast } from '../lib/dom';
import { formatDistance, needsDarkText } from '../lib/format';
import { allPoints, state, type StationRecord } from '../state';
import { openSheet } from '../ui/sheet';
import { ICONS } from '../ui/components';
import { getSessionExactLocation, setSessionExactLocation } from '@shared/utils/sessionLocation';

interface Endpoint {
  coord: [number, number];
  code?: string;
  name: string;
}

let routerReady = false;
function ensureRouter(): void {
  if (routerReady && state.routes.length) return;
  initRouter(state.routes, []);
  routerReady = true;
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function searchPoints(query: string): StationRecord[] {
  const q = norm(query.trim());
  if (q.length < 2) return [];
  const out: StationRecord[] = [];
  for (const p of allPoints()) {
    if (norm(p.name).includes(q) || norm(p.direccion).includes(q)) {
      out.push(p);
      if (out.length >= 8) break;
    }
  }
  return out;
}

export function openPlannerSheet(seed?: { origin?: Endpoint; destination?: Endpoint }): void {
  ensureRouter();
  const sheet = openSheet({ title: 'Planear viaje', accent: '#e3342f', full: true });

  let origin: Endpoint | null = seed?.origin ?? null;
  let destination: Endpoint | null = seed?.destination ?? null;
  let mode: RouteSearchParams['mode'] = 'mix';
  let sortBy: NonNullable<RouteSearchParams['sortBy']> = 'transfers';

  const field = (role: 'origin' | 'destination') => {
    const wrap = h('div', { class: 'pl-field' });
    const input = h('input', {
      class: 'pl-input',
      type: 'text',
      placeholder: role === 'origin' ? 'Origen — estación o dirección' : 'Destino — estación o dirección',
      autocomplete: 'off',
    }) as HTMLInputElement;
    const gps = h('button', { class: 'pl-gps', type: 'button', 'aria-label': 'Mi ubicación', html: ICONS.locate });
    const dropdown = h('div', { class: 'pl-dropdown hidden' });
    const dot = h('span', { class: `pl-dot ${role}` });
    wrap.append(dot, input, gps, dropdown);

    const set = (ep: Endpoint | null) => {
      if (role === 'origin') origin = ep;
      else destination = ep;
      if (ep) input.value = ep.name;
    };
    if (role === 'origin' && origin) input.value = origin.name;
    if (role === 'destination' && destination) input.value = destination.name;

    let t: number | undefined;
    input.addEventListener('input', () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const results = searchPoints(input.value);
        dropdown.replaceChildren();
        if (results.length === 0) {
          dropdown.classList.add('hidden');
          return;
        }
        for (const p of results) {
          const item = h('button', { class: 'pl-opt', type: 'button' }, [
            h('span', { class: `pl-opt-dot ${p.kind}` }),
            h('div', {}, [
              h('div', { class: 'pl-opt-name', text: p.name }),
              h('div', { class: 'pl-opt-sub', text: p.direccion || (p.kind === 'station' ? 'Estación' : 'Paradero') }),
            ]),
          ]);
          item.addEventListener('click', () => {
            set({ coord: p.coordinate, code: p.code, name: p.name });
            dropdown.classList.add('hidden');
          });
          dropdown.append(item);
        }
        dropdown.classList.remove('hidden');
      }, 110);
    });

    gps.addEventListener('click', async () => {
      gps.classList.add('busy');
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) => {
          if (!('geolocation' in navigator)) {
            const cached = getSessionExactLocation();
            if (cached) return res({ coords: { longitude: cached.lng, latitude: cached.lat } } as GeolocationPosition);
            return rej(new Error('sin geolocalización'));
          }
          navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 12000 });
        });
        const coord: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        setSessionExactLocation(coord[0], coord[1], 'gps');
        set({ coord, name: 'Mi ubicación' });
        toast('Ubicación fijada', 'ok');
      } catch {
        toast('No se pudo obtener tu ubicación', 'warn');
      } finally {
        gps.classList.remove('busy');
      }
    });

    return { wrap, getInput: () => input };
  };

  const originField = field('origin');
  const destField = field('destination');

  const swap = h('button', { class: 'pl-swap', type: 'button', 'aria-label': 'Intercambiar', html: ICONS.swap });
  swap.addEventListener('click', () => {
    const tmp = origin;
    origin = destination;
    destination = tmp;
    originField.getInput().value = origin?.name ?? '';
    destField.getInput().value = destination?.name ?? '';
    haptic('light');
  });

  const inputs = h('div', { class: 'pl-inputs' }, [originField.wrap, swap, destField.wrap]);
  sheet.body.append(inputs);

  // Options.
  const modeChips = chipGroup(
    [
      { id: 'mix', label: 'Mixto' },
      { id: 'troncal', label: 'TransMilenio' },
      { id: 'zonal', label: 'SITP' },
    ],
    'mix',
    (id) => (mode = id as RouteSearchParams['mode'])
  );
  const prefChips = chipGroup(
    [
      { id: 'transfers', label: 'Menos transbordos' },
      { id: 'time', label: 'Más rápido' },
      { id: 'walk', label: 'Menos caminata' },
    ],
    'transfers',
    (id) => (sortBy = id as typeof sortBy)
  );
  sheet.body.append(
    h('div', { class: 'pl-options' }, [
      h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Transporte' }), modeChips]),
      h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Preferencia' }), prefChips]),
    ])
  );

  const calc = h('button', { class: 'btn btn-primary pl-calc', type: 'button', html: `${ICONS.plan}<span>Buscar ruta</span>` });
  sheet.body.append(calc);

  const results = h('div', { class: 'pl-results' });
  sheet.body.append(results);

  calc.addEventListener('click', () => {
    if (!origin || !destination) {
      toast('Elige origen y destino', 'warn');
      return;
    }
    haptic('medium');
    calc.classList.add('busy');
    results.replaceChildren(h('div', { class: 'card-loading', html: `${ICONS.refresh}<span>Calculando…</span>` }));
    // Defer so the spinner paints before the (sync) graph search runs.
    window.setTimeout(() => {
      try {
        ensureRouter();
        const params: RouteSearchParams = {
          origin: origin!.coord,
          destination: destination!.coord,
          originStopCode: origin!.code,
          destStopCode: destination!.code,
          mode,
          minWalk: sortBy === 'walk',
          sortBy,
        };
        const plans = findRoutes(params);
        sortJourneyPlans(plans, sortBy);
        renderPlans(results, plans.slice(0, 4));
      } catch (err) {
        console.error('[planner]', err);
        results.replaceChildren(h('div', { class: 'empty' }, [h('div', { class: 'empty-title', text: 'Error al calcular' })]));
      } finally {
        calc.classList.remove('busy');
      }
    }, 30);
  });

  if (seed?.origin || seed?.destination) {
    originField.getInput().value = origin?.name ?? '';
    destField.getInput().value = destination?.name ?? '';
  }
}

function chipGroup(items: { id: string; label: string }[], initial: string, onPick: (id: string) => void): HTMLElement {
  const row = h('div', { class: 'chip-row pl-chips' });
  const els = new Map<string, HTMLElement>();
  let active = initial;
  for (const it of items) {
    const chip = h('button', { class: `chip${it.id === initial ? ' active' : ''}`, type: 'button', text: it.label });
    chip.addEventListener('click', () => {
      active = it.id;
      els.forEach((c, id) => c.classList.toggle('active', id === active));
      onPick(it.id);
    });
    els.set(it.id, chip);
    row.append(chip);
  }
  return row;
}

function renderPlans(host: HTMLElement, plans: JourneyPlan[]): void {
  host.replaceChildren();
  if (plans.length === 0) {
    host.append(
      h('div', { class: 'empty' }, [
        h('div', { class: 'empty-title', text: 'Sin rutas' }),
        h('div', { class: 'empty-text', text: 'No encontramos una conexión. Prueba con otro modo o puntos más cercanos a una estación.' }),
      ])
    );
    return;
  }
  plans.forEach((plan, idx) => {
    const card = h('div', { class: 'plan-card' });
    card.append(
      h('div', { class: 'plan-head' }, [
        h('div', { class: 'plan-time' }, [h('b', { text: `${plan.totalTime}` }), h('span', { text: ' min' })]),
        h('div', { class: 'plan-meta', text: `${plan.transfers} transb. · ${formatDistance(plan.walkDistance)} a pie` }),
        idx === 0 ? h('span', { class: 'plan-best', text: 'Mejor' }) : h('span'),
      ])
    );
    const legs = h('div', { class: 'plan-legs' });
    for (const step of plan.steps) {
      if (step.type === 'walk') {
        legs.append(h('span', { class: 'leg leg-walk', html: `🚶 ${formatDistance(step.distance)}` }));
      } else {
        const color =
          step.routeType === 'cable'
            ? '#00a7c4'
            : getRouteAccentColor({ code: step.routeCode || '', type: (step.routeType as 'troncal' | 'zonal') || 'zonal' } as any);
        const leg = h('span', { class: 'leg leg-ride', text: step.routeCode || '·' });
        leg.style.background = color;
        leg.style.color = needsDarkText(color) ? '#0a0e17' : '#fff';
        legs.append(leg);
      }
      legs.append(h('span', { class: 'leg-arrow', text: '›' }));
    }
    legs.lastElementChild?.remove();
    card.append(legs);

    // Step detail list.
    const detail = h('div', { class: 'plan-detail' });
    for (const step of plan.steps) {
      const line =
        step.type === 'walk'
          ? `Camina ${formatDistance(step.distance)} hasta ${step.toName}`
          : `Toma ${step.routeCode} hasta ${step.toName}${step.stopCount ? ` · ${step.stopCount} paradas` : ''}`;
      detail.append(h('div', { class: 'plan-step', text: line }));
    }
    card.append(detail);
    host.append(card);
  });
}
