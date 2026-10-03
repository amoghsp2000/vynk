import webpush from 'web-push';
import { env } from '../../config/env.js';

export interface PushTarget {
  deviceId: string;
  provider: 'webpush' | 'fcm' | 'apns';
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
}

export interface PushMessage {
  type: string;
  payload: Record<string, unknown>;
  /** Seconds the push service may hold the message for an offline device. */
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
}

/** 'gone' = the subscription is dead and should be removed from the device. */
export type PushResult = 'ok' | 'gone' | { error: string; retryable: boolean };

export interface PushProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(target: PushTarget, msg: PushMessage): Promise<PushResult>;
}

class WebPushProvider implements PushProvider {
  readonly name = 'webpush';
  readonly enabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

  async send(t: PushTarget, msg: PushMessage): Promise<PushResult> {
    if (!t.p256dh || !t.auth) return 'gone';
    try {
      await webpush.sendNotification(
        { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
        JSON.stringify({ type: msg.type, ...msg.payload }),
        {
          TTL: msg.ttl,
          urgency: msg.urgency,
          vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
          timeout: 10_000,
        },
      );
      return 'ok';
    } catch (err: any) {
      const status = err?.statusCode as number | undefined;
      if (status === 404 || status === 410) return 'gone';
      return { error: status ? `push service HTTP ${status}` : String(err?.code ?? err?.message ?? 'send failed'), retryable: !status || status >= 500 || status === 429 };
    }
  }
}

/** INCOMPLETE: native mobile push. Present so the pipeline is provider-agnostic. */
class NotImplementedProvider implements PushProvider {
  readonly enabled = false;
  constructor(readonly name: string) {}
  async send(): Promise<PushResult> {
    return { error: `${this.name} provider not implemented`, retryable: false };
  }
}

const registry: Record<PushTarget['provider'], PushProvider> = {
  webpush: new WebPushProvider(),
  fcm: new NotImplementedProvider('fcm'),
  apns: new NotImplementedProvider('apns'),
};

export const providerFor = (p: PushTarget['provider']) => registry[p];
export const webPushPublicKey = () => (registry.webpush.enabled ? env.VAPID_PUBLIC_KEY : null);

/** Test seam: swap a provider (e.g. to capture pushes without a real push service). */
export function setProviderForTests(p: PushTarget['provider'], provider: PushProvider) {
  registry[p] = provider;
}
