// Sends the phone's daily totals to the account (PUT /api/totals) so friends can compare.
// Runs on the page (after every drink; the last 30 days once per app start) and in the service worker
// (after the "Log a glass" notification button). Single drinks never leave the phone: one
// (day, ml, goal) per local day does. DOM-free on purpose: only ./api, ./store and shared types.

import type { DayTotal } from '../shared/api';
import { api } from './api';
import { getSettings, localDate, sipsSince, startOfDay } from './store';

export interface SyncTotalsOptions {
  /** Also send the last 30 days (once per app start, and right after signing in). */
  full?: boolean;
}

/** Days before today that `full` covers. With today that is 31 entries at most, the server's limit. */
export const HISTORY_DAYS = 30;

let enabled = true;

/** The page turns this off while nobody is signed in, so sips don't cause 401s. The service worker leaves it on. */
export function setTotalsEnabled(on: boolean): void {
  enabled = on;
}

const int = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(n)));

/** Today's total (always, even at 0 ml) and, with `full`, every earlier day of the last 30 that has a drink. */
export async function dayTotals(full = false, now = Date.now()): Promise<DayTotal[]> {
  const settings = await getSettings();
  const today = localDate(now);
  const since = new Date(startOfDay(now));
  if (full) since.setDate(since.getDate() - HISTORY_DAYS);
  const byDay = new Map<string, number>([[today, 0]]);
  for (const sip of await sipsSince(since.getTime())) {
    const day = localDate(sip.at);
    // A sip stamped after today (clock changes) would make the server refuse the whole batch.
    if (day > today) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + sip.ml);
  }
  const goal_ml = int(settings.goalMl, 1, 50_000);
  return [...byDay]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-(HISTORY_DAYS + 1))
    .map(([day, ml]) => ({ day, ml: int(ml, 0, 100_000), goal_ml }));
}

let pending: Promise<void> | null = null;
let again = false;
let againFull = false;

/**
 * Sends the totals. Coalesces bursts like `syncPush`: calls made while a send is running are answered
 * by one more send afterwards (a full one if any of them asked for it). Failures are logged, not thrown.
 */
export function syncTotals(opts: SyncTotalsOptions = {}): Promise<void> {
  if (!enabled) return Promise.resolve();
  if (pending) {
    again = true;
    againFull ||= opts.full === true;
    return pending;
  }
  let full = opts.full === true;
  pending = (async () => {
    do {
      again = false;
      full ||= againFull;
      againFull = false;
      if (!enabled) break;
      try {
        await api.putTotals({ days: await dayTotals(full) });
      } catch (err) {
        console.warn('syncTotals', err);
      }
      full = false;
    } while (again);
  })().finally(() => {
    pending = null;
  });
  return pending;
}
