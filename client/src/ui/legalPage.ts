/**
 * The legal pages — `/privacidad/` (spec §5.5.7) — as in-app pages.
 *
 * They are real URLs like the route and estación pages, and they open in the
 * same shell (`pageShell.ts`): masthead, map inert behind, Escape and "Ver en el
 * mapa" to leave, Back/Forward driven by the address bar. A link to one from
 * anywhere in the app is a plain anchor that the shell turns into a page, so it
 * still middle-clicks and copies like any other link.
 *
 * The text is not written here. It lives once in `shared/legal.js`, which the
 * prerender renders too (§5.5.4): the static page is what a crawler indexes and
 * what a reader without JS gets, and a policy that read differently in the app
 * would be two policies. This module only supplies the chrome around it.
 *
 * Unlike the route and estación pages these need no catalog, so a visitor who
 * lands on one is handed the interactive page straight away rather than when
 * the network data arrives.
 */

import { crumbsHtml, mastheadHtml, openOverlayPage, registerPageResolver, type OverlayPage } from './pageShell';
import { ensureLegalStyle, legalDocForPath, legalDocHtml, type LegalDoc } from '../../../shared/legal.js';

const PAGE_ID = 'legal-page';

function descriptor(doc: LegalDoc): OverlayPage {
  return {
    id: PAGE_ID,
    className: 'legal-page',
    path: doc.path,
    // Not keyed to a subject: the site's own red, the prerender's default accent.
    accent: 'var(--tm-red)',
    render: () => `
      ${mastheadHtml()}
      <div class="page-inner">
        ${crumbsHtml([{ label: 'Inicio', href: '/' }, { label: doc.breadcrumb }])}
        ${legalDocHtml(doc)}
      </div>
    `,
    wire: () => {},
    // Nothing on the map belongs to a legal page; leaving is just leaving.
    onLeave: () => {},
  };
}

/**
 * Registers the legal pages with the shell and, when the address bar already
 * names one, opens it. Called once from `main.ts` at module scope, after
 * `initPageShell`.
 */
export function initLegalPages(): void {
  registerPageResolver((pathname) => {
    const doc = legalDocForPath(pathname);
    if (!doc) return null;
    ensureLegalStyle();
    return descriptor(doc);
  });

  const landed = legalDocForPath(location.pathname);
  if (landed) {
    ensureLegalStyle();
    // `push: false` — the URL already is this page; pushing would wedge a
    // duplicate entry in front of the Back that should leave the site.
    openOverlayPage(descriptor(landed), { push: false });
  }
}
