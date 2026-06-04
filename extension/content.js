/**
 * TransMilenio Explorer — Live Bridge (content script)
 *
 * Thin relay between the web page and the background worker. The page never
 * talks to the extension directly (no extension id needed); it posts a
 * `window.postMessage` on a private channel, this script forwards it to the
 * background worker, and posts the result back. It also answers presence pings
 * so the page can detect the bridge and prefer it over the server relay.
 */

(() => {
  const CHANNEL = 'tm-live-bridge/v1';

  function reply(payload, targetOrigin) {
    window.postMessage({ channel: CHANNEL, dir: 'ext->page', ...payload }, targetOrigin);
  }

  window.addEventListener('message', (event) => {
    // Only accept messages this same window posted on our channel.
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'page->ext') return;

    if (msg.kind === 'ping') {
      reply({ kind: 'pong', id: msg.id }, event.origin);
      return;
    }

    if (msg.kind === 'fetch') {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'tm-live-fetch',
            ruta: msg.ruta,
            nombre: msg.nombre,
            routeType: msg.routeType,
            candidates: msg.candidates,
          },
          (resp) => {
            const lastError = chrome.runtime.lastError;
            reply(
              {
                kind: 'result',
                id: msg.id,
                ok: !lastError && !!(resp && resp.ok),
                data: resp && resp.data,
                error: lastError ? lastError.message : (resp && resp.error) || null,
              },
              event.origin
            );
          }
        );
      } catch (err) {
        reply({ kind: 'result', id: msg.id, ok: false, error: String((err && err.message) || err) }, event.origin);
      }
    }
  });

  // Announce presence so the page can switch to bridge mode without polling.
  reply({ kind: 'hello' }, window.location.origin);
})();
