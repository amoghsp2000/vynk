import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * ICE server list for a user. TURN uses coturn's "REST API" scheme
 * (use-auth-secret): username = "<expiry>:<userId>", credential =
 * base64(HMAC-SHA1(TURN_SECRET, username)). The shared secret never leaves the
 * server; clients get credentials that expire after TURN_CREDENTIAL_TTL_SECONDS.
 */
export function iceServersFor(userId: string): { ice_servers: IceServer[]; ttl: number } {
  const servers: IceServer[] = [];
  if (env.STUN_URLS.length) servers.push({ urls: env.STUN_URLS });
  if (env.TURN_URLS.length && env.TURN_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + env.TURN_CREDENTIAL_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: env.TURN_URLS, username, credential });
  }
  return { ice_servers: servers, ttl: env.TURN_CREDENTIAL_TTL_SECONDS };
}
