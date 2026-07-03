/**
 * Builds the web client for the Android shell.
 *
 * Reuses `client/` exactly as deployed on the website — same code, same build —
 * only pointed at the hosted API (the APK has no same-origin backend) and
 * emitted into `mobile/www` so the website's own `client/dist` is untouched.
 * `sw.js` is dropped from the copy: the native app skips SW registration
 * (see client/src/main.ts) and shipping a dead worker would be noise.
 *
 * Override the API with TM_MOBILE_API_BASE, e.g. a local server during dev:
 *   TM_MOBILE_API_BASE=http://192.168.1.10:3002/api npm run build:web
 */

import { spawnSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clientDir = path.resolve(mobileDir, '..', 'client');
const wwwDir = path.join(mobileDir, 'www');

const apiBase = (process.env.TM_MOBILE_API_BASE || 'https://transmilenio.onrender.com/api').replace(/\/$/, '');
console.log(`[mobile] Building web client against API: ${apiBase}`);

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['--prefix', clientDir, 'run', 'build', '--', '--outDir', wwwDir, '--emptyOutDir'],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, VITE_API_BASE_URL: apiBase },
  }
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const swFile = path.join(wwwDir, 'sw.js');
if (existsSync(swFile)) {
  rmSync(swFile);
}
console.log(`[mobile] Web assets ready in ${wwwDir}`);
