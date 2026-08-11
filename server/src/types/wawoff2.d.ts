/**
 * `wawoff2` ships no types. Only `decompress` is used — the site's Inter woff2 is
 * turned back into the TTF that resvg can actually load (see `seo_og.ts`).
 */
declare module 'wawoff2' {
  export function decompress(input: Uint8Array): Promise<Uint8Array>;
  export function compress(input: Uint8Array): Promise<Uint8Array>;
}
