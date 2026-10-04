// Talks to the push worker. No water amounts leave the phone: only the reminder
// schedule, when the last drink happened, and whether today's goal is done.

import type { NudgeState, Schedule } from '../shared/schedule';
import { getSettings, lastSip, saveSettings, sipsSince, startOfDay, startOfTomorrow, type Settings } from './store';

export function scheduleFrom(s: Settings): Schedule {
  return {
    intervalMin: s.intervalMin,
    startMin: s.startMin,
    endMin: s.endMin,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    smart: s.smart,
  };
}

export async function nudgeState(s: Settings): Promise<NudgeState> {
  const now = Date.now();
  const today = (await sipsSince(startOfDay(now))).reduce((n, sip) => n + sip.ml, 0);
  return {
    lastSipAt: (await lastSip())?.at ?? null,
    quietUntil: today >= s.goalMl ? startOfTomorrow(now) : null,
  };
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
}

/** Sends the current schedule and state for `endpoint`. Re-subscribes if the server forgot us. */
export async function syncSubscription(sub: PushSubscription): Promise<void> {
  const settings = await getSettings();
  const body = { schedule: scheduleFrom(settings), state: await nudgeState(settings) };
  let res: { nextAt: number };
  try {
    res = await api('/api/sync', { endpoint: sub.endpoint, ...body });
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    res = await api('/api/subscribe', { subscription: sub.toJSON(), ...body });
  }
  await saveSettings({ nextNudgeAt: res.nextAt });
}
