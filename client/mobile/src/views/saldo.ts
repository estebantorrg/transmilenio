/** Saldo tab — tullave card balance reader (server ledger, spec §5.5.1a). */

import { api, type CardBalanceRead } from '@shared/services/api';
import { h, haptic, toast } from '../lib/dom';
import { forgetCard, getCards, rememberCard } from '../lib/storage';
import { ICONS } from '../ui/components';
import type { View } from './types';

function groupDigits(digits: string): string {
  return digits.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
}

function maskCard(digits: string): string {
  const d = digits.replace(/\D/g, '');
  return d.length <= 4 ? d : `•••• ${d.slice(-4)}`;
}

export function createSaldoView(): View {
  const el = h('section', { class: 'screen screen-saldo' });
  const head = h('div', { class: 'screen-head' }, [
    h('h1', { class: 'screen-title', text: 'Saldo tullave' }),
    h('p', { class: 'screen-sub', text: 'Consulta el saldo registrado en el servidor' }),
  ]);

  const input = h('input', {
    class: 'card-input',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: '24',
    placeholder: 'XXXX XXXX XXXX XXXX',
    'aria-label': 'Número de tarjeta',
  }) as HTMLInputElement;

  const submit = h('button', { class: 'btn btn-primary card-submit', type: 'submit', html: `${ICONS.card}<span>Consultar</span>` });
  const form = h('form', { class: 'card-form' }, [
    h('label', { class: 'field-label', text: 'Número de tarjeta' }),
    input,
    submit,
  ]) as HTMLFormElement;

  const recentWrap = h('div', { class: 'card-recents' });
  const result = h('div', { class: 'card-result' });

  head.append(form, recentWrap);
  el.append(head, result);

  input.addEventListener('input', () => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.length;
    input.value = groupDigits(input.value).slice(0, 24);
    const after = input.value.length;
    input.setSelectionRange(pos + (after - before), pos + (after - before));
  });

  function renderRecents(): void {
    const cards = getCards();
    recentWrap.replaceChildren();
    if (cards.length === 0) return;
    recentWrap.append(h('span', { class: 'card-recents-label', text: 'Recientes' }));
    for (const d of cards) {
      const chip = h('button', { class: 'card-recent-chip', type: 'button', text: maskCard(d) });
      chip.addEventListener('click', () => {
        input.value = groupDigits(d);
        input.focus();
      });
      const x = h('span', { class: 'card-recent-x', text: '✕', 'aria-label': 'Olvidar' });
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        forgetCard(d);
        renderRecents();
      });
      chip.append(x);
      recentWrap.append(chip);
    }
  }

  function renderResult(read: CardBalanceRead): void {
    const balance = read.balance ?? '—';
    const card = h('div', { class: 'balance-card' });
    card.append(
      h('div', { class: 'balance-top' }, [
        h('span', { class: 'balance-label', text: 'Saldo (servidor)' }),
        h('span', { class: 'balance-src', text: read.balanceSource === 'card' ? 'NFC' : 'Servidor' }),
      ]),
      h('div', { class: 'balance-amount', text: balance.startsWith('$') ? balance : `$ ${balance}` }),
      h('div', { class: 'balance-card-num', text: maskCard(read.numeroTarjeta) })
    );
    result.replaceChildren(card);

    // Movements (server ledger only).
    if (read.movements.length) {
      const mv = h('div', { class: 'mv-section' });
      mv.append(h('div', { class: 'rd-section-title', text: 'Movimientos (servidor)' }));
      for (const m of read.movements) {
        mv.append(
          h('div', { class: 'mv-row' }, [
            h('div', {}, [
              h('div', { class: 'mv-type', text: m.type || 'Movimiento' }),
              h('div', { class: 'mv-when', text: m.occurredAt || '' }),
            ]),
            h('div', { class: 'mv-amt', text: m.amount || '' }),
          ])
        );
      }
      result.append(mv);
    }

    // Provenance note — never present missing NFC memory as verified (spec §5.5.1a).
    result.append(
      h('div', { class: 'provenance' }, [
        h('div', { class: 'provenance-title', html: `${ICONS.card} Sobre estos datos` }),
        h('div', {
          class: 'provenance-text',
          html:
            'Muestra únicamente el <b>ledger del servidor</b> (<code>/lectura_tarjeta</code>). ' +
            'El saldo real puede ser mayor: la app oficial lee la <b>memoria NFC</b> de la tarjeta tras un toque, ' +
            'algo que este cliente no puede verificar y por eso no inventa.',
        }),
      ])
    );
  }

  function renderError(msg: string): void {
    result.replaceChildren(
      h('div', { class: 'empty' }, [
        h('div', { class: 'empty-title', text: 'No se pudo consultar' }),
        h('div', { class: 'empty-text', text: msg }),
      ])
    );
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const digits = input.value.replace(/\D/g, '');
    if (digits.length < 6) {
      toast('Número de tarjeta inválido', 'warn');
      return;
    }
    submit.classList.add('busy');
    result.replaceChildren(h('div', { class: 'card-loading', html: `${ICONS.refresh}<span>Consultando…</span>` }));
    haptic('medium');
    try {
      const res = await api.readCardBalance(digits, 'false');
      if (res.success && res.data) {
        rememberCard(digits);
        renderRecents();
        renderResult(res.data);
      } else {
        renderError(res.error || 'El servidor no devolvió datos.');
      }
    } catch (err) {
      renderError(err instanceof Error ? err.message : 'Error de red');
    } finally {
      submit.classList.remove('busy');
    }
  });

  // Placeholder result state.
  result.append(
    h('div', { class: 'empty' }, [
      h('div', { class: 'empty-title', text: 'Sin consulta' }),
      h('div', { class: 'empty-text', html: 'Ingresa el número de tu tarjeta <b>tullave</b> para ver el saldo del servidor.' }),
    ])
  );

  return {
    el,
    onShow: renderRecents,
  };
}
