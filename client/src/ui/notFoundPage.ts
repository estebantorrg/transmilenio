/**
 * The page for an address this site does not have (spec §5.5.8): a made-up
 * `/ruta/…`, an estación that does not exist, a `#/r/<código>` nobody runs.
 *
 * Such an address used to open the map as if nothing had been asked, which reads
 * as the link having worked. It opens in the same shell as every other page
 * (`pageShell.ts`), over the address that was asked for — the address bar keeps
 * what the visitor typed, and leaving returns it to `/`.
 *
 * For a real path the server answers the shell with a 404 status too
 * (`server/src/known_page.ts`). A `#/…` link never reaches the server, so this
 * page is the only 404 it can get.
 */

import { escapeHTML } from '../utils/html';
import { closeOverlayPage, isOverlayPageOpen, leaveOverlayPage, mastheadHtml, openOverlayPage } from './pageShell';

const PAGE_ID = 'not-found-page';

/** `what` finishes "No encontramos …": "la ruta 1-1000000", "esa página". */
export function openNotFoundPage(what: string): void {
  openOverlayPage(
    {
      id: PAGE_ID,
      className: 'not-found-page',
      path: location.pathname,
      accent: 'var(--tm-red)',
      render: () => `
        ${mastheadHtml({ mapSubject: false })}
        <div class="page-inner">
          <p class="not-found-code">Error 404</p>
          <h1 class="not-found-title">No encontramos ${escapeHTML(what)}</h1>
          <p class="not-found-text">Puede que el enlace esté mal escrito o que ya no exista. Las rutas y estaciones que sí operan están en el mapa.</p>
          <div class="page-actions">
            <button type="button" class="page-action" data-not-found-leave>Ir al mapa</button>
          </div>
        </div>
      `,
      wire: (el) => {
        el.querySelector('[data-not-found-leave]')?.addEventListener('click', () => leaveOverlayPage());
      },
      // Leaving already returns the path to `/`; a made-up `#/r/…` has to go too.
      onLeave: () => {
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      },
    },
    { push: false }
  );
}

/** A link that does resolve takes the page down — the hash was edited to a real route. */
export function closeNotFoundPage(): void {
  if (isOverlayPageOpen(PAGE_ID)) closeOverlayPage();
}
