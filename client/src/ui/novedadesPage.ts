/**
 * Novedades de la operación — TransMilenio's `#TMAhora` posts (spec §5.5.9).
 *
 * Two surfaces. A banner under the sidebar tabs, only while the newest post is
 * recent: an old detour shown as if it were current is worse than none, so
 * past {@link BANNER_MAX_AGE_MS} the banner goes and the posts are left to the
 * page. And the page, `/novedades/`, in the same shell as every other page
 * (`pageShell.ts`): the last day's posts, newest first, each with when it was
 * posted and a link to it on X.
 *
 * The posts are shown as TransMilenio wrote them — their emoji lines are
 * already a layout — and said to be theirs; nothing here verifies them. When
 * the server could not read X lately, the page says so instead of presenting
 * the list as complete.
 */

import { api, type NovedadesResponse } from '../services/api';
import { isAppActive, onAppActiveChange } from '../utils/appActive';
import { escapeHTML } from '../utils/html';
import { crumbsHtml, mastheadHtml, openOverlayPage, refreshOverlayPage, registerPageResolver, type OverlayPage } from './pageShell';
import { BANNER_MAX_AGE_MS, PROFILE_URL as CHANNEL_URL, ago, clock, headline, postText } from '../../../shared/novedades.js';

const PAGE_PATH = '/novedades/';
const REFRESH_MS = 3 * 60_000;
/** The server reads every three minutes; well past that, it has stopped reading. */
const SOURCE_STALE_MS = 15 * 60_000;

let latest: NovedadesResponse | null = null;

function renderBanner(): void {
  const banner = document.getElementById('novedades-banner');
  if (!banner) return;
  const newest = latest?.items[0];
  if (!newest || Date.now() - newest.at > BANNER_MAX_AGE_MS) {
    banner.hidden = true;
    return;
  }
  const count = latest!.items.length;
  // The bare count on screen needs its words for a screen reader.
  banner.setAttribute(
    'aria-label',
    `TransMilenio, ${ago(newest.at)}: ${headline(newest.text)}. Ver ${count === 1 ? 'la novedad' : `las ${count} novedades`} de hoy`
  );
  banner.innerHTML =
    `<span class="novedades-banner-text">` +
    `<span class="novedades-banner-meta">TransMilenio · ${escapeHTML(ago(newest.at))}</span>` +
    `<span class="novedades-banner-title">${escapeHTML(headline(newest.text))}</span>` +
    `</span>` +
    `<span class="novedades-banner-more" aria-hidden="true">${count} ›</span>`;
  banner.hidden = false;
}

function pageHtml(): string {
  const items = latest?.items ?? [];
  const status = latest?.status;
  const stale = !status?.lastOkAt || Date.now() - status.lastOkAt > SOURCE_STALE_MS;
  const notice = !latest
    ? '<p class="novedades-nota">Cargando…</p>'
    : stale
      ? '<p class="novedades-nota">No hemos podido leer las publicaciones de TransMilenio en los últimos minutos; lo de abajo puede no estar al día.</p>'
      : '';
  const list = items.length
    ? `<ol class="novedades-lista">${items
        .map(
          (post) => `
          <li class="aviso">
            <p class="aviso-eyebrow">${escapeHTML(ago(post.at))} · ${escapeHTML(clock(post.at))}</p>
            <p class="novedades-texto">${escapeHTML(postText(post.text))}</p>
            <a class="novedades-enlace" href="${escapeHTML(post.url)}" target="_blank" rel="noopener noreferrer">Ver en X ↗</a>
          </li>`
        )
        .join('')}</ol>`
    : latest && !stale
      ? '<p class="novedades-nota">TransMilenio no ha publicado novedades en las últimas 24 horas.</p>'
      : '';
  return `
    ${mastheadHtml({ mapSubject: false })}
    <div class="page-inner">
      ${crumbsHtml([{ label: 'Inicio', href: '/' }, { label: 'Novedades' }])}
      <h1 class="novedades-title">Novedades de la operación</h1>
      <p class="novedades-intro">Lo que TransMilenio publica como #TMAhora en <a href="${CHANNEL_URL}" target="_blank" rel="noopener noreferrer">su cuenta de X</a>, de las últimas 24 horas, tal como lo publica.</p>
      ${notice}
      ${list}
    </div>
  `;
}

const page: OverlayPage = {
  id: 'novedades-page',
  className: 'novedades-page',
  path: PAGE_PATH,
  // Notices are the yellow of the operator's own (`ui/avisos.ts`).
  accent: 'var(--tm-yellow)',
  render: pageHtml,
  wire: () => {},
  onLeave: () => {},
};

async function refresh(): Promise<void> {
  try {
    latest = await api.getNovedades();
  } catch (error) {
    // Keep what was shown; the page says when the source itself went quiet.
    console.warn('[Novedades] unavailable:', error);
  }
  renderBanner();
  refreshOverlayPage(page);
}

/** Banner + page. Called once from `main.ts`, after `initPageShell`. */
export function initNovedades(): void {
  document.querySelector('.sidebar-tabs')?.insertAdjacentHTML(
    'afterend',
    `<a id="novedades-banner" class="novedades-banner" href="${PAGE_PATH}" hidden></a>`
  );
  registerPageResolver((pathname) => (pathname.replace(/\/?$/, '/') === PAGE_PATH ? page : null));
  if (location.pathname.replace(/\/?$/, '/') === PAGE_PATH) openOverlayPage(page, { push: false });

  void refresh();
  let timer = window.setInterval(() => isAppActive() && void refresh(), REFRESH_MS);
  onAppActiveChange((active) => {
    window.clearInterval(timer);
    if (!active) return;
    void refresh();
    timer = window.setInterval(() => void refresh(), REFRESH_MS);
  });
}
