/**
 * When the website cannot get a live fix (`unreachable`, or an `unverified`
 * empty) the Android app still can — it reads the live host straight from the
 * phone (spec §5.2.1b) — so the live card points there. Android only: the app
 * is Android, and there is nothing to send an iPhone or a desktop to.
 *
 * Its own module so the sub-line's decision is testable without the DOM and
 * MapLibre that `sidebar.ts` drags in.
 */

import { APP_PATH } from '../../../shared/app_descarga.js';

/** The ` · ábrelo en la app` tail for a live-unavailable sub-line, or `''`. */
export function liveAppFallbackHtml(isAndroid = /Android/i.test(navigator.userAgent)): string {
  return isAndroid ? ` · <a class="live-app-link" href="${APP_PATH}">ábrelo en la app</a>` : '';
}
