import { useCallback, useEffect, useState } from 'react';
import {
  UserPlus,
  Users,
  Activity,
  ChevronRight,
  Shield,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import type { FileRecord, User } from '../../../../../packages/shared/src/contracts';
import { api, bytes, date, json } from '../../lib/api';
import { Modal, StatusBadge } from '../../components';

export function AdminUsers() {
  const [users, setUsers] = useState<
      (User & { created_at: number; last_login_at: number | null })[]
    >([]),
    [error, setError] = useState(''),
    [create, setCreate] = useState(false);
  const load = useCallback(
    () =>
      api<{ users: typeof users }>('/admin/users')
        .then((r) => setUsers(r.users))
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <main className="admin-main">
      <div className="page-heading">
        <div>
          <div className="section-icon">
            <Users size={21} />
          </div>
          <h1>People & access</h1>
          <p className="muted">Give your team a private place for their files.</p>
        </div>
        <button className="primary" onClick={() => setCreate(true)}>
          <UserPlus size={17} /> Create user
        </button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Account</th>
              <th>Created</th>
              <th>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="file-name">
                    <span className="avatar">{u.email[0].toUpperCase()}</span>
                    <strong>{u.email}</strong>
                  </div>
                </td>
                <td>
                  <span className={`badge ${u.role === 'admin' ? 'role-admin' : ''}`}>
                    <Shield size={13} />
                    {u.role === 'admin' ? 'Administrator' : 'User'}
                  </span>
                </td>
                <td className="muted">
                  {u.must_change_password ? 'Password change required' : 'Active'}
                </td>
                <td className="muted">{date(u.created_at)}</td>
                <td className="muted">{date(u.last_login_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted footnote">
        Only administrators can create accounts. Each new user changes their initial password on
        first sign-in.
      </p>
      {create && <CreateUser close={() => setCreate(false)} created={() => void load()} />}
    </main>
  );
}
function CreateUser({ close, created }: { close: () => void; created: () => void }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Create user" close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const data = new FormData(e.currentTarget);
          try {
            await api('/admin/users', json('POST', Object.fromEntries(data)));
            created();
            close();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Email address
          <input type="email" name="email" autoComplete="off" required />
        </label>
        <label>
          Initial password
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <small className="muted">
          At least 12 characters. The user must change it on first sign-in.
        </small>
        <label>
          Role
          <select name="role">
            <option value="user">User</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
type Attempt = {
  id: string;
  attempt_number: number;
  result: string;
  provider: string;
  duration_ms: number | null;
  error_details: string | null;
  provider_response: string | null;
  started_at: number;
  finished_at: number | null;
};
export function AdminJobs() {
  const [files, setFiles] = useState<FileRecord[]>([]),
    [counts, setCounts] = useState<{ status: string; count: number }[]>([]),
    [status, setStatus] = useState(''),
    [owner, setOwner] = useState(''),
    [stage, setStage] = useState(''),
    [stuck, setStuck] = useState(false),
    [users, setUsers] = useState<User[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(
    async (append = false, after?: string) => {
      const params = new URLSearchParams({
        ...(status ? { status } : {}),
        ...(owner ? { owner } : {}),
        ...(stage ? { stage } : {}),
        ...(stuck ? { stuck: 'true' } : {}),
        ...(after ? { cursor: after } : {}),
      });
      try {
        const result = await api<{
          files: FileRecord[];
          counts: typeof counts;
          nextCursor: string | null;
        }>(`/admin/jobs?${params}`);
        setFiles((old) => (append ? [...old, ...result.files] : result.files));
        setCounts(result.counts);
        setCursor(result.nextCursor);
        setError('');
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [status, owner, stage, stuck],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api<{ users: User[] }>('/admin/users')
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e.message));
  }, []);
  const active = counts.some(
    (c) =>
      ['pending', 'uploading', 'scanning', 'processing', 'retrying', 'deleting'].includes(
        c.status,
      ) && c.count > 0,
  );
  useEffect(() => {
    if (!active) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await load();
      } finally {
        busy = false;
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [active, load]);
  const count = (...states: string[]) =>
    counts.filter((c) => states.includes(c.status)).reduce((n, c) => n + c.count, 0);
  return (
    <main className="admin-main">
      <div className="page-heading">
        <div>
          <div className="section-icon">
            <Activity size={22} />
          </div>
          <h1>Processing activity</h1>
          <p className="muted">Follow each file from arrival to approval.</p>
        </div>
        <button onClick={() => void load()}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      <div className="simulation-note">
        <Shield size={17} />
        <span>
          Scanner simulation is active. Results demonstrate the workflow and do not provide real
          malware protection.
        </span>
      </div>
      <div className="metric-strip">
        <div>
          <span>In progress</span>
          <strong>{count('pending', 'uploading', 'scanning', 'processing', 'retrying')}</strong>
        </div>
        <div>
          <span>Ready to download</span>
          <strong>{count('done')}</strong>
        </div>
        <div>
          <span>Blocked or failed</span>
          <strong>{count('infected', 'failed')}</strong>
        </div>
        <div>
          <span>Cleanup pending</span>
          <strong>{count('deleting')}</strong>
        </div>
      </div>
      <div className="admin-filters">
        <select
          aria-label="Filter status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {[
            'pending',
            'uploading',
            'scanning',
            'processing',
            'retrying',
            'done',
            'infected',
            'failed',
            'deleting',
            'deleted',
          ].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select aria-label="Filter owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">All owners</option>
          {users.map((u) => (
            <option value={u.id} key={u.id}>
              {u.email}
            </option>
          ))}
        </select>
        <select aria-label="Filter stage" value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {['verify', 'scan', 'promote', 'cleanup', 'complete'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <label className="inline-label">
          <input type="checkbox" checked={stuck} onChange={(e) => setStuck(e.target.checked)} />{' '}
          Expired leases
        </label>
        <span className="muted">{active ? 'Updates every 2.5 seconds' : 'Up to date'}</span>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>File / owner</th>
              <th>Status</th>
              <th>Stage</th>
              <th>Attempts</th>
              <th>Started / last activity</th>
              <th>Last error</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id} className="clickable" onClick={() => setSelected(f.id)}>
                <td>
                  <strong>{f.filename}</strong>
                  <small className="muted">{f.email}</small>
                </td>
                <td>
                  <StatusBadge status={f.status} />
                </td>
                <td>{f.stage}</td>
                <td>{f.scan_attempt_count} / 3</td>
                <td className="muted">
                  {date(f.processing_started_at)}
                  <small>{date(f.last_processed_at)}</small>
                </td>
                <td className="error truncate-cell" title={f.last_error ?? f.block_reason ?? ''}>
                  {f.last_error ?? f.block_reason ?? '—'}
                  {f.lease_expires_at && f.lease_expires_at < Date.now() && (
                    <small>
                      <AlertTriangle size={12} /> Lease expired
                    </small>
                  )}
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={`Inspect ${f.filename}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(f.id);
                    }}
                  >
                    <ChevronRight size={17} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!files.length && (
          <div className="empty-state">
            <h2>No files to show</h2>
            <p>Uploads and processing history will appear here.</p>
          </div>
        )}
      </div>
      {cursor && <button onClick={() => void load(true, cursor)}>Load more activity</button>}
      {selected && <JobDetail id={selected} close={() => setSelected(null)} />}
    </main>
  );
}
function JobDetail({ id, close }: { id: string; close: () => void }) {
  const [file, setFile] = useState<FileRecord | null>(null),
    [attempts, setAttempts] = useState<Attempt[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let stop = false,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [f, a] = await Promise.all([
          api<{ file: FileRecord }>(`/admin/jobs/${id}`),
          api<{ attempts: Attempt[] }>(`/admin/jobs/${id}/attempts`),
        ]);
        if (stop) return;
        setFile(f.file);
        setAttempts(a.attempts);
        if (
          ['pending', 'uploading', 'scanning', 'processing', 'retrying', 'deleting'].includes(
            f.file.status,
          )
        )
          timer = setTimeout(load, 2500);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);
  return (
    <Modal title={file?.filename ?? 'Processing details'} close={close}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {file && (
        <>
          <div className="detail-top">
            <StatusBadge status={file.status} />
            <span>{bytes(file.actual_size ?? file.expected_size)}</span>
          </div>
          <dl className="details">
            <dt>Owner</dt>
            <dd>{file.email}</dd>
            <dt>Stage</dt>
            <dd>{file.stage}</dd>
            <dt>Started</dt>
            <dd>{date(file.processing_started_at)}</dd>
            <dt>Last activity</dt>
            <dd>{date(file.last_processed_at)}</dd>
            <dt>Lease expires</dt>
            <dd>{date(file.lease_expires_at)}</dd>
            <dt>Last error</dt>
            <dd>{file.last_error ?? file.block_reason ?? 'None'}</dd>
            <dt>File ID</dt>
            <dd className="break-word">{id}</dd>
          </dl>
          <h3>Scan attempts</h3>
          {!attempts.length && <p className="muted">No scan has started yet.</p>}
          {attempts.map((a) => (
            <article className="attempt" key={a.id}>
              <div className="split">
                <strong>Attempt {a.attempt_number}</strong>
                <span className={`badge ${a.result === 'clean' ? 'status-done' : ''}`}>
                  {a.result}
                </span>
              </div>
              <p className="muted">
                {date(a.started_at)} · {a.duration_ms ?? '—'} ms
              </p>
              <small>{a.provider}</small>
              {a.error_details && <p className="error">{a.error_details}</p>}
              {a.provider_response && (
                <pre>{JSON.stringify(JSON.parse(a.provider_response), null, 2)}</pre>
              )}
            </article>
          ))}
        </>
      )}
    </Modal>
  );
}
