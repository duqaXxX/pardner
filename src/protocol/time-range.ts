export const FIRST_TIME = 1_794_614_400_000; // 2026-11-14T00:00Z, the package design's date: no header with a time is older
export const TIME_TOLERANCE = 86_400_000; // a day of drift between the person's Macs

/** The smallest and largest of the plausible `times` (milliseconds), none when no time is plausible; a loop, since a spread fails on a large epoch. */
export function plausibleRange(times: number[], now: number): { first?: number; last?: number } {
  let first: number | undefined;
  let last: number | undefined;
  for (const t of times) {
    if (t < FIRST_TIME || t > now + TIME_TOLERANCE) continue;
    if (first === undefined || t < first) first = t;
    if (last === undefined || t > last) last = t;
  }
  return first === undefined || last === undefined ? {} : { first, last };
}
