/**
 * How the project identifies itself upstream (spec §5.2.3).
 *
 * On 2026-09-16 TMSA blocklisted the one fixed `uuid` every tier sent, and a
 * single ban took down the direct tier, the relay, the card read and the proxy
 * pool at once. These pin the fix: the shared identity carries no uuid, and no
 * source file sends one of its own.
 */

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  LIVE_API_HOST,
  LIVE_HOST_HEADERS,
  OFFICIAL_APP_HEADERS,
} from '../server/src/services/official_app_headers';

const ROOT = path.resolve(__dirname, '..');
const BLOCKED_UUID = 'fd1be953-d85e-4c63-8c23-234f143f445d';
const SOURCE_DIRS = ['server/src', 'scripts', 'client/src', 'client/mobile/src', 'extension', 'shared'];
const SOURCE_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/;
// A header key named uuid, quoted or not: `uuid: '…'`, `'uuid': …`, `"UUID": …`.
const UUID_HEADER = /(^|[{,\s])['"]?uuid['"]?\s*:/im;

function* sourceFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (SOURCE_EXT.test(entry.name)) yield full;
  }
}

const headerNames = (headers: object) => Object.keys(headers).map((name) => name.toLowerCase());

test.describe('official app identity', () => {
  test('the live host gets Appid and the app release, and no uuid', () => {
    expect(LIVE_API_HOST).toBe('tmsa-transmiapp-shvpc.uc.r.appspot.com');
    // Appid is the one header the live host requires (401 without it).
    expect(LIVE_HOST_HEADERS.Appid).toBe('9a2c3b48f0c24ae9bfba38e94f27c3ea');
    expect(LIVE_HOST_HEADERS['User-Agent']).toBe('okhttp/4.12.0');
    expect(LIVE_HOST_HEADERS.version).toBe(OFFICIAL_APP_HEADERS.version);
    expect(headerNames(LIVE_HOST_HEADERS)).not.toContain('uuid');
    expect(headerNames(OFFICIAL_APP_HEADERS)).not.toContain('uuid');
  });

  test('the shared identity cannot be mutated by one caller for all the others', () => {
    expect(Object.isFrozen(LIVE_HOST_HEADERS)).toBe(true);
    expect(Object.isFrozen(OFFICIAL_APP_HEADERS)).toBe(true);
  });

  test('no source file sends a uuid header or carries the blocklisted id', () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        const text = fs.readFileSync(file, 'utf8');
        const rel = path.relative(ROOT, file);
        if (text.includes(BLOCKED_UUID)) offenders.push(`${rel}: blocklisted uuid`);
        const match = text.match(UUID_HEADER);
        if (match) offenders.push(`${rel}: uuid header near "${match[0].trim()}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
