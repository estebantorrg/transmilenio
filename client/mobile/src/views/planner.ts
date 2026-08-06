/** Journey planner sheet — reuses the shared graph router (spec §6.1). */

import { initRouter, findRoutes, resolveWalkingLegs, getRouteServiceSpans, SHORT_SERVICE_DAY_MINUTES, type JourneyPlan, type RouteSearchParams } from '@shared/services/router';
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
import { getRouteAccentColor, CABLE_COLOR } from '@shared/utils/routeColors';
import { api } from '@shared/services/api';
import { POINT_KIND_META, rankPointsByKind, POINT_KINDS, dedupePointsByName } from '@shared/data/pointKinds';
import { isWithinBogota } from '@shared/utils/geo';
import { locationFailureMessage } from '@shared/utils/locationError';
import { h, haptic, toast } from '../lib/dom';
import { formatDistance, needsDarkText } from '../lib/format';
import { allPoints, bus, state, type StationRecord } from '../state';
import { app } from '../appContext';
import { getRecentTrips, pushRecentTrip, type RecentTrip } from '../lib/storage';
import { ICONS } from '../ui/components';
import { getSessionExactLocation, setSessionExactLocation } from '@shared/utils/sessionLocation';
import type { View } from './types';

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

export interface PlannerView extends View {
  /** Fill one endpoint from elsewhere in the app (a place sheet's "Desde aquí"). */
  seedEndpoint: (role: 'origin' | 'destination', ep: Endpoint) => void;
  /**
   * Run the search as if "Buscar ruta" were tapped. Exists for the voice flow
   * (spec §5.9 `viaje`), which arrives with both endpoints already known: the
   * rider said them, and making them tap the button they just spoke past is the
   * kind of friction that stops a voice feature being used twice.
   */
  search: () => void;
}

/**
 * Planear — a tab of its own, not a sheet.
 *
 * The planner was a stacked bottom sheet: it covered the app, it had to be torn
 * down to reach the map (so "Elegir en el mapa" closed it and rebuilt it from
 * scratch, and "Ver en el mapa" threw the itinerary away), and every trip
 * started from two empty fields because nothing survived the close. As a screen
 * it keeps its state for the whole session — endpoints, options, results — so
 * the map round-trip is a tab switch, and it has room for the things a sheet had
 * no space for: recent trips, an options section that stays out of the way, and
 * a persistent search action.
 */
