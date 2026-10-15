/**
 * Novedades de la operación — TransMilenio's `#TMAhora` posts (spec §5.5.9).
 *
 * Two surfaces. A banner at the top of Explorar (never over Cerca or Planear),
 * shown like an unread notice: only for a post newer than the last one the rider
 * saw — by opening the page or closing the banner — and only while it is recent,
 * since an old detour shown as current is worse than none (`bannerPost`). And the page, `/novedades/`, in the same shell as every other page
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
import { PROFILE_URL as CHANNEL_URL, SEEN_STORAGE_KEY, ago, bannerPost, clock, headline, postText } from '../../../shared/novedades.js';

const PAGE_PATH = '/novedades/';
const REFRESH_MS = 3 * 60_000;
/** The server reads every three minutes; well past that, it has stopped reading. */
const SOURCE_STALE_MS = 15 * 60_000;

let latest: NovedadesResponse | null = null;

function seenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** The newest post counts as seen: the banner stays down until a newer one. */
function markSeen(): void {
  const newest = latest?.items[0];
  if (!newest) return;
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, String(newest.at));
  } catch {
    // Blocked storage: the banner simply comes back on the next load.
  }
  renderBanner();
}

function renderBanner(): void {
  const banner = document.getElementById('novedades-banner');
  if (!banner) return;
  const newest = bannerPost(latest?.items, seenAt());
  if (!newest) {
    banner.hidden = true;
    return;
  }
  const count = latest!.items.length;
  // The bare count on screen needs its words for a screen reader.
  const label = `TransMilenio, ${ago(newest.at)}: ${headline(newest.text)}. Ver ${count === 1 ? 'la novedad' : `las ${count} novedades`} de hoy`;
  banner.innerHTML =
    `<a class="novedades-banner-link" href="${PAGE_PATH}" aria-label="${escapeHTML(label)}">` +
    `<span class="novedades-banner-text">` +
    `<span class="novedades-banner-meta">TransMilenio · ${escapeHTML(ago(newest.at))}</span>` +
    `<span class="novedades-banner-title">${escapeHTML(headline(newest.text))}</span>` +
    `</span>` +
    `<span class="novedades-banner-more" aria-hidden="true">${count} ›</span>` +
    `</a>` +
    `<button type="button" class="novedades-banner-close" aria-label="Ocultar hasta la próxima novedad" title="Ocultar">×</button>`;
  banner.querySelector('.novedades-banner-close')?.addEventListener('click', markSeen);
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
      <p class="novedades-intro">#TMAhora de <a href="${CHANNEL_URL}" target="_blank" rel="noopener noreferrer">@TransMilenio</a> · últimas 24 horas</p>
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
  // Reading the list is seeing what it holds.
  wire: () => markSeen(),
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
  // Inside Explorar only: over Cerca and Planear it was a notice in the way of
  // a task already under way.
  document.getElementById('explore-panel')?.insertAdjacentHTML(
    'afterbegin',
    `<div id="novedades-banner" class="novedades-banner" hidden></div>`
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
