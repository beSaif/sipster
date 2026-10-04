import { b64urlDecode } from '../worker/webpush';
import { pushSupport } from './platform';
import { getSettings, saveSettings } from './store';
import { api, nudgeState, scheduleFrom, syncSubscription } from './sync';

export type EnableResult = 'enabled' | 'denied' | 'needs-install' | 'unsupported' | 'error';

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  return (await registration()).pushManager.getSubscription();
}

/** Asks for permission (must run from a tap), subscribes and registers with the server. */
export async function enablePush(): Promise<EnableResult> {
  const support = pushSupport();
  if (support !== 'supported') return support;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';
    const { vapidPublicKey } = await api<{ vapidPublicKey: string }>('/api/config');
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlDecode(vapidPublicKey) });
    }
    const settings = await getSettings();
    const { nextAt } = await api<{ nextAt: number }>('/api/subscribe', {
      subscription: sub.toJSON(),
      schedule: scheduleFrom(settings),
      state: await nudgeState(settings),
    });
    await saveSettings({ pushEnabled: true, nextNudgeAt: nextAt });
    return 'enabled';
  } catch (err) {
    console.error('enablePush', err);
    return 'error';
  }
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    await api('/api/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => false);
  }
  await saveSettings({ pushEnabled: false, nextNudgeAt: null });
}

let pending: Promise<void> | null = null;
let again = false;

/** Tells the server about new drinks or settings. Coalesces bursts; failures are retried next time. */
export function syncPush(): Promise<void> {
  if (pending) {
    again = true;
    return pending;
  }
  pending = (async () => {
    do {
      again = false;
      try {
        const settings = await getSettings();
        if (!settings.pushEnabled) return;
        const sub = await currentSubscription();
        if (sub) await syncSubscription(sub);
        else await saveSettings({ pushEnabled: false, nextNudgeAt: null });
      } catch (err) {
        console.warn('syncPush', err);
      }
    } while (again);
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export async function sendTestNudge(): Promise<string> {
  const sub = await currentSubscription();
  if (!sub) return 'Nudges are off on this phone.';
  try {
    await api('/api/test', { endpoint: sub.endpoint });
    return 'Sent! Gerald should tap on your screen any second.';
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 429) return 'Gerald needs a moment. Try again in a few seconds.';
    if (status === 404 || status === 410) {
      await saveSettings({ pushEnabled: false, nextNudgeAt: null });
      return 'This phone’s subscription expired. Turn nudges off and on again.';
    }
    return 'Couldn’t reach Gerald’s server. Are you online?';
  }
}
