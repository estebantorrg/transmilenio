/**
 * How a clock time is handed to the speech synthesiser (spec §5.9).
 *
 * A time written `H:MM` is recognised as one and read the engine's own way,
 * period included — so "4:20 de la madrugada" came out of a phone as "cuatro y
 * veinte de la mañana de la madrugada". The spoken clock is written as the
 * words a person says, and never carries a colon.
 */

import { expect, test } from '@playwright/test';
import { speakClock } from '../client/src/services/voiceSpanish';

test.describe('the spoken clock', () => {
  test('is said in words, with one period of the day', () => {
    expect(speakClock(4 * 60 + 20)).toBe('4 y 20 de la madrugada');
    expect(speakClock(4 * 60 + 30)).toBe('4 y 30 de la madrugada');
    expect(speakClock(5 * 60)).toBe('5 de la mañana');
    expect(speakClock(9 * 60 + 5)).toBe('9 y 5 de la mañana');
    expect(speakClock(12 * 60 + 30)).toBe('12 y 30 de la tarde');
    expect(speakClock(18 * 60 + 59)).toBe('6 y 59 de la tarde');
    expect(speakClock(22 * 60)).toBe('10 de la noche');
    expect(speakClock(30)).toBe('12 y 30 de la madrugada');
  });

  test('noon and midnight keep their own names', () => {
    expect(speakClock(0)).toBe('medianoche');
    expect(speakClock(12 * 60)).toBe('mediodía');
    // Past midnight is the next day's clock, not a 25th hour.
    expect(speakClock(24 * 60)).toBe('medianoche');
    expect(speakClock(24 * 60 + 15)).toBe('12 y 15 de la madrugada');
  });

  test('never hands the synthesiser a time it would read its own way', () => {
    for (let minute = 0; minute < 24 * 60; minute++) {
      expect(speakClock(minute), String(minute)).not.toContain(':');
    }
  });
});
