import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ShieldCheck, FolderLock } from 'lucide-react';
import type { User } from '../../../../../packages/shared/src/contracts';
import { api, json } from '../../lib/api';

const AuthContext = createContext<{
  user: User | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
} | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);
  const logout = async () => {
    await api('/auth/logout', json('POST', {}));
    setUser(null);
  };
  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
export const useAuth = () => useContext(AuthContext)!;
export function SignIn() {
  const { setUser, user } = useAuth(),
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
          <button className="primary wide" disabled={busy}>
            {busy ? 'Please wait…' : rotate ? 'Change password' : 'Sign in'}
          </button>
          <p className="auth-foot">Accounts are managed by your administrator.</p>
        </form>
      </section>
    </div>
  );
}
