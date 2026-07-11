/**
 * Builds the app front-end for the Android shell.
 *
 * The APK ships the dedicated **mobile app** (`client/mobile/`), a ground-up
 * app UI that shares only the website's data/service layer (`@shared`) — never
 * its look. Unlike the website, the app talks to **no web server of ours**: on a
 * Colombian phone it hits the official TransMi / government / public hosts
 * directly via native HTTP (spec §5.2.1b), and reads the master catalog + offline
 * POI/demand datasets from APK-bundled assets. So this build:
 *   1. regenerates those bundled assets from the committed server data
 *      (`bundle:mobile`), keeping the two clients in sync (spec §1.1 R2);
 *   2. builds the mobile client into `mobile/www` (website `client/dist` untouched);
 *   3. drops `sw.js` (the native app skips SW registration).
 *
 * No `VITE_API_BASE_URL` is baked — native requests target official hosts, not us.
 */

import { spawnSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clientDir = path.resolve(mobileDir, '..', 'client');
const serverDir = path.resolve(mobileDir, '..', 'server');
const wwwDir = path.join(mobileDir, 'www');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const useShell = process.platform === 'win32';

// 1. Regenerate the APK-bundled offline assets (catalog + POI/demand) from the
//    committed server data. Requires the server deps (tsx) + Git LFS catalog.
console.log('[mobile] Regenerating bundled offline assets (catalog + POI)…');
const bundle = spawnSync(npm, ['--prefix', serverDir, 'run', 'bundle:mobile'], {
  stdio: 'inherit',
  shell: useShell,
});
if (bundle.status !== 0) {
  console.error('[mobile] bundle:mobile failed — ensure server deps are installed and Git LFS is pulled.');
  process.exit(bundle.status ?? 1);
}

// 2. Build the mobile client. The app hits official hosts directly, so no API
//    base is baked in (native HTTP ignores it entirely).
const result = spawnSync(
  npm,
  ['--prefix', clientDir, 'run', 'build:mobile', '--', '--outDir', wwwDir, '--emptyOutDir'],
  {
    stdio: 'inherit',
    shell: useShell,
  }
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// 3. Drop the service worker — the native app skips SW registration and shipping
//    a dead worker would be noise.
const swFile = path.join(wwwDir, 'sw.js');
if (existsSync(swFile)) {
  rmSync(swFile);
}
console.log(`[mobile] Web assets ready in ${wwwDir}`);
