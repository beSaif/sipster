import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayTotal } from '../shared/api';
import { dayTotals, setTotalsEnabled, syncTotals } from '../src/social';
import { addSip, deleteSipsSince, localDate, saveSettings, startOfDay } from '../src/store';

interface Call {
  url: string;
  method: string | undefined;
  days: DayTotal[];
}

const calls: Call[] = [];
let status = 204;

/** Local noon `days` days before today (DST-safe). */
function noonAgo(days: number): number {
  const d = new Date(startOfDay());
  d.setDate(d.getDate() - days);
  d.setHours(12);
  return d.getTime();
}

beforeEach(async () => {
  calls.length = 0;
  status = 204;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, days: JSON.parse(String(init?.body)).days });
      return new Response(status === 204 ? null : JSON.stringify({ error: { code: 'internal', message: 'nope' } }), { status });
    }),
  );
  setTotalsEnabled(true);
  await deleteSipsSince(0);
  await saveSettings({ goalMl: 2000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncTotals', () => {
  it('sends today’s total and goal', async () => {
    const today = startOfDay();
    await addSip(400, today - 3_600_000); // yesterday: not today's business
    await addSip(250, today + 60_000);
    await addSip(500, today + 120_000);
    await syncTotals();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/totals');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].days).toEqual([{ day: localDate(), ml: 750, goal_ml: 2000 }]);
  });

  it('with full, groups the last 30 days by local day and always includes today', async () => {
    await addSip(300, noonAgo(1));
    await addSip(200, noonAgo(1) + 3_600_000);
    await addSip(1000, noonAgo(10));
    await addSip(100, noonAgo(30));
    await addSip(999, noonAgo(31)); // too old
    await saveSettings({ goalMl: 2500 });
    await syncTotals({ full: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].days).toEqual([
      { day: localDate(noonAgo(30)), ml: 100, goal_ml: 2500 },
      { day: localDate(noonAgo(10)), ml: 1000, goal_ml: 2500 },
      { day: localDate(noonAgo(1)), ml: 500, goal_ml: 2500 },
      { day: localDate(), ml: 0, goal_ml: 2500 },
    ]);
  });

  it('covers exactly today and the 30 days before it', async () => {
    for (let i = 0; i <= 40; i++) await addSip(100, noonAgo(i));
    const days = await dayTotals(true);
    expect(days).toHaveLength(31);
    expect(days[0].day).toBe(localDate(noonAgo(30)));
    expect(days[30].day).toBe(localDate());
    expect(await dayTotals(false)).toHaveLength(1);
  });

  it('skips when disabled', async () => {
    setTotalsEnabled(false);
    await syncTotals({ full: true });
    expect(calls).toHaveLength(0);
  });

  it('coalesces a burst into one send plus one follow-up', async () => {
    await Promise.all([syncTotals(), syncTotals(), syncTotals(), syncTotals()]);
    expect(calls).toHaveLength(2);
    await syncTotals();
    expect(calls).toHaveLength(3);
  });

  it('honours a full request made during a send in the follow-up', async () => {
    await addSip(100, noonAgo(3));
    await Promise.all([syncTotals(), syncTotals({ full: true })]);
    expect(calls).toHaveLength(2);
    expect(calls[0].days.map((d) => d.day)).toEqual([localDate()]);
    expect(calls[1].days.map((d) => d.day)).toEqual([localDate(noonAgo(3)), localDate()]);
  });

  it('swallows server errors with a warning', async () => {
    status = 500;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(syncTotals()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('syncTotals', expect.anything());
    warn.mockRestore();
  });
});
