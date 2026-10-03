import { api } from './api';

/**
 * Web Push: a service worker receives pushes even when no tab is open. The
 * subscription (endpoint + keys) is stored server-side on this device's row.
 */
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js');
}

function b64ToBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function pushState(): Promise<'unsupported' | 'disabled-server' | 'denied' | 'on' | 'off'> {
  if (!pushSupported()) return 'unsupported';
  const cfg = await api<{ webpush: { enabled: boolean } }>('GET', '/api/notifications/config');
  if (!cfg.webpush.enabled) return 'disabled-server';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
}

export async function enablePush() {
  const cfg = await api<{ webpush: { enabled: boolean; public_key: string } }>('GET', '/api/notifications/config');
  if (!cfg.webpush.enabled) throw new Error('Push notifications are not configured on this server');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notification permission was not granted');
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker())!;
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.webpush.public_key) }));
  const json = sub.toJSON();
  await api('PUT', '/api/devices/current/push', {
    provider: 'webpush',
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
  await api('DELETE', '/api/devices/current/push');
}