export function createPlannerView(): PlannerView {
  const el = h('section', { class: 'screen screen-planner' });

  let origin: Endpoint | null = null;
  let destination: Endpoint | null = null;
  let mode: RouteSearchParams['mode'] = 'mix';
  let sortBy: NonNullable<RouteSearchParams['sortBy']> = 'transfers';

  const field = (role: 'origin' | 'destination') => {
    const wrap = h('div', { class: 'pl-field' });
    const input = h('input', {
      class: 'pl-input',
      type: 'text',
      // Short on purpose: the field is ~220 px wide next to its two buttons, so
      // a longer placeholder was cut mid-word on a 360 px phone. What the field
      // accepts is spelled out by the hint block instead.
      placeholder: role === 'origin' ? '¿Desde dónde?' : '¿Hasta dónde?',
      'aria-label': role === 'origin' ? 'Origen: estación, paradero o dirección' : 'Destino: estación, paradero o dirección',
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
      // Settling an endpoint retires any in-flight suggestion round: the async
      // geocode used to land *after* the pick and re-open the dropdown over the
      // form, leaving a chosen endpoint buried under stale address rows.
      suggestSeq++;
      dropdown.replaceChildren();
      dropdown.classList.add('hidden');
      syncReady();
    };

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

    // Bumped per keystroke AND on every settled pick, so a slow geocode never
    // appends its rows under a newer query's results — or under no query at all.
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
    // As a screen this is a plain tab round-trip: nothing is torn down, so the
    // other endpoint, the options and any results are exactly where they were.
    pick.addEventListener('click', async () => {
      const label = role === 'origin' ? 'Toca el origen en el mapa' : 'Toca el destino en el mapa';
      const coord = await app().pickPointOnMap(label);
      app().navigate('planner');
      if (!coord) return;
      if (!isWithinBogota(coord[0], coord[1])) {
        toast('Ese punto está fuera de Bogotá', 'warn');
        return;
      }
      set({ coord, name: role === 'origin' ? 'Origen en el mapa' : 'Destino en el mapa' });
    });

    return { wrap, getInput: () => input, set };
  };

  const originField = field('origin');
  const destField = field('destination');

  const swap = h('button', { class: 'pl-swap', type: 'button', 'aria-label': 'Intercambiar origen y destino', html: ICONS.swap });
  swap.addEventListener('click', () => {
    const tmp = origin;
    origin = destination;
    destination = tmp;
    originField.getInput().value = origin?.name ?? '';
    destField.getInput().value = destination?.name ?? '';
    haptic('light');
    syncReady();
  });

  // The trip card: two endpoints joined by a rail (dot — line — dot), the way a
  // journey reads on paper. The sheet stacked them as two unrelated inputs.
  const inputs = h('div', { class: 'pl-card pl-inputs' }, [
    h('span', { class: 'pl-rail', 'aria-hidden': 'true' }),
    originField.wrap,
    swap,
    destField.wrap,
  ]);

  el.append(
    h('div', { class: 'screen-head' }, [
      h('h1', { class: 'screen-title', text: 'Planear viaje' }),
      h('p', { class: 'screen-sub', text: 'De dónde sales, a dónde vas y a qué hora' }),
    ]),
    inputs
  );

  // Options. Their labels double as the collapsed summary, so the rider can see
  // what the search is constrained by without opening the section.
  const MODE_LABELS: Record<string, string> = { mix: 'Mixto', troncal: 'TransMilenio', zonal: 'SITP' };
  const PREF_LABELS: Record<string, string> = {
    transfers: 'Menos transbordos',
    time: 'Más rápido',
    walk: 'Menos caminata',
  };
  const modeChips = chipGroup(
    Object.entries(MODE_LABELS).map(([id, label]) => ({ id, label })),
    'mix',
    (id) => {
      mode = id as RouteSearchParams['mode'];
      syncOptionsSummary();
    }
  );
  const prefChips = chipGroup(
    Object.entries(PREF_LABELS).map(([id, label]) => ({ id, label })),
    'transfers',
    (id) => {
      sortBy = id as typeof sortBy;
      syncOptionsSummary();
    }
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
    (id) => {
      enforceSchedules = id === 'strict';
      syncOptionsSummary();
    }
  );

  /** The collapsed line under "Opciones": what the search is constrained by. */
  function syncOptionsSummary(): void {
    optionsSummary.textContent = [
      MODE_LABELS[mode ?? 'mix'],
      PREF_LABELS[sortBy],
      enforceSchedules ? 'Solo en servicio' : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  // Departure is its own card: it is the one option a rider changes on purpose.
  el.append(
    h('div', { class: 'pl-card pl-depart-card' }, [
      h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Salida' }), departChips.row]),
      departFields,
      departHint,
    ])
  );

  // The other three shape the search rather than describe the trip, and they
  // have sane defaults — so they fold away behind a summary instead of being
  // three chip rows the rider scrolls past on every plan.
  const optionsBody = h('div', { class: 'pl-options', id: 'pl-options' }, [
    h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Horarios' }), schedChips.row]),
    h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Transporte' }), modeChips.row]),
    h('div', { class: 'pl-opt-row' }, [h('span', { class: 'pl-opt-label', text: 'Preferencia' }), prefChips.row]),
  ]);
  optionsBody.classList.add('hidden');
  const optionsSummary = h('span', { class: 'pl-more-summary' });
  const optionsToggle = h('button', {
    class: 'pl-more',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'pl-options',
  }, [h('span', { class: 'pl-more-label', text: 'Opciones' }), optionsSummary, h('span', { class: 'pl-more-chev', text: '›' })]);
  optionsToggle.addEventListener('click', () => {
    const open = optionsBody.classList.toggle('hidden') === false;
    optionsToggle.setAttribute('aria-expanded', String(open));
    optionsToggle.classList.toggle('open', open);
    haptic('light');
  });
  el.append(h('div', { class: 'pl-card pl-options-card' }, [optionsToggle, optionsBody]));

  const calc = h('button', { class: 'btn btn-primary pl-calc', type: 'button', html: `${ICONS.plan}<span>Buscar ruta</span>` });
  // Sticky above the tab bar: on a screen the form can be longer than the
  // viewport, and the action must never be the thing you have to scroll to.
  el.append(h('div', { class: 'pl-actions' }, [calc]));

  const resultsHead = h('div', { class: 'pl-results-head hidden' }, [
    h('span', { class: 'section-title', text: 'Opciones de viaje' }),
  ]);
  const results = h('div', { class: 'pl-results' });
  // Saved trips fill the screen before the first search — the two or three
  // journeys a rider actually repeats, one tap each.
  const tripsSection = h('div', { class: 'pl-trips' });

  /** Re-plan a saved trip end to end. */
  function applyTrip(trip: RecentTrip): void {
    originField.set({ coord: trip.originCoord, code: trip.originCode, name: trip.originName });
    destField.set({ coord: trip.destCoord, code: trip.destCode, name: trip.destName });
    haptic('medium');
    calc.click();
  }

  function renderTrips(): void {
    const trips = getRecentTrips();
    tripsSection.replaceChildren();
    if (results.childElementCount > 0) {
      tripsSection.classList.add('hidden');
      return;
    }
    tripsSection.classList.remove('hidden');
    // Nothing planned yet on this device: say what the three ways to name a
    // point are, since two of them (the map, the GPS) are icons a rider has no
    // reason to try first.
    if (trips.length === 0) {
      tripsSection.append(
        h('div', { class: 'pl-hint' }, [
          h('div', { class: 'pl-hint-title', text: '¿A dónde vas?' }),
          h('div', {
            class: 'pl-hint-text',
            text: 'Escribe una estación, un paradero o una dirección. También puedes usar tu ubicación o tocar el punto directamente en el mapa.',
          }),
          h('div', { class: 'pl-hint-text', text: 'Los viajes que planees quedan guardados aquí para repetirlos con un toque.' }),
        ])
      );
      return;
    }
    tripsSection.append(
      h('div', { class: 'section-head' }, [h('span', { class: 'section-title', html: `${ICONS.clock} Viajes recientes` })])
    );
    for (const trip of trips) {
      const row = h('button', { class: 'pl-trip', type: 'button' }, [
        h('span', { class: 'pl-trip-rail', 'aria-hidden': 'true' }),
        h('div', { class: 'pl-trip-text' }, [
          h('div', { class: 'pl-trip-from', text: trip.originName }),
          h('div', { class: 'pl-trip-to', text: trip.destName }),
        ]),
        h('span', { class: 'pl-trip-go', text: '›' }),
      ]);
      row.addEventListener('click', () => applyTrip(trip));
      tripsSection.append(row);
    }
  }

  el.append(tripsSection, resultsHead, results);

  /** Draw this itinerary on the map. The screen keeps its state, so coming back
   *  is one tab tap — the sheet used to be destroyed at this point. */
  const showOnMap = (plan: JourneyPlan): void => {
    app().showJourneyOnMap(plan, planSummary(plan));
  };

  /** The action reflects whether a search is possible at all. */
  function syncReady(): void {
    const ready = Boolean(origin && destination);
    calc.classList.toggle('pl-calc-ready', ready);
    calc.setAttribute('aria-disabled', String(!ready));
  }

  calc.addEventListener('click', () => {
    if (!origin || !destination) {
      // Name the field that is missing and put the cursor in it — "elige origen
      // y destino" made the rider work out which half they had already done.
      const missing = !origin ? originField : destField;
      toast(!origin ? 'Falta el origen' : 'Falta el destino', 'warn');
      missing.getInput().focus();
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
        // `pool` is the wider candidate set the shown ranking was cut from; the
        // pedestrian pass ranks it on real walking distances and can promote a
        // plan out of it (§5.6.4).
        const pool: { candidates?: JourneyPlan[] } = {};
        const plans = findRoutes(params, pool);
        renderPlans(results, plans, showOnMap, constraints);
        resultsHead.classList.remove('hidden');
        // A trip the rider actually asked for is worth remembering, whatever the
        // search returned — a journey with no connection today may have one at
        // another hour, and re-typing both endpoints is the cost either way.
        pushRecentTrip({
          originName: origin!.name,
          originCoord: origin!.coord,
          originCode: origin!.code,
          destName: destination!.name,
          destCoord: destination!.coord,
          destCode: destination!.code,
        });
        renderTrips();
        // The form can be a screenful; put the answer in view.
        window.requestAnimationFrame(() => resultsHead.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        // Resolve every walk leg against the real pedestrian network, then
        // re-validate, re-rank and re-cut the pool — and re-render if this is
        // still the latest search (spec §1.1 R2 shared fn).
        void resolveWalkingLegs(pool.candidates ?? plans, sortBy, departAt, () => seq === searchSeq)
          .then((resolved) => {
            if (seq === searchSeq) renderPlans(results, resolved, showOnMap, constraints);
          })
          .catch((err) => console.warn('[planner] walk resolution failed:', err));
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

  syncOptionsSummary();
  syncReady();
  renderTrips();
  // Stops and cable stations land after boot, but nothing here caches them: the
  // endpoint suggestions read `allPoints()` live and the graph rebuilds itself
  // on the `stops:ready` / `cable:ready` handlers at the top of this module.

  return {
    el,
    onShow: () => {
      // Cheap when already built; keeps the first search off the critical path.
      if (state.routes.length) ensureRouter();
      renderTrips();
      refreshDepartHint();
    },
    seedEndpoint: (role, ep) => {
      const target = role === 'origin' ? originField : destField;
      target.set(ep);
      target.getInput().value = ep.name;
      // Seeding is an explicit new intent: the previous answer is stale.
      results.replaceChildren();
      resultsHead.classList.add('hidden');
      renderTrips();
    },
    search: () => {
      // Through the button, not around it: `calc`'s handler owns validation, the
      // busy state, the router warm-up and the error path. A second entry point
      // into the search would be a second copy of all of that (spec §1.1 R2).
      if (!calc.disabled) calc.click();
    },
  };
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
      // Some leg's pedestrian route could not be fetched, so its distance is an
      // estimate — said out loud rather than passed off as measured (§5.6.4).
      if (plan.walkEstimated) clock.append(h('span', { class: 'plan-chip', text: 'Caminata estimada' }));
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
