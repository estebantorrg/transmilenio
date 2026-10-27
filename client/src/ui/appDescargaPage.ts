/**
 * The Android app's download page, `/app/` (spec §5.5.11), as an in-app page —
 * the address to give someone who should install the app, instead of GitHub.
 *
 * Like the legal pages it needs no catalog, and its text lives once in
 * `shared/app_descarga.js`, which the prerender renders too; this module only
 * supplies the chrome around it.
 */

import { crumbsHtml, mastheadHtml, openOverlayPage, registerPageResolver, type OverlayPage } from './pageShell';
import { APP_PATH, appPageHtml, ensureAppDescargaStyle, isAppPath } from '../../../shared/app_descarga.js';

const page: OverlayPage = {
  id: 'app-descarga-page',
  className: 'app-descarga-page',
  path: APP_PATH,
  accent: 'var(--tm-red)',
  render: () => `
    ${mastheadHtml({ mapSubject: false })}
    <div class="page-inner">
      ${crumbsHtml([{ label: 'Inicio', href: '/' }, { label: 'App Android' }])}
      ${appPageHtml()}
    </div>
  `,
  wire: () => {},
  onLeave: () => {},
};

/** Registers the page and, when the address bar already names it, opens it. Called once from `main.ts`. */
export function initAppDescargaPage(): void {
  registerPageResolver((pathname) => {
    if (!isAppPath(pathname)) return null;
    ensureAppDescargaStyle();
    return page;
  });
  if (isAppPath(location.pathname)) {
    ensureAppDescargaStyle();
    // `push: false` — the URL already is this page.
    openOverlayPage(page, { push: false });
  }
}
