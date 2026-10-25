/**
 * Types for `novedades.js` — TransMilenio's #TMAhora posts off its X profile
 * page. Hand-written beside the module, as `station_platforms.d.ts` is.
 */

export interface Novedad {
  /** The post's id on X. */
  id: string;
  /** When it was posted (epoch ms). */
  at: number;
  /** The post as written — its emoji lines are already the layout. */
  text: string;
  url: string;
}

export declare const PROFILE_URL: string;
export declare const PROFILE_HEADERS: Record<string, string>;
export declare const KEEP_MS: number;
export declare const BANNER_MAX_AGE_MS: number;
export declare const SEEN_STORAGE_KEY: string;

export declare function bannerPost(items: Novedad[] | undefined, seenAt?: number, now?: number): Novedad | null;

export declare function readTimeline(html: string): { posts: Novedad[]; seen: number };
export declare function extractPosts(html: string): Novedad[];
export declare function postText(text: string): string;
export declare function headline(text: string): string;
export declare function ago(at: number, now?: number): string;
export declare function clock(at: number): string;
