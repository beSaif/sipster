// When should Gerald nudge next? Shared by the app (for display) and the push worker.

export interface Schedule {
  /** Minutes between nudges. */
  intervalMin: number;
  /** Active window start, minutes after local midnight. */
  startMin: number;
  /** Active window end, minutes after local midnight (exclusive). May be < startMin for overnight windows. */
  endMin: number;
  /** IANA time zone, e.g. "Europe/Zurich". */
  tz: string;
  /** Count the interval from the last logged sip instead of the last nudge. */
  smart: boolean;
}

export interface NudgeState {
  lastSipAt?: number | null;
  /** No nudges before this instant (e.g. goal reached → tomorrow). */
  quietUntil?: number | null;
}

const MIN = 60_000;
const DAY_MIN = 1440;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Minutes after local midnight in `tz` for instant `t`. */
export function localMinutes(t: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(t));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

export function inWindow(minutes: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true; // 24h
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin; // overnight
}

/** Moves `t` forward to the next moment inside the active window (or leaves it if already inside). */
export function clampToWindow(t: number, s: Pick<Schedule, 'startMin' | 'endMin' | 'tz'>): number {
  // A couple of passes absorb DST shifts that land the first jump an hour off.
  for (let i = 0; i < 3; i++) {
    const m = localMinutes(t, s.tz);
    if (inWindow(m, s.startMin, s.endMin)) return t;
    const wait = (s.startMin - m + DAY_MIN) % DAY_MIN;
    // Land on the start of the minute so nudges fire on the minute.
    t = Math.floor(t / MIN) * MIN + wait * MIN;
  }
  return t;
}

/** Next nudge after a schedule/state change made at `now`. */
export function nextNudgeAt(now: number, s: Schedule, st: NudgeState = {}): number {
  const interval = s.intervalMin * MIN;
  let t = now + interval;
  if (s.smart && st.lastSipAt) t = Math.max(st.lastSipAt + interval, now + MIN);
  if (st.quietUntil && st.quietUntil > t) t = st.quietUntil;
  return clampToWindow(t, s);
}

/** Next nudge after one was just sent at `now`. */
export function nextAfterNudge(now: number, s: Schedule, st: NudgeState = {}): number {
  let t = now + s.intervalMin * MIN;
  if (st.quietUntil && st.quietUntil > t) t = st.quietUntil;
  return clampToWindow(t, s);
}

/** Next nudge after the user snoozed for `minutes` at `now`. */
export function nextAfterSnooze(now: number, minutes: number, s: Schedule): number {
  return clampToWindow(now + minutes * MIN, s);
}

export function validSchedule(s: unknown): s is Schedule {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  return (
    int(o.intervalMin, 15, 24 * 60) &&
    int(o.startMin, 0, DAY_MIN - 1) &&
    int(o.endMin, 0, DAY_MIN - 1) &&
    typeof o.tz === 'string' &&
    o.tz.length < 64 &&
    isValidTimeZone(o.tz) &&
    typeof o.smart === 'boolean'
  );
}
