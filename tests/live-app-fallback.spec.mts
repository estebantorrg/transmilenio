/**
 * The live card's app fallback (`client/src/ui/liveAppFallback.ts`): on Android,
 * when the website can't get a live fix, it points at the app that can.
 *
 * `.mts` on purpose: it reaches `shared/app_descarga.js`, which `known_page`'s
 * `.mts` spec also reaches, and a shared module pulled in as both ESM and CJS
 * aborts the whole run (see the ESM/CJS note in the memory log).
 */

import { expect, test } from '@playwright/test';
import { liveAppFallbackHtml } from '../client/src/ui/liveAppFallback';
import { APP_PATH } from '../shared/app_descarga.js';

test('on Android it links to the app page, nothing elsewhere', () => {
  const html = liveAppFallbackHtml(true);
  expect(html).toContain(`href="${APP_PATH}"`);
  expect(html).toContain('ábrelo en la app');
  expect(liveAppFallbackHtml(false)).toBe('');
});
