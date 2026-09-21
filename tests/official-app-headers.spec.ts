/**
 * How the project identifies itself upstream (spec §5.2.3).
 *
 * The `uuid` header has flipped twice: on 2026-09-16 TMSA blocklisted the one
 * fixed id every tier sent (one ban took down the direct tier, the relay, the
 * card read and the proxy pool at once), and on 2026-09-21 the header became
 * mandatory. These pin both lessons: an id is always sent, it is derived per
 * deployment rather than written in the source, and it is stable — not minted
 * per request to outrun a block.
 */

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_INSTALL_UUID,
  LIVE_API_HOST,
  LIVE_HOST_HEADERS,
  OFFICIAL_APP_HEADERS,
} from '../server/src/services/official_app_headers';

const ROOT = path.resolve(__dirname, '..');
const BLOCKED_UUID = 'fd1be953-d85e-4c63-8c23-234f143f445d';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_DIRS = ['server/src', 'scripts', 'client/src', 'client/mobile/src', 'extension', 'shared'];
const SOURCE_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/;
// Any UUID-shaped literal in a source file: an id written down is an id shared
// by every deployment, which is the handle that got blocklisted.
const UUID_LITERAL = /['"][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]/i;

function* sourceFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (SOURCE_EXT.test(entry.name)) yield full;
  }
}

test.describe('official app identity', () => {
  test('the live host gets Appid, the app release and a uuid', () => {
    expect(LIVE_API_HOST).toBe('tmsa-transmiapp-shvpc.uc.r.appspot.com');
    // Appid → 401 without it; uuid → empty 403 without it (spec §5.2.3).
    expect(LIVE_HOST_HEADERS.Appid).toBe('9a2c3b48f0c24ae9bfba38e94f27c3ea');
    expect(LIVE_HOST_HEADERS['User-Agent']).toBe('okhttp/4.12.0');
    expect(LIVE_HOST_HEADERS.version).toBe(OFFICIAL_APP_HEADERS.version);
    expect(LIVE_HOST_HEADERS.uuid).toMatch(UUID_RE);
    expect(LIVE_HOST_HEADERS.uuid).not.toBe(BLOCKED_UUID);
  });

  test('the id is one per process, not one per request', () => {
    // Two reads of the identity must be the same install, or every request
    // would carry a new id — evasion, not identification (spec §5.2.3).
    expect(LIVE_HOST_HEADERS.uuid).toBe(APP_INSTALL_UUID);
    expect(OFFICIAL_APP_HEADERS.uuid).toBe(APP_INSTALL_UUID);
    expect(Object.isFrozen(LIVE_HOST_HEADERS)).toBe(true);
    expect(Object.isFrozen(OFFICIAL_APP_HEADERS)).toBe(true);
  });

  test('no source file hardcodes an id, and the blocklisted one is gone', () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        const text = fs.readFileSync(file, 'utf8');
        const rel = path.relative(ROOT, file);
        if (text.includes(BLOCKED_UUID)) offenders.push(`${rel}: blocklisted uuid`);
        // The regexes that *validate* an id shape are not literals; skip them.
        const literal = text.match(UUID_LITERAL);
        if (literal) offenders.push(`${rel}: hardcoded uuid ${literal[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the operator can pin the id with TM_APP_UUID', async () => {
    // Fresh process: the module resolves its id at load, so this is the only
    // way to observe the env override.
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const pinned = '11111111-2222-4333-8444-555555555555';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-uuid-'));
    const probe = path.join(dir, 'probe.mts');
    const moduleUrl = new URL(`file:///${path.join(ROOT, 'server/src/services/official_app_headers.ts').replace(/\\/g, '/')}`);
    fs.writeFileSync(probe, `import { APP_INSTALL_UUID } from ${JSON.stringify(moduleUrl.href)};\nconsole.log(APP_INSTALL_UUID);\n`);
    try {
      const out = execFileSync('npx', ['tsx', probe], {
        cwd: ROOT,
        env: { ...process.env, TM_APP_UUID: pinned },
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      expect(out.trim()).toBe(pinned);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
