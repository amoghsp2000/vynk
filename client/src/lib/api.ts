/**
 * HTTP client. The access token lives only in memory; the refresh token is an
 * httpOnly SameSite=Strict cookie the page can't read. Refresh is
 * single-flight per tab and serialised across tabs with the Web Locks API, so
 * two tabs never present the same (rotating) refresh token.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface Me {
  id: string;
  phone_number: string;
  name: string;
  about: string;
  profile_photo_id: string | null;
  privacy?: Privacy;
}

export interface Privacy {
  last_seen: Visibility;
  online: Visibility;
  profile_photo: Visibility;
  about: Visibility;
  status: Visibility;
  read_receipts: boolean;
}
export type Visibility = 'everyone' | 'contacts' | 'nobody';

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  session_id: string;
  device_id: string;
  user: Me;
}

type Listener = (t: TokenResponse | null) => void;

let accessToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<Listener>();

export const auth = {
  get token() {
    return accessToken;
  },
  onChange(fn: Listener) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  set(t: TokenResponse | null) {
    accessToken = t?.access_token ?? null;
    clearTimeout(refreshTimer);
    if (t) {
      localStorage.setItem('parley.device_id', t.device_id);
      // Refresh proactively at ~80% of lifetime.
      refreshTimer = setTimeout(() => void refreshSession(), Math.max(10_000, t.expires_in * 800));
    }
    for (const l of listeners) l(t);
  },
};

export const deviceInfo = () => ({
  device_id: localStorage.getItem('parley.device_id') ?? undefined,
  name: browserName(),
  platform: 'web' as const,
});

function browserName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ` on ${os}` : ''}`;
}

async function raw<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'parley',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

let inflight: Promise<boolean> | null = null;

/** Exchanges the refresh cookie for a new access token. Resolves false if logged out. */
export function refreshSession(): Promise<boolean> {
  inflight ??= (async () => {
    const run = async () => {
      try {
        auth.set(await raw<TokenResponse>('POST', '/api/auth/refresh'));
        return true;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          auth.set(null);
          return false;
        }
        throw err; // network error: keep the session, caller may retry
      }
    };
    return navigator.locks ? navigator.locks.request('parley-refresh', run) : run();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Authenticated request; transparently refreshes once on 401. */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  if (!accessToken) await refreshSession();
  try {
    return await raw<T>(method, path, body, accessToken);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && (await refreshSession())) {
      return raw<T>(method, path, body, accessToken);
    }
    throw err;
  }
}

/** Unauthenticated endpoints (login/register/otp). */
export const publicApi = <T = any>(method: string, path: string, body?: unknown) => raw<T>(method, path, body);

export async function logout() {
  try {
    // Cookie-based logout works even when the access token has expired.
    await raw('POST', '/api/auth/logout');
  } catch {
    // Even if the server is unreachable, drop local credentials.
  }
  auth.set(null);
}
