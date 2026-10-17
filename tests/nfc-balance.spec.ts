/**
 * The app's tu llave balance read over NFC (`client/mobile/src/services/nfc.ts`,
 * spec §5.5.1b).
 *
 * Every card reply ends in a two-byte status word, and `90 00` is the only one
 * that means the card did what it was asked. The read used to parse whatever
 * came back, so a bank card's `6E 00` ("class not supported") came out as a
 * $1.845.493.760 balance, shown as read off the card. The plugin is faked:
 * `window.nfc` answers each APDU from a script, and a tag is "tapped" the moment
 * a listener is added.
 */

import { expect, test } from '@playwright/test';
import { readCardBalance } from '../client/mobile/src/services/nfc';

type Reply = number[];

function fakeCard(replyFor: (apdu: number[], call: number) => Reply): void {
  let call = 0;
  (globalThis as any).window = {
    nfc: {
      addTagDiscoveredListener: (onTag: (event: unknown) => void) => setTimeout(() => onTag({ tag: {} }), 0),
      removeTagDiscoveredListener: () => {},
      connect: async () => {},
      close: async () => {},
      transceive: async (data: Uint8Array) => Uint8Array.from(replyFor(Array.from(data), call++)).buffer,
    },
  };
}

test.afterEach(() => {
  delete (globalThis as any).window;
});

const OK = [0x90, 0x00];

test('a card that refuses the tu llave commands is not read as a balance', async () => {
  // A contactless bank card: no such application, no such command class.
  fakeCard((apdu) => (apdu[0] === 0x00 && apdu[1] === 0xa4 ? [0x6a, 0x82] : [0x6e, 0x00]));
  await expect(readCardBalance()).rejects.toThrow('no respondió como una tullave');
});

test('a tu llave reply is parsed, and a missing record ends the movements', async () => {
  // SELECT AID, balance, binary, SELECT EF, then record 1 — which the card does not have.
  const script: Reply[] = [
    OK,
    [0x00, 0x00, 0x27, 0x10, 0x00, 0x00, 0x00, 0x00, ...OK], // 0x2710 = 10 000
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...OK], // no "01" offset prefix
    [0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x10, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78, ...OK],
    [0x6a, 0x83], // record not found
  ];
  fakeCard((_apdu, call) => script[call] ?? [0x6a, 0x83]);
  expect(await readCardBalance()).toEqual({
    numeroTarjeta: '1010000012345678',
    balanceCOP: 10_000,
    movements: [],
  });
});
