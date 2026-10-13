/**
 * The tu llave ledger row, as the official `/lectura_tarjeta` returns it (spec
 * §5.5.1a), mapped once for the server's card read and the app's native one.
 */

/** A tu llave number: 8 to 20 digits. */
export function isCardNumber(value) {
  return /^\d{8,20}$/.test(String(value ?? ''));
}

/** `1234...5678` — the only form a card number is logged or echoed in. */
export function maskCardNumber(cardNumber) {
  if (cardNumber.length <= 6) return cardNumber;
  return `${cardNumber.slice(0, 4)}...${cardNumber.slice(-4)}`;
}

export function isLedgerRow(item) {
  return item != null && typeof item === 'object' && !Array.isArray(item);
}

/** One upstream ledger row → the movement both clients render. */
export function ledgerMovement(item, fallbackCardNumber) {
  const upstreamCardNumber = String(item.numero_tarjeta ?? '').trim();
  return {
    source: 'server',
    numeroTarjeta: isCardNumber(upstreamCardNumber) ? maskCardNumber(upstreamCardNumber) : fallbackCardNumber,
    type: String(item.tipo ?? ''),
    finalBalance: item.saldo_tarjeta == null ? undefined : String(item.saldo_tarjeta),
    occurredAt: item.ultima_transaccion == null ? undefined : String(item.ultima_transaccion),
  };
}
