import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { FolderLock, Files, Activity, Users, LogOut } from 'lucide-react';
import { AuthProvider, SignIn, useAuth } from '../features/auth';
import { UploadProvider, useUploadTasks } from '../features/uploads';
import { FileManager } from '../features/files';
import { AdminJobs, AdminUsers } from '../features/admin';
import { useState } from 'react';
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
function Gate() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="loading-screen">
        <FolderLock size={36} />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!user || user.must_change_password) return <SignIn key={user?.id ?? 'login'} />;
  return (
    <UploadProvider key={user.id}>
      <Shell />
    </UploadProvider>
  );
}
function Shell() {
  const { user, logout } = useAuth(),
    tasks = useUploadTasks(),
    [error, setError] = useState('');
  const uploading = tasks.some((t) => ['uploading', 'queued'].includes(t.state));
  return (
    <>
      <header className="app-header">
        <NavLink to="/drive" className="brand">
          <FolderLock size={25} /> File Vault
        </NavLink>
        <nav aria-label="Main navigation">
          <NavLink to="/drive">
            <Files size={17} /> My files
          </NavLink>
          {user?.role === 'admin' && (
            <>
              <NavLink to="/activity">
                <Activity size={17} /> Activity
              </NavLink>
              <NavLink to="/people">
                <Users size={17} /> People
              </NavLink>
            </>
          )}
        </nav>
        <div className="account">
          <span>
            <strong>{user?.email}</strong>
            <small>{user?.role === 'admin' ? 'Administrator' : 'Personal workspace'}</small>
          </span>
          <button
            className="icon-button"
            aria-label="Sign out"
            disabled={uploading}
            title={uploading ? 'Finish or cancel uploads before signing out' : 'Sign out'}
            onClick={() => void logout().catch((e) => setError(e.message))}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <Routes>
        <Route path="/drive" element={<FileManager />} />
        {user?.role === 'admin' && (
          <>
            <Route path="/activity" element={<AdminJobs />} />
            <Route path="/people" element={<AdminUsers />} />
          </>
        )}
        <Route path="*" element={<Navigate to="/drive" replace />} />
      </Routes>
    </>
  );
}
