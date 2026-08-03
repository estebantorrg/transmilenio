/** Journey planner sheet — reuses the shared graph router (spec §6.1). */

import { initRouter, findRoutes, sortJourneyPlans, enrichWalkingGeometries, getRouteServiceSpans, SHORT_SERVICE_DAY_MINUTES, type JourneyPlan, type RouteSearchParams } from '@shared/services/router';
import {
  bogotaNow,
  dayOffsetSuffix,
  describeServiceSpans,
  festivoName,
  formatClockMinute,
  formatServiceDuration,
  planTimeAddMinutes,
  planTimeFromInputs,
  planTimeToInputs,
  type PlanTime,
} from '@shared/services/schedule';
import {
  DEPART_STEP_MINUTES,
  departDayLabel,
  departDayOptions,
  departureHint,
  describeDeparture,
  planDayDelta,
} from '@shared/services/departure';
import { getRouteAccentColor, STATION_COLOR, CABLE_COLOR } from '@shared/utils/routeColors';
import { api } from '@shared/services/api';
import { POINT_KIND_META, rankPointsByKind, POINT_KINDS, dedupePointsByName } from '@shared/data/pointKinds';
import { isWithinBogota } from '@shared/utils/geo';
import { locationFailureMessage } from '@shared/utils/locationError';
import { h, haptic, toast } from '../lib/dom';
import { formatDistance, needsDarkText } from '../lib/format';
import { allPoints, bus, state, type StationRecord } from '../state';
import { app } from '../appContext';
import { openSheet } from '../ui/sheet';
import { ICONS } from '../ui/components';
import { getSessionExactLocation, setSessionExactLocation } from '@shared/utils/sessionLocation';

interface Endpoint {
  coord: [number, number];
  code?: string;
  name: string;
}

let routerReady = false;
// Bumped per search so a stale walk-enrichment doesn't overwrite a newer result.
let searchSeq = 0;
// Background enrichment adds zonal-route stops after boot (data.ts loadBackground).
// Invalidate the built graph so the next search rebuilds it with the enriched
// stops — mirrors the website's post-enrichment router rebuild (main.ts).
bus.on('stops:ready', () => {
  routerReady = false;
});
// TransMiCable stations arrive after boot too — rebuild the graph so journeys
// can route over the cable line (spec §6.1; shared router handles the edges).
bus.on('cable:ready', () => {
  routerReady = false;
});
function ensureRouter(): void {
  if (routerReady && state.routes.length) return;
  initRouter(state.routes, state.cableRouterStations);
  routerReady = true;
}

/** Suggestion sub-label when a point has no address, per kind. */
const PL_KIND_FALLBACK: Record<StationRecord['kind'], string> = {
  station: POINT_KIND_META.station.label,
  stop: POINT_KIND_META.stop.label,
  recharge: POINT_KIND_META.recharge.fallback,
  personalizacion: POINT_KIND_META.personalizacion.fallback,
  transmibici: POINT_KIND_META.transmibici.fallback,
  cable: POINT_KIND_META.cable.fallback,
};

/** Kind order when two candidates are equally relevant: a journey endpoint is
 *  most often an estación, then a paradero; the POIs are landmarks people walk
 *  to, so they rank last. */
const PL_KIND_ORDER: StationRecord['kind'][] = ['station', 'cable', 'stop', 'recharge', 'personalizacion', 'transmibici'];

const PL_SUGGESTIONS = 8;

/**
 * Ranked endpoint suggestions from the bundled catalog. The *ranking* is the
 * shared one (`@shared/data/pointKinds`), so the planner, the Buscar tab and
 * the website can never disagree about what a query matches (spec §1.1 R2);
 * only the kind ORDER differs here, because a trip endpoint is usually a
 * station. Same-named paraderos collapse to two rows so one repeated name
 * can't consume the whole list.
 */
function searchPoints(query: string): StationRecord[] {
  const byKind = rankPointsByKind(allPoints(), query, (p) => `${p.code} ${p.direccion}`);
  const out: StationRecord[] = [];
  for (const kind of PL_KIND_ORDER) {
    for (const p of dedupePointsByName(byKind[kind], 2)) {
      out.push(p);
      if (out.length >= PL_SUGGESTIONS) return out;
    }
  }
  return out;
}

