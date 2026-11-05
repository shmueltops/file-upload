import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ShieldCheck, FolderLock } from 'lucide-react';
import type { User } from '../../../../../packages/shared/src/contracts';
import { api, json } from '../../lib/api';
import {
  isSignedOut,
  rememberSignedOut,
  SESSION_EXPIRED_EVENT,
  SIGNED_OUT_KEY,
} from '../../lib/session';

const AuthContext = createContext<{
  user: User | null;
  loading: boolean;
  loggingOut: boolean;
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
} | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [loggingOut, setLoggingOut] = useState(false);
  const epoch = useRef(0);
  const setUser = (next: User | null) => {
    epoch.current++;
    rememberSignedOut(!next);
    setUserState(next);
  };
  useEffect(() => {
    let disposed = false;
    const started = epoch.current;
    const clear = () => {
      epoch.current++;
      rememberSignedOut(true);
      setUserState(null);
      setLoading(false);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === SIGNED_OUT_KEY && event.newValue === '1') clear();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, clear);
    window.addEventListener('storage', storage);
    if (isSignedOut()) setLoading(false);
    else
      void api<{ user: User }>('/auth/me')
        .then((r) => {
          if (!disposed && epoch.current === started && !isSignedOut()) setUserState(r.user);
        })
        .catch(() => {
          if (!disposed && epoch.current === started) setUserState(null);
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    return () => {
      disposed = true;
      window.removeEventListener(SESSION_EXPIRED_EVENT, clear);
      window.removeEventListener('storage', storage);
    };
  }, []);
  const logout = async () => {
    setUser(null);
    setLoggingOut(true);
    try {
      await api('/auth/logout', { ...json('POST', {}), signal: AbortSignal.timeout(10_000) });
    } catch {
      // The signed-out marker prevents a surviving HttpOnly cookie from restoring the UI.
    } finally {
      setLoggingOut(false);
    }
  };
  return (
    <AuthContext.Provider value={{ user, loading, loggingOut, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
export const useAuth = () => useContext(AuthContext)!;
export function SignIn() {
  const { setUser, user, loggingOut } = useAuth(),
    rotate = !!user?.must_change_password;
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="auth-screen">
      <section className="auth-story">
        <div className="brand">
          <FolderLock size={30} /> File Vault
        </div>
        <div>
          <span className="auth-kicker">A place for every file.</span>
          <h1>
            Keep your work
            <br />
            in good order.
          </h1>
          <p>
            Upload a file or a whole folder. We’ll keep the structure, check the files, and let you
            know when they’re ready.
          </p>
        </div>
        <div className="auth-note">
          <ShieldCheck /> Private storage. Clear status. One workspace.
        </div>
      </section>
      <section className="auth-form">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            setBusy(true);
            const form = new FormData(e.currentTarget);
            try {
              const result = await api<{ user: User }>(
                rotate ? '/auth/change-password' : '/auth/login',
                json(
                  'POST',
                  rotate
                    ? {
                        currentPassword: form.get('currentPassword'),
                        password: form.get('password'),
                      }
                    : { email: form.get('email'), password: form.get('password') },
                ),
              );
              setUser(result.user);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="small-label">Your workspace</span>
          <h2>{rotate ? 'Choose a new password' : 'Welcome back'}</h2>
          <p className="muted">
            {rotate
              ? 'Replace your initial password before opening your files.'
              : 'Sign in with the account provided by your administrator.'}
          </p>
          {rotate ? (
            <label>
              Current password
              <input
                autoComplete="current-password"
                name="currentPassword"
                type="password"
                required
              />
            </label>
          ) : (
            <label>
              Email address
              <input
                autoComplete="username"
                name="email"
                type="email"
                placeholder="you@company.com"
                required
              />
            </label>
          )}
          <label>
            {rotate ? 'New password' : 'Password'}
            <input
              name="password"
              type="password"
              minLength={rotate ? 12 : undefined}
              autoComplete={rotate ? 'new-password' : 'current-password'}
              required
            />
          </label>
          {rotate && <small className="muted">Use at least 12 characters.</small>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary wide" disabled={busy || loggingOut}>
            {loggingOut
              ? 'Signing out…'
              : busy
                ? 'Please wait…'
                : rotate
                  ? 'Change password'
                  : 'Sign in'}
          </button>
          <p className="auth-foot">Accounts are managed by your administrator.</p>
        </form>
      </section>
    </div>
  );
}
