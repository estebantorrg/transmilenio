/** The remembered name, and whether an empty answer from it can still be trusted. */
export function recallLiveName(key: string, now?: number): { name: string; fresh: boolean } | null;
export function rememberLiveName(key: string, name: string): void;
export function forgetLiveName(key: string): void;
