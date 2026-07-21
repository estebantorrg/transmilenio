/** Saldo tab — tullave card balance reader (server ledger, spec §5.5.1a). */

import { api, type CardBalanceRead } from '@shared/services/api';
import { h, haptic, toast } from '../lib/dom';
import { forgetCard, getCards, rememberCard } from '../lib/storage';
import { isNfcSupported, scanCard, canReadCardBalance, readCardBalance, type NfcCardRead, type NfcBalanceRead } from '../services/nfc';
import { ICONS } from '../ui/components';
import type { View } from './types';

const NFC_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9a13 13 0 0 1 0 6M9 6.5a19 19 0 0 1 0 11M13 5a25 25 0 0 1 0 14M17.5 6.5a19 19 0 0 1 0 11"/></svg>';

function groupDigits(digits: string): string {
  return digits.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
}

function maskCard(digits: string): string {
  const d = digits.replace(/\D/g, '');
  return d.length <= 4 ? d : `•••• ${d.slice(-4)}`;
}

function formatCOP(n: number): string {
  return `$ ${Math.round(n).toLocaleString('es-CO')}`;
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
  const nfcBtn = h('button', { class: 'btn btn-ghost card-nfc', type: 'button', html: `${NFC_ICON}<span>Acercar tarjeta (NFC)</span>` });
  const formChildren = [h('label', { class: 'field-label', text: 'Número de tarjeta' }), input, submit];
  if (isNfcSupported()) formChildren.push(nfcBtn);
  const form = h('form', { class: 'card-form' }, formChildren) as HTMLFormElement;

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

  async function consult(digits: string): Promise<void> {
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
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void consult(input.value.replace(/\D/g, ''));
  });

  // ── NFC read (Web NFC) ──
  function renderNfcResult(read: NfcCardRead): void {
    const rows = [
      h('div', { class: 'nfc-row' }, [
        h('span', { text: 'Serial (UID)' }),
        h('strong', { text: read.serialNumber || '—' }),
      ]),
    ];
    for (const rec of read.records.slice(0, 4)) {
      rows.push(h('div', { class: 'nfc-row' }, [h('span', { text: rec.type }), h('strong', { text: rec.text })]));
    }
    result.replaceChildren(
      h('div', { class: 'nfc-card' }, [
        h('div', { class: 'nfc-card-head', html: `${NFC_ICON}<span>Tarjeta leída (NFC)</span>` }),
        ...rows,
      ]),
      h('div', { class: 'provenance' }, [
        h('div', { class: 'provenance-title', html: `${NFC_ICON} Sobre la lectura NFC` }),
        h('div', {
          class: 'provenance-text',
          html:
            read.numericId
              ? 'Se detectó un número en la tarjeta; consultando el <b>saldo del servidor</b>…'
              : 'No se pudo leer el saldo directamente del chip <b>Calypso</b> en este intento (acércala de nuevo, bien centrada y sin moverla). El NFC entregó solo el <b>serial</b> y datos NDEF; mientras tanto, el saldo mostrado proviene del <b>servidor</b>.',
        }),
      ])
    );
  }

  // Direct card read (Calypso, spec §5.5.1b) — real balance + movements, no server.
  function renderCardBalance(read: NfcBalanceRead): void {
    const card = h('div', { class: 'balance-card' });
    card.append(
      h('div', { class: 'balance-top' }, [
        h('span', { class: 'balance-label', text: 'Saldo (tarjeta)' }),
        h('span', { class: 'balance-src', text: 'NFC' }),
      ]),
      h('div', { class: 'balance-amount', text: formatCOP(read.balanceCOP) }),
      h('div', { class: 'balance-card-num', text: maskCard(read.numeroTarjeta) })
    );
    result.replaceChildren(card);

    if (read.movements.length) {
      const mv = h('div', { class: 'mv-section' });
      mv.append(h('div', { class: 'rd-section-title', text: `Movimientos (tarjeta · ${read.movements.length})` }));
      for (const m of read.movements) {
        mv.append(
          h('div', { class: 'mv-row' }, [
            h('div', {}, [
              h('div', { class: 'mv-type', text: m.type }),
              h('div', { class: 'mv-when', text: m.occurredAt || '' }),
            ]),
            h('div', {}, [
              h('div', { class: 'mv-amt', text: m.amountCOP != null ? formatCOP(m.amountCOP) : '' }),
              h('div', { class: 'mv-when', text: m.finalBalanceCOP != null ? `Saldo: ${formatCOP(m.finalBalanceCOP)}` : '' }),
            ]),
          ])
        );
      }
      result.append(mv);
    }

    result.append(
      h('div', { class: 'provenance' }, [
        h('div', { class: 'provenance-title', html: `${NFC_ICON} Sobre estos datos` }),
        h('div', {
          class: 'provenance-text',
          html:
            'Leído <b>directamente de la tarjeta</b> por NFC (chip Calypso, lectura sin llaves). ' +
            'Es el saldo y los últimos movimientos que guarda el propio chip — no depende del servidor.',
        }),
      ])
    );
  }

  let nfcAbort: AbortController | null = null;
  async function readNfc(): Promise<void> {
    if (!isNfcSupported()) {
      toast('NFC no disponible en este dispositivo', 'warn');
      return;
    }
    nfcAbort?.abort();
    nfcAbort = new AbortController();
    const signal = nfcAbort.signal;
    nfcBtn.classList.add('busy');

    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancelar' });
    cancel.addEventListener('click', () => nfcAbort?.abort());
    result.replaceChildren(
      h('div', { class: 'nfc-prompt' }, [
        h('div', { class: 'nfc-wave', html: NFC_ICON }),
        h('div', { class: 'nfc-prompt-text', text: 'Acerca tu tarjeta tullave a la parte trasera del teléfono…' }),
        cancel,
      ])
    );
    haptic('medium');

    // Prefer the direct Calypso read (real balance). Fall back to NDEF + server.
    // NOTE: no `finally` here — on fall-through we must keep `nfcAbort`/busy state
    // so the Cancel button still aborts the fallback scan below.
    if (canReadCardBalance()) {
      try {
        const read = await readCardBalance(signal);
        haptic('heavy');
        if (read.numeroTarjeta) {
          input.value = groupDigits(read.numeroTarjeta);
          rememberCard(read.numeroTarjeta.replace(/\D/g, ''));
          renderRecents();
        }
        renderCardBalance(read);
        nfcBtn.classList.remove('busy');
        nfcAbort = null;
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          renderPlaceholder();
          nfcBtn.classList.remove('busy');
          nfcAbort = null;
          return;
        }
        // Fall through to the NDEF + server path on read failure (keep busy/abort).
        console.warn('[saldo] Calypso read failed, falling back to server:', err);
      }
    }

    try {
      const read = await scanCard(signal);
      haptic('heavy');
      renderNfcResult(read);
      if (read.numericId) {
        input.value = groupDigits(read.numericId);
        void consult(read.numericId);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        renderPlaceholder();
      } else {
        renderError(err instanceof Error ? err.message : 'Error NFC');
      }
    } finally {
      nfcBtn.classList.remove('busy');
      nfcAbort = null;
    }
  }
  nfcBtn.addEventListener('click', readNfc);

  function renderPlaceholder(): void {
    result.replaceChildren(
      h('div', { class: 'empty' }, [
        h('div', { class: 'empty-title', text: 'Sin consulta' }),
        h('div', {
          class: 'empty-text',
          html: 'Ingresa el número de tu tarjeta <b>tullave</b> o acércala por NFC para ver el saldo del servidor.',
        }),
      ])
    );
  }
  renderPlaceholder();

  return {
    el,
    onShow: renderRecents,
  };
}
