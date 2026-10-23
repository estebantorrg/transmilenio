/**
 * The only form a tu llave number is logged or echoed in (`maskCardNumber`,
 * shared/card_ledger.js; privacy policy §2.1: "enmascarado"). The server takes
 * 8 to 20 digits, and four plus four of an 8-digit number was the whole number.
 */

import { expect, test } from '@playwright/test';
import { maskCardNumber } from '../shared/card_ledger.js';

test('a full-length number keeps its first and last four', () => {
  expect(maskCardNumber('1234567890123456')).toBe('1234...3456');
  expect(maskCardNumber('12345678901234567890')).toBe('1234...7890');
});

test('a shorter number shows its last four alone', () => {
  expect(maskCardNumber('12345678')).toBe('...5678');
  expect(maskCardNumber('1234567890')).toBe('...7890');
});
