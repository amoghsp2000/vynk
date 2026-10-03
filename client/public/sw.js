/* Parley service worker: shows push notifications and routes clicks into the app.
 * Push payloads are intentionally minimal (type + ids + sender name) and never
 * contain message text. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const name = data.sender_name || 'Someone';
  let title = 'Parley';
  let body = 'You have a new notification';
  let url = '/';
  let tag;
  let requireInteraction = false;
  switch (data.type) {
    case 'message':
      title = name;
      body = data.count > 1 ? `${data.count} new messages` : 'New message';
      url = `/chat/${data.conversation_id}`;
      tag = `conv-${data.conversation_id}`;
      break;
    case 'call.incoming':
      title = name;
      body = 'Incoming voice call';
      url = '/';
      tag = `call-${data.call_id}`;
      requireInteraction = true;
      break;
    case 'call.missed':
      title = name;
      body = 'Missed voice call';
      url = '/calls';
      tag = `call-${data.call_id}`;
      break;
  }

  event.waitUntil(
    (async () => {
      // Skip the OS notification if a visible tab is already showing the app.
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (data.type === 'message' && wins.some((w) => w.visibilityState === 'visible')) return;
      await self.registration.showNotification(title, {
        body,
        tag,
        renotify: Boolean(tag),
        requireInteraction,
        icon: '/icon.svg',
        badge: '/icon.svg',
        data: { url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins[0];
      if (win) {
        await win.focus();
        win.postMessage({ type: 'navigate', url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
