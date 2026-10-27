/**
 * The Android app's download page, `mitrasto.app/app/` (spec §5.5.11): one copy
 * that the prerender serves as a static page (what a WhatsApp preview and a
 * reader without JS get) and the website opens in its own shell — and the
 * install steps the app card on route and estación pages shows
 * (`appPromoHtml`), so the two cannot word Play Protect's dialog differently.
 *
 * The address to give someone is `mitrasto.app/app`. GitHub is where the APK is
 * built and kept; nobody who is not a developer should have to see it, so the
 * page's button is `/app/descargar`, which the server redirects to the newest
 * release's file.
 */

export const APP_PATH = '/app/';
export const APP_DOWNLOAD_PATH = '/app/descargar';
/** The newest release's APK; the release workflow names it the same every time. */
export const APP_APK_URL = 'https://github.com/estebantorrg/transmilenio/releases/latest/download/mitrasto.apk';

export const APP_TITLE = 'Descarga MiTrasto para Android';
export const APP_DESCRIPTION =
  'La app gratis de MiTrasto: buses de TransMilenio y SITP en vivo, el saldo de tu tarjeta y una guía para tu viaje. Descárgala aquí, sin Play Store.';

/**
 * The two confirmations Android asks for an app from outside Play Store, as
 * list items. Play Protect's dialog is named in Google's own es-419 words: a
 * warning the rider was told about reads as a step, one sprung on them reads as
 * a virus.
 */
export function pasosConfirmacionHtml() {
  return (
    '<li>Si Android lo pide, permite que tu navegador instale apps.</li>' +
    '<li>Si aparece «Se recomienda analizar la app», toca <strong>Analizar app</strong>: Google la revisa y te deja instalarla.</li>'
  );
}

/** The page's content — the same on the static page and in the website's shell. */
export function appPageHtml() {
  return `<article class="app-dl">
<header class="app-dl-head">
  <img class="app-dl-icon" src="/icon-192.png" alt="" width="64" height="64" />
  <div>
    <h1>MiTrasto para Android</h1>
    <p class="app-dl-lead">Los buses de TransMilenio y SITP en vivo, el saldo de tu tarjeta y una guía para tu viaje, en tu celular.</p>
  </div>
</header>
<a class="app-dl-btn" href="${APP_DOWNLOAD_PATH}">Descargar la app</a>
<p class="app-dl-note">Gratis y de código abierto · Android 5.1 o superior</p>
<section class="app-dl-sec">
  <h2>Qué hace</h2>
  <ul>
    <li>Ves los buses en vivo directo desde tu celular, más rápido que en la página.</li>
    <li>Consultas el saldo de tu tarjeta acercándola al teléfono.</li>
    <li>Planeas tu viaje y la app te guía mientras viajas.</li>
  </ul>
</section>
<section class="app-dl-sec">
  <h2>Cómo instalarla</h2>
  <ol>
    <li>Toca <strong>Descargar la app</strong> y, cuando termine, abre el archivo <strong>mitrasto.apk</strong> (en la notificación o en Descargas).</li>
    ${pasosConfirmacionHtml()}
  </ol>
  <p>Todavía no está en Play Store: por eso Android pide esas confirmaciones. La app te avisa cuando hay una versión nueva.</p>
</section>
<section class="app-dl-sec">
  <h2>¿Tienes iPhone?</h2>
  <p>La app es solo para Android. En iPhone, abre <a href="/">mitrasto.app</a> en Safari: tiene el mapa, las rutas, el planeador y los buses en vivo.</p>
</section>
<section class="app-dl-sec">
  <h2>Compártela</h2>
  <p>Para que otra persona la instale, envíale este enlace: <strong>mitrasto.app/app</strong></p>
</section>
</article>`;
}

/**
 * The page's stylesheet, shared by the prerender (inlined) and the website
 * (`ensureAppDescargaStyle`), as `LEGAL_CSS` is: literal colours, because the
 * static page ships before any stylesheet of ours is guaranteed to exist.
 */
export const APP_DESCARGA_CSS = `
.app-dl { --app-accent: var(--page-accent, var(--accent, #D8102D)); padding: 18px 0 8px; line-height: 1.6; color: #fff; }
.app-dl-head { display: flex; align-items: center; gap: 16px; }
.app-dl-icon { flex: none; border-radius: 16px; box-shadow: 0 6px 18px rgba(0,0,0,.45); }
.app-dl h1 { font-size: 1.6rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; margin: 0; }
.app-dl-lead { margin: 6px 0 0; color: rgba(255,255,255,.72); }
.app-dl-btn { display: flex; justify-content: center; align-items: center; margin: 22px 0 0; padding: 15px 18px; border-radius: 12px; background: var(--app-accent); color: #fff !important; font-size: 1.05rem; font-weight: 700; text-decoration: none; box-shadow: 0 6px 18px rgba(0,0,0,.45); }
.app-dl-btn:hover { filter: brightness(1.08); }
.app-dl-btn:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
.app-dl-note { margin: 8px 0 0; text-align: center; font-size: 0.85rem; color: rgba(255,255,255,.6); }
.app-dl-sec { margin-top: 24px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.08); }
.app-dl-sec h2 { display: flex; align-items: center; gap: 9px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(255,255,255,.6); margin: 0 0 12px; }
.app-dl-sec h2::before { content: ""; width: 3px; height: 13px; border-radius: 2px; background: var(--app-accent); flex: none; }
.app-dl-sec ul, .app-dl-sec ol { margin: 0; padding-left: 1.25rem; }
.app-dl-sec li + li { margin-top: 6px; }
.app-dl-sec p { margin: 10px 0 0; color: rgba(255,255,255,.72); }
.app-dl a { color: inherit; }
`;

/** Injects the stylesheet once (the website; the prerender inlines it). */
export function ensureAppDescargaStyle() {
  if (typeof document === 'undefined' || document.getElementById('app-dl-css')) return;
  const style = document.createElement('style');
  style.id = 'app-dl-css';
  style.textContent = APP_DESCARGA_CSS;
  document.head.appendChild(style);
}

/** Whether `pathname` is the page — with or without the trailing slash, any case. */
export function isAppPath(pathname) {
  return String(pathname ?? '').toLowerCase().replace(/\/+$/, '') + '/' === APP_PATH;
}
