'use strict';

/**
 * TransMilenio relay — OCI Function (sa-bogota-1, Colombian egress).
 *
 * Fronted by an OCI API Gateway so the Render backend can reach the official
 * TransMi live host `tmsa-transmiapp-shvpc.uc.r.appspot.com` (CO-IP geofenced)
 * from a reliable Bogotá egress, replacing the flaky free public proxies.
 *
 * Two request shapes, both Bearer-gated (RELAY_SECRET) and both restricted to
 * the fixed live host + an allowlisted set of paths (no open proxy):
 *
 *   1. Generic forward (saldo, arrivals, buses, …):
 *        POST <gateway>/relay/forward
 *        body: { path: "/lectura_tarjeta", method?: "POST", body?: {...} }
 *        → { upstreamStatus, payload }   (HTTP 200 whenever upstream was reached)
 *
 *   2. Buses convenience shape (kept for the existing co-relay tier):
 *        POST <gateway>/relay/buses
 *        body: { action: 'zonal'|'troncal', ruta, nombre, Nombre, type }
 *        → { ruta, action, upstreamStatus, buses }
 *
 * Defensive on the fdk ctx: header/status accessors differ between the base
 * context (direct `fn invoke`) and the HTTP-gateway context (API Gateway), and
 * calling a missing method crashes the whole invocation → 502. Every ctx access
 * is guarded; the function always returns a JSON body.
 */

const fdk = require('@fnproject/fdk');
const https = require('https');

const LIVE_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';

// Only these upstream paths may be forwarded — keeps this a relay, not an open
// proxy. `/location/ruta` carries a `?ruta=` query, so match by prefix.
const ALLOWED_PATH_PREFIXES = ['/buses', '/location/ruta', '/paradero/buses', '/lectura_tarjeta'];

const UPSTREAM_HEADERS = {
  'Appid': '9a2c3b48f0c24ae9bfba38e94f27c3ea',
  'User-Agent': 'okhttp/4.12.0',
  'uuid': 'fd1be953-d85e-4c63-8c23-234f143f445d',
  'version': '2.9.5',
  'Accept-Encoding': 'identity',
};
const UPSTREAM_TIMEOUT_MS = 10000;

/** Read a request header across fdk ctx shapes, case-insensitively. Never throws. */
function readHeader(ctx, name) {
  const lower = name.toLowerCase();
  const tryGet = (obj) => {
    if (!obj) return undefined;
    try {
      if (typeof obj.getHeader === 'function') {
        const v = obj.getHeader(name) || obj.getHeader(lower);
        if (v != null) return v;
      }
    } catch (e) { /* ignore */ }
    for (const bagName of ['reqHeaders', 'headers', '_headers']) {
      try {
        const bag = obj[bagName];
        if (bag && typeof bag === 'object') {
          for (const k of Object.keys(bag)) {
            if (k.toLowerCase() === lower) {
              const v = bag[k];
              return Array.isArray(v) ? v[0] : v;
            }
          }
        }
      } catch (e) { /* ignore */ }
    }
    return undefined;
  };
  let hg;
  try { hg = ctx.httpGateway; } catch (e) { hg = undefined; }
  return tryGet(hg) ?? tryGet(ctx);
}

/** Set the HTTP response status if the ctx supports it. Never throws. */
function setStatus(ctx, code) {
  try {
    const hg = ctx.httpGateway;
    if (hg) { hg.statusCode = code; return; }
  } catch (e) { /* ignore */ }
  try {
    if (typeof ctx.setResponseStatus === 'function') ctx.setResponseStatus(code);
  } catch (e) { /* ignore */ }
}

function setJsonContentType(ctx) {
  try { ctx.responseContentType = 'application/json'; } catch (e) { /* ignore */ }
}

/** Extract a buses array from whatever shape the upstream returns. */
function extractBuses(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['buses', 'data', 'result', 'results', 'vehiculos', 'vehicles']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function isAllowedPath(path) {
  return typeof path === 'string' && ALLOWED_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + '?'));
}

function upstreamRequest(path, method, postData) {
  const headers = { ...UPSTREAM_HEADERS };
  if (postData) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    headers['Content-Length'] = Buffer.byteLength(postData);
  } else {
    headers['Content-Length'] = 0;
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: LIVE_HOST, path, method: method || 'POST', headers, timeout: UPSTREAM_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let payload = null;
          try { payload = JSON.parse(text); } catch (e) { /* leave null */ }
          resolve({ status: res.statusCode, payload, text });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function parseBody(input) {
  let body = input;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return body || {};
}

fdk.handle(async (input, ctx) => {
  setJsonContentType(ctx);

  try {
    // Optional shared-secret gate: enforced only if RELAY_SECRET is configured.
    const secret = process.env.RELAY_SECRET;
    if (secret) {
      const auth = String(readHeader(ctx, 'Authorization') || '');
      if (auth !== `Bearer ${secret}`) {
        setStatus(ctx, 403);
        return { error: 'forbidden' };
      }
    }

    const body = parseBody(input);

    // ── Shape 1: generic forward ({ path, method, body }) ──────────────────
    if (body.path != null) {
      const path = String(body.path);
      if (!isAllowedPath(path)) {
        setStatus(ctx, 400);
        return { error: 'path not allowed' };
      }
      const method = String(body.method || 'POST').toUpperCase();
      const fwdBody = body.body == null ? '' : (typeof body.body === 'string' ? body.body : JSON.stringify(body.body));
      try {
        const { status, payload, text } = await upstreamRequest(path, method, fwdBody);
        // Always HTTP 200 when upstream was reached; caller inspects upstreamStatus.
        return { upstreamStatus: status, payload: payload != null ? payload : text };
      } catch (err) {
        setStatus(ctx, 504);
        return { error: String((err && err.message) || err), upstreamStatus: 0 };
      }
    }

    // ── Shape 2: buses convenience ({ action, ruta, Nombre }) ──────────────
    const ruta = String(body.ruta || '').trim();
    const nombre = String(body.Nombre || body.nombre || '').trim();
    const action = String(body.action || body.type || 'troncal').toLowerCase();
    const isZonal = action === 'zonal';

    if (!ruta) {
      setStatus(ctx, 400);
      return { error: 'ruta is required', buses: [] };
    }

    const path = isZonal ? `/location/ruta?ruta=${encodeURIComponent(ruta)}` : '/buses';
    const postData = isZonal ? '' : JSON.stringify({ ruta, Nombre: nombre });
    const actionOut = isZonal ? 'zonal' : 'troncal';

    try {
      const { status, payload } = await upstreamRequest(path, 'POST', postData);
      if (status !== 200) setStatus(ctx, 502);
      return { ruta, action: actionOut, upstreamStatus: status, buses: extractBuses(payload) };
    } catch (err) {
      setStatus(ctx, 504);
      return { ruta, action: actionOut, error: String((err && err.message) || err), buses: [] };
    }
  } catch (err) {
    setStatus(ctx, 500);
    return { error: String((err && err.message) || err) };
  }
});
