# TransMilenio Explorer — Live Bridge (browser extension)

Live bus tracking calls an official TransMilenio endpoint that is **CO-IP
geofenced** and serves **no CORS headers**. A normal web page therefore cannot
read it: the browser blocks the cross-origin request (preflight `403`, no
`Access-Control-Allow-Origin`), and a non-Colombian server is rejected by the
geofence (`401`/`451`).

This tiny extension solves both at once. Its background worker performs the live
request **from your own browser**:

- Requests to a host in `host_permissions` are **not bound by page CORS**, so the
  response is readable.
- The request leaves **your machine**, carrying **your Colombian egress IP**, so
  it passes the geofence — no server relay needed.

When the extension is installed, TransMilenio Explorer automatically routes live
tracking through it. When it is absent, the app falls back to the server relay
(if configured), so nothing breaks.

## Security scope

The extension is intentionally minimal:

- `host_permissions` is limited to the single live API host.
- The background worker only ever contacts that host with fixed request shapes.
  It **never** fetches a page-supplied URL, so a page cannot turn it into an open
  proxy.
- The only data it can retrieve is public, real-time bus positions. No
  credentials, accounts, or personal data are involved.

## Install (one-time, unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open TransMilenio Explorer — live tracking now uses your own connection.

To use the app on another origin, add it to `content_scripts[].matches` in
`manifest.json` and reload the extension.
