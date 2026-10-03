import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, auth, deviceInfo, publicApi, type TokenResponse } from '../lib/api';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">
          <img src="/icon.svg" alt="" />
          <h1>Parley</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

const errText = (e: unknown) =>
  e instanceof ApiError
    ? e.code === 'bad_request' && Array.isArray(e.details)
      ? (e.details as { message: string }[]).map((d) => d.message).join('. ')
      : e.message
    : 'Network error — is the server running?';

export function Login() {
  const nav = useNavigate();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi<{ otp_required: boolean; challenge_id?: string } & Partial<TokenResponse>>('POST', '/api/auth/login', {
        phone_number: phone,
        password,
        device: deviceInfo(),
      });
      if (r.otp_required) nav('/verify', { state: { challengeId: r.challenge_id, phone, purpose: 'login' } });
      else auth.set(r as TokenResponse);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h2>Welcome back</h2>
      <p className="muted small">Log in with your phone number.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="phone">Phone number</label>
          <input id="phone" className="input" inputMode="tel" autoComplete="tel" placeholder="+14155550123" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn block" disabled={busy}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
      <p className="small muted" style={{ marginTop: 18 }}>
        New here? <Link to="/register">Create an account</Link>
      </p>
    </Shell>
  );
}

export function Register() {
  const nav = useNavigate();
  const [form, setForm] = useState({ phone: '', name: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi<{ challenge_id: string }>('POST', '/api/auth/register', {
        phone_number: form.phone,
        name: form.name,
        password: form.password,
      });
      nav('/verify', { state: { challengeId: r.challenge_id, phone: form.phone, purpose: 'register' } });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const upd = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Shell>
      <h2>Create your account</h2>
      <p className="muted small">We'll send a verification code to your phone.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="phone">Phone number</label>
          <input id="phone" className="input" inputMode="tel" autoComplete="tel" placeholder="+14155550123" value={form.phone} onChange={upd('phone')} required />
        </div>
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" className="input" autoComplete="name" maxLength={64} value={form.name} onChange={upd('name')} required />
        </div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" className="input" type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={upd('password')} required />
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn block" disabled={busy}>
          {busy ? 'Sending code…' : 'Send verification code'}
        </button>
      </form>
      <p className="small muted" style={{ marginTop: 18 }}>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </Shell>
  );
}

export function VerifyOtp() {
  const nav = useNavigate();
  const loc = useLocation();
  const st = loc.state as { challengeId: string; phone: string; purpose: string } | null;
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [devAvailable, setDevAvailable] = useState(false);

  useEffect(() => {
    if (!st) nav('/login', { replace: true });
  }, [st, nav]);

  // Development only: the server exposes the mock OTP provider's last code.
  useEffect(() => {
    if (!st) return;
    publicApi<{ code: string }>('GET', `/api/dev/otp?phone_number=${encodeURIComponent(st.phone)}`)
      .then((r) => {
        setDevAvailable(true);
        setDevCode(r.code);
      })
      .catch(() => setDevAvailable(false));
  }, [st]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!st) return;
    setBusy(true);
    setError(null);
    try {
      auth.set(await publicApi<TokenResponse>('POST', '/api/auth/verify-otp', { challenge_id: st.challengeId, code, device: deviceInfo() }));
      nav('/', { replace: true });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h2>Verify your number</h2>
      <p className="muted small">Enter the 6-digit code sent to {st?.phone}.</p>
      <form onSubmit={submit}>
        <div className="field">
          <input
            className="input otp-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            aria-label="Verification code"
            autoFocus
            required
          />
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn block" disabled={busy || code.length !== 6}>
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </form>
      {devAvailable && (
        <div className="dev-hint">
          Development mode: SMS is mocked. Your code is <b>{devCode}</b>{' '}
          <button className="btn secondary" style={{ padding: '4px 10px', marginLeft: 6 }} onClick={() => devCode && setCode(devCode)}>
            Fill
          </button>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 18 }}>
        <Link to={st?.purpose === 'register' ? '/register' : '/login'}>Back</Link>
      </p>
    </Shell>
  );
}
