/**
 * The station-demand sync reads what it thinks it reads (spec §5.8).
 *
 * `sync:demand` runs unattended every day and a bot commits what it writes, so
 * its parser is the one place a quiet upstream change becomes wrong numbers in
 * production with nothing failing. Its guards used to catch "zero rows" only.
 *
 *   1. the counts are the last two columns — and the header has to say so
 *   2. a festivo is not a weekday, whatever day of the week it falls on
 *   3. the hand-written ZIP reader still opens the form these files use
 */

import { expect, test } from '@playwright/test';
import zlib from 'node:zlib';
import { aggregateDay, firstWorking, isOrdinaryWeekday, unzipSingleEntry } from '../server/src/services/salidas';

// The real header and row shape (salidas20261009.zip).
const HEADER = 'Fecha_Transaccion,Tiempo,Linea,Estacion,Acceso_Estacion,Dispositivo,Entradas_E,Salidas_S';
const row = (station: string, access: string, entradas: number, salidas: number) =>
  `2026-10-09,06:15:00,(12)Zona L Carrera 10,${station},${access},040000372,${entradas},${salidas}`;

test.describe('one day of Salidas', () => {
  test('sums entries and exits per station code', () => {
    const csv = [
      HEADER,
      row('(10000)Portal 20 de Julio', '(01) ACCESO NORTE', 120, 30),
      row('(10000)Portal 20 de Julio', '(02) ACCESO SUR', 5, 7),
      // ~0.5% of rows carry commas inside the access name; the counts are still last.
      row('(09110)Av. Jiménez', '(03) PLATAFORMA 1, COSTADO SUR, PUERTA 2', 10, 4),
      'not,a,station,row,at,all,1,2',
      '',
    ].join('\r\n');

    const agg = new Map<string, { e: number; s: number }>();
    expect(aggregateDay(csv, agg)).toBe(3);
    expect(agg.get('10000')).toEqual({ e: 125, s: 37 });
    expect(agg.get('09110')).toEqual({ e: 10, s: 4 });
    expect(agg.size).toBe(2);

    // A second day accumulates into the same totals.
    aggregateDay([HEADER, row('(10000)Portal 20 de Julio', '(01) ACCESO NORTE', 1, 1)].join('\n'), agg);
    expect(agg.get('10000')).toEqual({ e: 126, s: 38 });
  });

  test('refuses a file whose last two columns are no longer the counts', () => {
    // Every row would still parse, and the wrong numbers would be committed.
    const appended = [`${HEADER},Tipo_Tarjeta`, `${row('(10000)Portal', '(01) A', 120, 30)},7`].join('\n');
    expect(() => aggregateDay(appended, new Map())).toThrow('no longer ends in Entradas_E, Salidas_S');

    const swapped = [HEADER.replace('Entradas_E,Salidas_S', 'Salidas_S,Entradas_E'), row('(10000)Portal', '(01) A', 1, 2)].join('\n');
    expect(() => aggregateDay(swapped, new Map())).toThrow('no longer ends in');

    // A byte-order mark or stray spaces are not a format change.
    const bom = [`﻿${HEADER.replace('Salidas_S', ' Salidas_S ')}`, row('(10000)Portal', '(01) A', 3, 4)].join('\n');
    expect(aggregateDay(bom, new Map())).toBe(1);
  });
});

test.describe('which days are averaged', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

  test('Monday to Friday', () => {
    expect(isOrdinaryWeekday(day('2026-10-09'))).toBe(true); // Friday
    expect(isOrdinaryWeekday(day('2026-10-10'))).toBe(false); // Saturday
    expect(isOrdinaryWeekday(day('2026-10-11'))).toBe(false); // Sunday
    expect(isOrdinaryWeekday(day('2026-10-13'))).toBe(true); // Tuesday
  });

  test('but never a festivo', () => {
    // Its file is published like any other day's, with a Sunday's ridership.
    expect(isOrdinaryWeekday(day('2026-10-12'))).toBe(false); // Monday, Día de la Raza
    expect(isOrdinaryWeekday(day('2026-12-25'))).toBe(false); // Friday, Navidad
    expect(isOrdinaryWeekday(day('2026-07-20'))).toBe(false); // Monday, Independencia
  });
});

test.describe('the ZIP reader', () => {
  /** One deflated entry in the data-descriptor form: the local header's sizes
   *  are zero, so the size can only come from the central directory. */
  function zipOf(name: string, text: string): Buffer {
    const data = zlib.deflateRawSync(Buffer.from(text, 'utf8'));
    const file = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x0008, 6); // flags: sizes follow the data
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(file.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(0, 42); // offset of the local header

    const descriptor = Buffer.alloc(16);
    const centralAt = local.length + file.length + data.length + descriptor.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt32LE(centralAt, 16);

    return Buffer.concat([local, file, data, descriptor, central, file, end]);
  }

  test('opens the single CSV a Salidas file holds', () => {
    const csv = [HEADER, row('(10000)Portal 20 de Julio', '(01) ACCESO NORTE', 120, 30)].join('\n');
    expect(unzipSingleEntry(zipOf('salidas20261009.csv', csv)).toString('utf8')).toBe(csv);
  });

  test('and says so when the bytes are not a ZIP', () => {
    expect(() => unzipSingleEntry(Buffer.from('<html>404</html>'))).toThrow('end-of-central-directory not found');
  });
});

// The Salidas host answers Colombia only, so the daily runner (abroad) picks a
// free proxy that the host answers as Colombian (`colombianProxy`, sync_demand.ts).
test.describe('picking a proxy', () => {
  test('the first one that works, a batch at a time, and a probe that throws is a no', async () => {
    const probed: number[] = [];
    const works = async (n: number) => {
      probed.push(n);
      if (n === 2) throw new Error('tunnel reset');
      return n === 3 || n === 5;
    };
    expect(await firstWorking([1, 2, 3, 4, 5], works, 2)).toBe(3);
    // Batch [1,2] all failed, batch [3,4] found 3; batch [5] was never asked.
    expect(probed.sort()).toEqual([1, 2, 3, 4]);
  });

  test('none that works is null, not an error', async () => {
    expect(await firstWorking([1, 2, 3], async () => false)).toBeNull();
    expect(await firstWorking([], async () => true)).toBeNull();
  });
});
