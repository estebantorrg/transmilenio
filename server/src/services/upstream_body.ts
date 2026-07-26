/**
 * Bounded reading of an upstream HTTP response body.
 *
 * Every live/card/relay read in this server can travel over a **free public
 * Colombian proxy** (spec §5.2.5) — an untrusted middlebox that is free to answer
 * with an arbitrarily long body or a gzip bomb. The real payloads are a few
 * hundred KB, and the web process runs with a 460 MB heap cap (spec §5.1.3), so
 * both the socket read and the inflate are bounded here rather than in each
 * caller (spec §1.1 R2 — one implementation).
 *
 * It also attaches the `error` listener the streams need: an aborted or reset
 * response with no listener is an unhandled `'error'` event, i.e. a process-level
 * crash, not a rejected promise.
 */

import zlib from 'zlib';
import type { IncomingMessage } from 'http';

/** Ceiling for a single upstream response, raw and inflated alike. */
export const MAX_UPSTREAM_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Buffers `res` up to {@link MAX_UPSTREAM_BODY_BYTES}, rejecting (and destroying
 * the socket) past the cap instead of growing the heap. `label` names the source
 * in the error message.
 */
export function collectBody(res: IncomingMessage, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    res.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPSTREAM_BODY_BYTES) {
        res.destroy();
        reject(new Error(`${label}: response exceeded ${MAX_UPSTREAM_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Inflates a gzip body with a hard output cap; passes non-gzip bodies through. */
export function decodeBody(raw: Buffer, encoding: string | string[] | undefined): Promise<Buffer> {
  const contentEncoding = Array.isArray(encoding) ? encoding.join(',') : encoding || '';
  if (!contentEncoding.toLowerCase().includes('gzip')) return Promise.resolve(raw);

  return new Promise((resolve, reject) => {
    zlib.gunzip(raw, { maxOutputLength: MAX_UPSTREAM_BODY_BYTES }, (err, decompressed) => {
      if (err) reject(err);
      else resolve(decompressed);
    });
  });
}
