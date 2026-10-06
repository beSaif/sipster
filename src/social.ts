// Sends the phone's daily totals to the account (PUT /api/totals) so friends can compare.
// Runs on the page and in the service worker (after the "Log a glass" notification button).
// TODO(agent D): implement (docs/SOCIAL.md §5 step 6 and §6).

export interface SyncTotalsOptions {
  /** Also send the last 30 days (once per app start, and right after signing in). */
  full?: boolean;
}

let enabled = true;

/** The page turns this off while nobody is signed in, so sips don't cause 401s. The service worker leaves it on. */
export function setTotalsEnabled(on: boolean): void {
  enabled = on;
}

export async function syncTotals(_opts: SyncTotalsOptions = {}): Promise<void> {
  if (!enabled) return;
}
