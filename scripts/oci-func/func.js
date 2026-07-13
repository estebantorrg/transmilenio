'use strict';

/**
 * TransMilenio live-bus relay — OCI Function (sa-bogota-1, Colombian egress).
 *
 * Fronted by an OCI API Gateway so the Render backend can reach it as a plain
 * HTTPS relay. Speaks the contract the server's `co-relay` tier already sends
 * (see server/src/services/tm_api.ts → buildColombiaRelayBody):
 *
 *   POST <gateway>/buses
 *   body: { action: 'zonal'|'troncal', ruta, nombre, Nombre, type }
 *   optional header: Authorization: Bearer <RELAY_SECRET>
 *
 * Egresses (NAT gateway, Bogotá IP) to the official TransMi live host, which
 * geofences non-Colombian IPs. Returns { ruta, action, upstreamStatus, buses }.
 *
 * Defensive on the fdk ctx: header/status accessors differ between the base
 * context (direct `fn invoke`) and the HTTP-gateway context (API Gateway), and
 * calling a missing method crashes the whole invocation → 502. Every ctx access
 * is therefore guarded; the function always returns a JSON body.
 */

const fdk = require('@fnproject/fdk');
const https = require('https');

const LIVE_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
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
    // Header bags exposed as objects (reqHeaders / headers): values may be arrays.
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

function upstreamRequest(path, postData) {
  const headers = { ...UPSTREAM_HEADERS };
  if (postData) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    headers['Content-Length'] = Buffer.byteLength(postData);
  } else {
    headers['Content-Length'] = 0;
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: LIVE_HOST, path, method: 'POST', headers, timeout: UPSTREAM_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let payload = null;
          try { payload = JSON.parse(text); } catch (e) { /* leave null */ }
          resolve({ status: res.statusCode, payload });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
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
        return { error: 'forbidden', buses: [] };
      }
    }

    // API Gateway delivers the JSON body as `input` (object) or a raw string.
    let body = input;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

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
      const { status, payload } = await upstreamRequest(path, postData);
      if (status !== 200) setStatus(ctx, 502);
      return { ruta, action: actionOut, upstreamStatus: status, buses: extractBuses(payload) };
    } catch (err) {
      setStatus(ctx, 504);
      return { ruta, action: actionOut, error: String((err && err.message) || err), buses: [] };
    }
  } catch (err) {
    // Last-resort guard: never let the handler throw (that becomes a 502).
    setStatus(ctx, 500);
    return { error: String((err && err.message) || err), buses: [] };
  }
});
