// Calls the OCI REST API with its HTTP Signature scheme (version 1, RSA-SHA256),
// using only WebCrypto and fetch so the same code runs in a Cloudflare Worker and
// in Node (the tests).
//
// What is signed, in this order: `(request-target) host x-date`, plus
// `x-content-sha256 content-type content-length` when there is a body. `x-date`
// stands in for `date`, which a fetch client may not set itself; `host` and
// `content-length` are sent by the runtime, so they are only computed here to
// sign the values it will send.

const encoder = new TextEncoder();

function base64(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`) → a signing key. */
export async function importKey(pem) {
  const body = pem.replace(/\\n/g, '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * One signed request. `keyId` is `<tenancy ocid>/<user ocid>/<key fingerprint>`;
 * `body` is the JSON text of a POST, absent for a GET.
 */
export async function ociFetch({ key, keyId, method, url, body, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const target = new URL(url);
  const headers = { 'x-date': new Date().toUTCString() };
  const signed = [
    ['(request-target)', `${method.toLowerCase()} ${target.pathname}${target.search}`],
    ['host', target.host],
    ['x-date', headers['x-date']],
  ];
  if (body !== undefined) {
    const bytes = encoder.encode(body);
    headers['content-type'] = 'application/json';
    headers['x-content-sha256'] = base64(await crypto.subtle.digest('SHA-256', bytes));
    signed.push(
      ['x-content-sha256', headers['x-content-sha256']],
      ['content-type', headers['content-type']],
      ['content-length', String(bytes.length)],
    );
  }
  const signingString = signed.map(([name, value]) => `${name}: ${value}`).join('\n');
  const signature = base64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingString)));
  headers.authorization =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
    `headers="${signed.map(([name]) => name).join(' ')}",signature="${signature}"`;
  return fetchImpl(target.toString(), { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
}
