import { describe, expect, it } from 'vitest';
import {
  clampToWindow,
  inWindow,
  localMinutes,
  nextAfterNudge,
  nextAfterSnooze,
  nextNudgeAt,
  validSchedule,
  type Schedule,
} from '../shared/schedule';

const MIN = 60_000;
const zurich: Schedule = { intervalMin: 60, startMin: 8 * 60, endMin: 22 * 60, tz: 'Europe/Zurich', smart: true };
// 2026-10-04 is CEST (UTC+2).
const at = (hh: number, mm = 0, day = 4) => Date.UTC(2026, 9, day, hh - 2, mm);

describe('localMinutes', () => {
  it('reads wall-clock time in the given zone', () => {
    expect(localMinutes(at(14, 32), 'Europe/Zurich')).toBe(14 * 60 + 32);
    expect(localMinutes(at(14, 32), 'UTC')).toBe(12 * 60 + 32);
  });
});

describe('inWindow', () => {
  it('handles normal, overnight and all-day windows', () => {
    expect(inWindow(9 * 60, 480, 1320)).toBe(true);
    expect(inWindow(22 * 60, 480, 1320)).toBe(false);
    expect(inWindow(23 * 60, 1320, 120)).toBe(true);
    expect(inWindow(60, 1320, 120)).toBe(true);
    expect(inWindow(12 * 60, 1320, 120)).toBe(false);
    expect(inWindow(3 * 60, 0, 0)).toBe(true);
  });
});

describe('clampToWindow', () => {
  it('leaves times inside the window alone', () => {
    expect(clampToWindow(at(10, 15), zurich)).toBe(at(10, 15));
  });

  it('moves early-morning times to the window start the same day', () => {
    expect(clampToWindow(at(6, 30), zurich)).toBe(at(8, 0));
  });

  it('moves late-evening times to tomorrow morning', () => {
    expect(clampToWindow(at(22, 30), zurich)).toBe(at(8, 0, 5));
  });

  it('survives the end of summer time', () => {
    // 2026-10-25 03:00 CEST → 02:00 CET. Late on the 24th should land on 08:00 local on the 25th.
    const late = Date.UTC(2026, 9, 24, 21, 0); // 23:00 CEST
    const result = clampToWindow(late, zurich);
    expect(localMinutes(result, 'Europe/Zurich')).toBe(8 * 60);
    expect(result).toBe(Date.UTC(2026, 9, 25, 7, 0)); // 08:00 CET
  });
});

describe('nextNudgeAt', () => {
  it('counts from now without a sip', () => {
    expect(nextNudgeAt(at(10), zurich)).toBe(at(11));
  });

  it('counts from the last sip in smart mode', () => {
    expect(nextNudgeAt(at(10), zurich, { lastSipAt: at(9, 45) })).toBe(at(10, 45));
  });

  it('never schedules in the past when the last sip was long ago', () => {
    expect(nextNudgeAt(at(10), zurich, { lastSipAt: at(6) })).toBe(at(10, 1));
  });

  it('ignores the last sip when smart mode is off', () => {
    expect(nextNudgeAt(at(10), { ...zurich, smart: false }, { lastSipAt: at(9, 45) })).toBe(at(11));
  });

  it('stays quiet until quietUntil (goal reached)', () => {
    expect(nextNudgeAt(at(15), zurich, { quietUntil: at(0, 0, 5) })).toBe(at(8, 0, 5));
  });
});

describe('nextAfterNudge / nextAfterSnooze', () => {
  it('waits one interval after a nudge, inside the window', () => {
    expect(nextAfterNudge(at(12), zurich)).toBe(at(13));
    expect(nextAfterNudge(at(21, 30), zurich)).toBe(at(8, 0, 5));
  });

  it('snoozes for the requested minutes', () => {
    expect(nextAfterSnooze(at(12), 15, zurich)).toBe(at(12) + 15 * MIN);
  });
});

describe('validSchedule', () => {
  it('accepts a sane schedule and rejects bad ones', () => {
    expect(validSchedule(zurich)).toBe(true);
    expect(validSchedule({ ...zurich, intervalMin: 1 })).toBe(false);
    expect(validSchedule({ ...zurich, tz: 'Mars/Olympus' })).toBe(false);
    expect(validSchedule({ ...zurich, startMin: 2000 })).toBe(false);
    expect(validSchedule(null)).toBe(false);
  });
});
