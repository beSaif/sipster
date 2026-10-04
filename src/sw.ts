/// <reference lib="webworker" />
// Sipster service worker: offline app shell, push notifications, and the
// "Log a glass" / "Snooze" buttons on Android notifications.

import { b64urlDecode } from '../worker/webpush';
import { addSip, getSettings } from './store';
import { api, nudgeState, scheduleFrom, syncSubscription } from './sync';

declare const self: ServiceWorkerGlobalScope;

const CACHE = 'sipster-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // Fresh app when online, cached shell when not.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    );
    return;
  }

  // Hashed assets never change; everything else is refreshed in the background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) void cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached ?? Response.error());
      return cached && url.pathname.startsWith('/assets/') ? cached : (cached ?? network);
    }),
  );
});

interface PushMessage {
  type?: 'nudge' | 'test';
  title?: string;
  body?: string;
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let msg: PushMessage = {};
      try {
        msg = event.data?.json() ?? {};
      } catch {
        msg = { body: event.data?.text() };
      }
      const settings = await getSettings();
      const glass = settings.cups[1];
      await self.registration.showNotification(msg.title ?? 'Gerald is thirsty.', {
        body: msg.body ?? 'Have a glass of water — he gets a sip too.',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        tag: 'sipster-nudge',
        renotify: true,
        data: { type: msg.type ?? 'nudge', glass },
        actions:
          msg.type === 'test'
            ? []
            : [
                { action: 'log', title: `Log ${glass} ml` },
                { action: 'snooze', title: 'Snooze 15 min' },
              ],
      } as NotificationOptions);
    })(),
  );
});

async function tellClients(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((c) => c.postMessage({ type: 'sips-changed' }));
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  n.close();
  event.waitUntil(
    (async () => {
      const sub = await self.registration.pushManager.getSubscription();
      if (event.action === 'log') {
        await addSip(n.data?.glass ?? (await getSettings()).cups[1]);
        await tellClients();
        if (sub) await syncSubscription(sub).catch(() => undefined);
        return;
      }
      if (event.action === 'snooze') {
        if (sub) await api('/api/snooze', { endpoint: sub.endpoint, minutes: 15 }).catch(() => undefined);
        return;
      }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) await open.focus();
      else await self.clients.openWindow('/');
    })(),
  );
});

// Browsers occasionally rotate subscriptions; re-register the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  const e = event as Event & { oldSubscription?: PushSubscription | null; newSubscription?: PushSubscription | null };
  (e as ExtendableEvent).waitUntil(
    (async () => {
      const settings = await getSettings();
      if (!settings.pushEnabled) return;
      let sub = e.newSubscription ?? null;
      if (!sub) {
        const { vapidPublicKey } = await api<{ vapidPublicKey: string }>('/api/config');
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlDecode(vapidPublicKey) });
      }
      await api('/api/subscribe', {
        subscription: sub.toJSON(),
        oldEndpoint: e.oldSubscription?.endpoint,
        schedule: scheduleFrom(settings),
        state: await nudgeState(settings),
      });
    })(),
  );
});
