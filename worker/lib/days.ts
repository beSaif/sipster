// Calendar days as 'YYYY-MM-DD' strings, compared and shifted without time zones: the phone reports
// its local date and everyone is scored by the same calendar date (docs/SOCIAL.md §4).

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC calendar day of a timestamp. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** True for a real calendar date written as 'YYYY-MM-DD' (so not '2026-02-30'). */
export function isDay(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) && utcDay(ms) === s;
}

/** `day` shifted by `n` calendar days (negative for the past). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return utcDay(Date.UTC(y, m - 1, d + n));
}
