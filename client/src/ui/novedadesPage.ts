/**
 * Novedades de la operación — TransMilenio's `#TMAhora` posts (spec §5.5.9).
 *
 * Two surfaces. A bell at the top right of the map that opens a popup with the
 * last day's posts; it carries a dot like an unread notice: only for a post
 * newer than the last one the rider saw — by opening the popup or the page —
 * and only while it is recent, since an old detour flagged as new is worse than
 * none (`bannerPost`). And the page, `/novedades/`, in the same shell as every
 * other page (`pageShell.ts`) with the same list: newest first, each with when
 * it was posted and a link to it on X.
 *
 * The posts are shown as TransMilenio wrote them — their emoji lines are
 * already a layout — and said to be theirs; nothing here verifies them. When
 * the server could not read X lately, the list says so instead of presenting
 * itself as complete.
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
const INTRO_HTML = `#TMAhora de <a href="${CHANNEL_URL}" target="_blank" rel="noopener noreferrer">@TransMilenio</a> · últimas 24 horas`;

let latest: NovedadesResponse | null = null;

function seenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** The newest post counts as seen: the bell's dot stays off until a newer one. */
function markSeen(): void {
  const newest = latest?.items[0];
  if (newest) {
    try {
      localStorage.setItem(SEEN_STORAGE_KEY, String(newest.at));
    } catch {
      // Blocked storage: the dot simply comes back on the next load.
    }
  }
  renderBell();
}

function renderBell(): void {
  const bell = document.getElementById('novedades-bell');
  const pop = document.getElementById('novedades-pop');
  if (!bell || !pop) return;
  const unread = bannerPost(latest?.items, seenAt());
  bell.classList.toggle('unread', !!unread);
  bell.setAttribute(
    'aria-label',
    unread ? `Novedades de la operación. Nueva, ${ago(unread.at)}: ${headline(unread.text)}` : 'Novedades de la operación'
  );
  if (!pop.hidden) pop.querySelector('.novedades-pop-body')!.innerHTML = listHtml();
}

function setPopOpen(open: boolean): void {
  const bell = document.getElementById('novedades-bell');
  const pop = document.getElementById('novedades-pop');
  if (!bell || !pop || pop.hidden === !open) return;
  pop.hidden = !open;
  bell.setAttribute('aria-expanded', String(open));
  // Opening it is reading it.
  if (open) markSeen();
}

/** The notices and how fresh their source is — the page's body and the popup's. */
function listHtml(): string {
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
  return notice + list;
}

function pageHtml(): string {
  return `
    ${mastheadHtml({ mapSubject: false })}
    <div class="page-inner">
      ${crumbsHtml([{ label: 'Inicio', href: '/' }, { label: 'Novedades' }])}
      <h1 class="novedades-title">Novedades de la operación</h1>
      <p class="novedades-intro">${INTRO_HTML}</p>
      ${listHtml()}
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
    // Keep what was shown; the list says when the source itself went quiet.
    console.warn('[Novedades] unavailable:', error);
  }
  renderBell();
  refreshOverlayPage(page);
}

/** Bell + popup + page. Called once from `main.ts`, after `initPageShell`. */
export function initNovedades(): void {
  document.getElementById('map')?.insertAdjacentHTML(
    'afterend',
    `<button id="novedades-bell" class="novedades-bell" type="button" aria-controls="novedades-pop" aria-expanded="false" aria-label="Novedades de la operación" title="Novedades">` +
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>` +
      `</button>` +
      `<div id="novedades-pop" class="novedades-pop" role="dialog" aria-labelledby="novedades-pop-title" hidden>` +
      `<h2 id="novedades-pop-title" class="novedades-pop-title">Novedades de la operación</h2>` +
      `<p class="novedades-intro">${INTRO_HTML}</p>` +
      `<div class="novedades-pop-body"></div>` +
      `</div>`
  );
  const bell = document.getElementById('novedades-bell')!;
  const pop = document.getElementById('novedades-pop')!;
  bell.addEventListener('click', () => setPopOpen(pop.hidden));
  document.addEventListener('pointerdown', (e) => {
    if (!pop.contains(e.target as Node) && !bell.contains(e.target as Node)) setPopOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || pop.hidden) return;
    setPopOpen(false);
    bell.focus();
  });

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