/**
 * Address/place suggestions for endpoints the catalog doesn't know — "Calle 100
 * #15-20", "Centro Comercial Andino". The app could only ever plan between
 * catalog points, so a trip to a street address was simply impossible on the
 * client whose riders are standing in the street. Native builds query the same
 * public Photon instance the server uses (spec §5.5.1, §5.2.1b).
 */
async function searchAddresses(query: string): Promise<Endpoint[]> {
  const q = query.trim();
  if (q.length < 4) return [];
  try {
    const res = await api.geocodeAddress(q);
    const candidates: any[] = res?.success && Array.isArray(res.candidates) ? res.candidates : [];
    return candidates
      .filter((c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lon) && isWithinBogota(c.lon, c.lat))
      .slice(0, 4)
      .map((c) => ({ coord: [c.lon, c.lat] as [number, number], name: String(c.name), code: c.code }));
  } catch {
    // Geocoding is an enhancement — the catalog suggestions still answer.
    return [];
  }
}

export function openPlannerSheet(seed?: { origin?: Endpoint; destination?: Endpoint }): void {
  ensureRouter();
  const sheet = openSheet({ title: 'Planear viaje', accent: STATION_COLOR, full: true });

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
    const pick = h('button', { class: 'pl-gps', type: 'button', 'aria-label': 'Elegir en el mapa', html: ICONS.map });
    const dropdown = h('div', { class: 'pl-dropdown hidden' });
    const dot = h('span', { class: `pl-dot ${role}` });
    wrap.append(dot, input, gps, pick, dropdown);

    const set = (ep: Endpoint | null) => {
      if (role === 'origin') origin = ep;
      else destination = ep;
      if (ep) input.value = ep.name;
    };
    if (role === 'origin' && origin) input.value = origin.name;
    if (role === 'destination' && destination) input.value = destination.name;

    const option = (name: string, sub: string, kindCls: string, onPick: () => void): HTMLElement => {
      const item = h('button', { class: 'pl-opt', type: 'button' }, [
        h('span', { class: `pl-opt-dot ${kindCls}` }),
        h('div', {}, [
          h('div', { class: 'pl-opt-name', text: name }),
          h('div', { class: 'pl-opt-sub', text: sub }),
        ]),
      ]);
      item.addEventListener('click', () => {
        onPick();
        dropdown.classList.add('hidden');
      });
      return item;
    };

    // Bumped per keystroke so a slow geocode never appends its rows under a
    // newer query's results.
    let suggestSeq = 0;
    let t: number | undefined;
    input.addEventListener('input', () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const value = input.value;
        const seq = ++suggestSeq;
        const results = searchPoints(value);
        dropdown.replaceChildren();
        for (const p of results) {
          dropdown.append(
            option(p.name, p.direccion || PL_KIND_FALLBACK[p.kind], p.kind, () =>
              set({ coord: p.coordinate, code: p.code, name: p.name })
            )
          );
        }
        dropdown.classList.toggle('hidden', results.length === 0);

        // Addresses/places arrive asynchronously and are appended under the
        // catalog hits — a station named in the query still wins the top slot.
        void searchAddresses(value).then((addresses) => {
          if (seq !== suggestSeq || addresses.length === 0) return;
          dropdown.append(h('div', { class: 'pl-opt-group', text: 'Direcciones y lugares' }));
          for (const a of addresses) {
            dropdown.append(option(a.name, 'Dirección o lugar', 'address', () => set(a)));
          }
          dropdown.classList.remove('hidden');
        });
      }, 140);
    });

    // Tapping away closes the suggestions — an open dropdown used to sit over
    // the options below until something else re-rendered it.
    input.addEventListener('blur', () => window.setTimeout(() => dropdown.classList.add('hidden'), 150));

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
      } catch (err) {
        // Don't dead-end on a denied/failed GPS — name the cause and offer the
        // map instead (shared classifier, spec §1.1 R2).
        toast(`${locationFailureMessage(err)} · elige en el mapa`, 'warn');
      } finally {
        gps.classList.remove('busy');
      }
    });

    // "Elegir en el mapa" — website parity (`map-pick-btn`), and the only way to
    // plan from a point that is neither a catalog place nor where you stand.
    pick.addEventListener('click', async () => {
      const label = role === 'origin' ? 'Toca el origen en el mapa' : 'Toca el destino en el mapa';
      sheet.close(true);
      const coord = await app().pickPointOnMap(label);
      if (!coord) return;
      if (!isWithinBogota(coord[0], coord[1])) {
        toast('Ese punto está fuera de Bogotá', 'warn');
        return;
      }
      const picked: Endpoint = { coord, name: role === 'origin' ? 'Origen en el mapa' : 'Destino en el mapa' };
      // The sheet was closed to expose the map, so reopen it carrying both
      // endpoints — the rider must not lose the one they already filled in.
      openPlannerSheet(
        role === 'origin'
          ? { origin: picked, destination: destination ?? undefined }
          : { origin: origin ?? undefined, destination: picked }
      );
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

  // Departure moment — routes do not all run at all hours (spec §5.6.2), so the
  // planner asks WHEN. "Ahora" needs no input; "Otra hora" opens a day row (Hoy ·
  // Mañana · the rest of the week, festivos flagged because they run a different
  // service) and a clock with ±15 min steps. Setting a departure used to mean
  // typing a full date into a native field on a phone.
  let departMode: 'now' | 'custom' = 'now';
  const dateInput = h('input', { class: 'pl-depart-input hidden', type: 'date', 'aria-label': 'Otra fecha de salida' }) as HTMLInputElement;
  const timeInput = h('input', { class: 'pl-depart-input pl-depart-time', type: 'time', step: '300', 'aria-label': 'Hora de salida' }) as HTMLInputElement;
  const dayRow = h('div', { class: 'chip-row pl-depart-days', role: 'radiogroup', 'aria-label': 'Día de salida' });
  const minus = h('button', { class: 'chip pl-depart-step', type: 'button', text: '−15', 'aria-label': 'Quitar 15 minutos' });
  const plus = h('button', { class: 'chip pl-depart-step', type: 'button', text: '+15', 'aria-label': 'Sumar 15 minutos' });
  const timeRow = h('div', { class: 'pl-depart-time-row' }, [minus, timeInput, plus]);
  const departFields = h('div', { class: 'pl-depart-fields hidden' }, [dayRow, timeRow, dateInput]);
  const departHint = h('div', { class: 'pl-depart-hint' });

  const readDepart = (): PlanTime => {
    if (departMode === 'custom') {
      const parsed = planTimeFromInputs(dateInput.value, timeInput.value);
      if (parsed) return parsed;
    }
    return bogotaNow();
  };

  const refreshDepartHint = () => {
    const plan = readDepart();
    // A moment behind the Bogotá clock is plannable, but it is stated — never
    // answered as if it were the trip the rider meant (spec §1).
    departHint.classList.toggle('warn', departMode === 'custom' && describeDeparture(plan).past);
    departHint.textContent = departureHint(plan, departMode);
  };

  /** Paints the day chips; the picked day (deep-seeded or "Otra fecha") always
   *  has one, even when it falls outside the coming week. */
  const renderDays = (): void => {
    const now = bogotaNow();
    const options = departDayOptions(now);
    if (dateInput.value && !options.some((o) => o.date === dateInput.value)) {
      const picked = planTimeFromInputs(dateInput.value, '00:00');
      if (picked) {
        options.push({
          date: dateInput.value,
          label: departDayLabel(picked, planDayDelta(now, picked)),
          festivo: festivoName(picked.year, picked.month, picked.day),
        });
      }
    }

    dayRow.replaceChildren();
    for (const option of options) {
      const selected = option.date === dateInput.value;
      const chip = h('button', {
        class: `chip${selected ? ' active' : ''}`,
        type: 'button',
        role: 'radio',
        'aria-checked': String(selected),
        text: option.label,
      });
      if (option.festivo) {
        chip.classList.add('festivo');
        chip.title = `Festivo · ${option.festivo}`;
        chip.append(h('span', { class: 'pl-depart-dot', 'aria-hidden': 'true' }));
      }
      chip.addEventListener('click', () => {
        dateInput.value = option.date;
        haptic('light');
        renderDays();
        refreshDepartHint();
      });
      dayRow.append(chip);
    }

    const other = h('button', { class: 'chip pl-depart-other', type: 'button', text: 'Otra fecha…' });
    other.addEventListener('click', () => {
      dateInput.classList.remove('hidden');
      dateInput.focus();
    });
    dayRow.append(other);
  };

  /** Steps the clock, rolling the day when it wraps past midnight. */
  const stepDepart = (minutes: number): void => {
    const next = planTimeAddMinutes(planTimeFromInputs(dateInput.value, timeInput.value) ?? bogotaNow(), minutes);
    const fields = planTimeToInputs(next);
    dateInput.value = fields.date;
    timeInput.value = fields.time;
    haptic('light');
    renderDays();
    refreshDepartHint();
  };

  const departChips = chipGroup(
    [
      { id: 'now', label: 'Ahora' },
      { id: 'custom', label: 'Otra hora' },
    ],
    'now',
    (id) => {
      departMode = id as 'now' | 'custom';
      departFields.classList.toggle('hidden', departMode !== 'custom');
      if (departMode === 'custom') {
        if (!dateInput.value) {
          const seed = planTimeToInputs(bogotaNow());
          dateInput.value = seed.date;
          timeInput.value = seed.time;
        }
        renderDays();
      }
      refreshDepartHint();
    }
  );
  minus.addEventListener('click', () => stepDepart(-DEPART_STEP_MINUTES));
  plus.addEventListener('click', () => stepDepart(DEPART_STEP_MINUTES));
  dateInput.addEventListener('change', () => {
    renderDays();
    refreshDepartHint();
  });
  timeInput.addEventListener('change', refreshDepartHint);
  refreshDepartHint();

  // Schedule filter (§5.6.2). Off by default: horarios always time and rank the
  // itinerary (long-running services win ties), but they only hide connections
  // when the rider asks for "solo en servicio".
  let enforceSchedules = false;
  const schedChips = chipGroup(
    [
      { id: 'all', label: 'Todas' },
      { id: 'strict', label: 'Solo en servicio' },
    ],
    'all',
    (id) => (enforceSchedules = id === 'strict')
  );

  sheet.body.append(
    h('div', { class: 'pl-options' }, [
      h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Salida' }), departChips.row]),
      departFields,
      departHint,
      h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Horarios' }), schedChips.row]),
      h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Transporte' }), modeChips.row]),
      h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Preferencia' }), prefChips.row]),
    ])
  );

  const calc = h('button', { class: 'btn btn-primary pl-calc', type: 'button', html: `${ICONS.plan}<span>Buscar ruta</span>` });
  sheet.body.append(calc);

  const results = h('div', { class: 'pl-results' });
  sheet.body.append(results);

  /** Close the sheet and draw this itinerary on the map. */
  const showOnMap = (plan: JourneyPlan): void => {
    sheet.close();
    app().showJourneyOnMap(plan, planSummary(plan));
  };

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
        // Resolved once so the search, the clock times shown and the async walk
        // re-timing all describe the same trip.
        const departAt = readDepart();
        refreshDepartHint();
        const params: RouteSearchParams = {
          origin: origin!.coord,
          destination: destination!.coord,
          originStopCode: origin!.code,
          destStopCode: destination!.code,
          mode,
          minWalk: sortBy === 'walk',
          sortBy,
          departAt,
          enforceSchedules,
        };
        // Snapshot of what constrained THIS search, so an empty result can name
        // the constraint and offer to lift it.
        const constraints: SearchConstraints = {
          mode,
          enforceSchedules,
          relax: (which) => {
            if (which === 'mix') modeChips.select('mix');
            else schedChips.select('all');
            calc.click();
          },
        };
        const seq = ++searchSeq;
        const plans = findRoutes(params);
        sortJourneyPlans(plans, sortBy);
        renderPlans(results, plans.slice(0, 4), showOnMap, constraints);
        // Refine walk legs with real OSRM geometry/distance/time, then re-rank +
        // re-render if this is still the latest search (spec §1.1 R2 shared fn).
        void enrichWalkingGeometries(plans, sortBy, departAt)
          .then(() => {
            if (seq === searchSeq) renderPlans(results, plans.slice(0, 4), showOnMap, constraints);
          })
          .catch((err) => console.warn('[planner] walk enrichment failed:', err));
      } catch (err) {
        console.error('[planner]', err);
        // A bare "Error al calcular" left the rider with no idea whether to wait,
        // retry or change something.
        const retry = h('button', { class: 'btn btn-ghost empty-action', type: 'button', text: 'Intentar de nuevo' });
        retry.addEventListener('click', () => calc.click());
        results.replaceChildren(
          h('div', { class: 'empty' }, [
            h('div', { class: 'empty-title', text: 'No se pudo calcular la ruta' }),
            h('div', { class: 'empty-text', text: err instanceof Error ? err.message : 'Error inesperado del planificador.' }),
            retry,
          ])
        );
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

/** A chip group plus a handle to move it from code — an empty state that offers
 *  "search the whole network" has to be able to flip the chip it is undoing. */
interface ChipGroup {
  row: HTMLElement;
  select(id: string): void;
}

function chipGroup(items: { id: string; label: string }[], initial: string, onPick: (id: string) => void): ChipGroup {
  const row = h('div', { class: 'chip-row pl-chips' });
  const els = new Map<string, HTMLElement>();
  let active = initial;
  const pick = (id: string): void => {
    active = id;
    els.forEach((c, key) => c.classList.toggle('active', key === active));
    onPick(id);
  };
  for (const it of items) {
    const chip = h('button', { class: `chip${it.id === initial ? ' active' : ''}`, type: 'button', text: it.label });
    chip.addEventListener('click', () => pick(it.id));
    els.set(it.id, chip);
    row.append(chip);
  }
  return {
    row,
    select: (id) => {
      if (els.has(id)) pick(id);
    },
  };
}

/** One-line summary of a plan, used on the map banner. */
function planSummary(plan: JourneyPlan): string {
  const legs = plan.steps
    .filter((s) => s.type === 'ride')
    .map((s) => s.routeCode || '·')
    .join(' → ');
  const head = `${plan.totalTime} min · ${plan.transfers} transb.`;
  return legs ? `${head} · ${legs}` : head;
}

/** What the empty result was constrained by, so the state can name it and undo it. */
interface SearchConstraints {
  mode: RouteSearchParams['mode'];
  enforceSchedules: boolean;
  /** Lifts the named constraint and re-runs the search. */
  relax: (which: 'mix' | 'schedules') => void;
}

function renderPlans(
  host: HTMLElement,
  plans: JourneyPlan[],
  onShowOnMap: (plan: JourneyPlan) => void,
  constraints?: SearchConstraints
): void {
  host.replaceChildren();
  if (plans.length === 0) {
    // A search comes back empty for one of three reasons, and each has a
    // different move: a mode filter halved the network, the schedule filter
    // deleted the connections, or an endpoint has no stop within the router's
    // 1.5 km access radius. "Prueba con otro modo" covered one of the three.
    const limitedMode = constraints && constraints.mode !== 'mix';
    const block = h('div', { class: 'empty' }, [
      h('div', { class: 'empty-title', text: 'Sin rutas' }),
      h('div', {
        class: 'empty-text',
        text: limitedMode
          ? `La búsqueda está limitada a ${constraints!.mode === 'troncal' ? 'TransMilenio' : 'SITP zonal'} y no hay una conexión completa con ese modo.`
          : constraints?.enforceSchedules
          ? 'Con “Solo en servicio” se descartan las rutas que no operan a esa hora, y no queda ninguna conexión.'
          : 'Ninguno de los dos extremos tiene estación o paradero a menos de 1,5 km, o no existe conexión con menos de 3 transbordos.',
      }),
    ]);
    if (constraints && (limitedMode || constraints.enforceSchedules)) {
      const which = limitedMode ? 'mix' : 'schedules';
      const btn = h('button', {
        class: 'btn btn-ghost empty-action',
        type: 'button',
        text: limitedMode ? 'Buscar en toda la red' : 'Incluir rutas fuera de servicio',
      });
      btn.addEventListener('click', () => constraints.relax(which));
      block.append(btn);
    } else if (!constraints?.enforceSchedules) {
      block.append(
        h('div', { class: 'empty-text', text: 'Mueve el origen o el destino hacia una vía principal, o elige la estación más cercana.' })
      );
    }
    host.append(block);
    return;
  }

  // Nothing running at that hour: the itineraries are still shown, labelled,
  // with each service's own window (spec §4.2 — never a dead end). Only when
  // EVERY bus option is closed — one closed option among working ones is a
  // per-card matter, not a headline.
  const withRides = plans.filter((plan) => plan.steps.some((step) => step.type === 'ride'));
  if (withRides.length > 0 && withRides.every((plan) => plan.outsideService)) {
    host.append(
      h('div', { class: 'pl-notice' }, [
        h('div', { class: 'pl-notice-title', text: 'Ninguna ruta opera a esa hora' }),
        h('div', { class: 'pl-notice-text', text: 'Estas son las conexiones que existen, con el horario de cada servicio.' }),
      ])
    );
  }

  plans.forEach((plan, idx) => {
    const card = h('div', { class: `plan-card${plan.outsideService ? ' out-of-service' : ''}` });
    card.append(
      h('div', { class: 'plan-head' }, [
        h('div', { class: 'plan-time' }, [h('b', { text: `${plan.totalTime}` }), h('span', { text: ' min' })]),
        h('div', { class: 'plan-meta', text: `${plan.transfers} transb. · ${formatDistance(plan.walkDistance)} a pie` }),
        idx === 0 ? h('span', { class: 'plan-best', text: 'Mejor' }) : h('span'),
      ])
    );

    if (plan.departMinute !== undefined && plan.arriveMinute !== undefined) {
      const clock = h('div', { class: 'plan-clock' }, [
        h('span', {
          class: 'plan-clock-range',
          text: `${formatClockMinute(plan.departMinute)} → ${formatClockMinute(plan.arriveMinute)}${dayOffsetSuffix(plan.arriveMinute)}`,
        }),
      ]);
      if (plan.outsideService) clock.append(h('span', { class: 'plan-chip danger', text: 'Fuera de servicio' }));
      else if (plan.serviceWait) clock.append(h('span', { class: 'plan-chip warn', text: `Espera ${plan.serviceWait} min` }));
      if (!plan.outsideService && plan.lastServiceRisk) clock.append(h('span', { class: 'plan-chip warn', text: 'Último servicio' }));
      // Why a slightly slower itinerary can outrank this one (§5.6.2).
      if (!plan.outsideService && plan.shortService) clock.append(h('span', { class: 'plan-chip', text: 'Servicio limitado' }));
      card.append(clock);
    }
    const legs = h('div', { class: 'plan-legs' });
    for (const step of plan.steps) {
      if (step.type === 'walk') {
        legs.append(h('span', { class: 'leg leg-walk', html: `🚶 ${formatDistance(step.distance)}` }));
      } else {
        const color =
          step.routeType === 'cable'
            ? CABLE_COLOR
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
      const clockMinute = step.type === 'ride' ? step.boardMinute : step.startMinute;
      const clock = clockMinute === undefined ? '' : `${formatClockMinute(clockMinute)} · `;
      const line =
        step.type === 'walk'
          ? `${clock}Camina ${formatDistance(step.distance)} hasta ${step.toName}`
          : `${clock}Toma ${step.routeCode} hasta ${step.toName}${step.stopCount ? ` · ${step.stopCount} paradas` : ''}`;
      detail.append(h('div', { class: 'plan-step', text: line }));

      if (step.type !== 'ride') continue;
      if (step.outsideService) {
        const spans = getRouteServiceSpans(step.routeId);
        const windows = spans ? describeServiceSpans(spans).map((row) => `${row.days} ${row.hours}`).join(' · ') : '';
        detail.append(h('div', { class: 'plan-service danger', text: `No opera a esta hora${windows ? ` · ${windows}` : ''}` }));
      } else {
        const parts: string[] = [];
        if (step.serviceWait && step.startMinute !== undefined) {
          parts.push(`Inicio de servicio ${formatClockMinute(step.startMinute + step.serviceWait)}`);
        }
        if (step.serviceEndMinute !== undefined) {
          parts.push(`Último servicio ${formatClockMinute(step.serviceEndMinute)}${dayOffsetSuffix(step.serviceEndMinute)}`);
        }
        // Shown only when short — the reason this ride costs ranking points.
        if (step.serviceDayMinutes !== undefined && step.serviceDayMinutes <= SHORT_SERVICE_DAY_MINUTES) {
          parts.push(`Opera ${formatServiceDuration(step.serviceDayMinutes)} ese día`);
        }
        if (parts.length > 0) detail.append(h('div', { class: 'plan-service', text: parts.join(' · ') }));
      }
    }
    card.append(detail);

    // The itinerary was text-only: you could read "Toma la K23 hasta Calle 100"
    // but never see where that is, on a client built around a map. Draws the
    // plan with the website's own journey renderer (per-leg colours, dashed
    // walk legs, boarding/alighting markers).
    const mapBtn = h('button', { class: 'btn btn-ghost plan-map-btn', type: 'button', html: `${ICONS.map}<span>Ver en el mapa</span>` });
    mapBtn.addEventListener('click', () => {
      haptic('medium');
      onShowOnMap(plan);
    });
    card.append(mapBtn);
    host.append(card);
  });
}
