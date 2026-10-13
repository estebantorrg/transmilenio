/** A tu llave number: 8 to 20 digits. */
export function isCardNumber(value: unknown): boolean;
/** `1234...5678` — the only form a card number is logged or echoed in. */
export function maskCardNumber(cardNumber: string): string;
export function isLedgerRow(item: unknown): item is Record<string, unknown>;

export interface LedgerMovement {
  source: 'server';
  numeroTarjeta: string;
  type: string;
  finalBalance?: string;
  occurredAt?: string;
}
/** One upstream ledger row → the movement both clients render. */
export function ledgerMovement(item: Record<string, unknown>, fallbackCardNumber: string): LedgerMovement;
