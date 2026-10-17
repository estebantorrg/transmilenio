export interface BogotaClock {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes from Bogotá midnight. */
  minute: number;
}

/** Bogotá's wall clock at `epochMs` (UTC−5 all year). */
export function bogotaClock(epochMs?: number): BogotaClock;
