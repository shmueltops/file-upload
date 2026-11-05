import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Folder,
  FolderPlus,
  Upload,
  ChevronRight,
  Search,
  Download,
  Trash2,
  Pencil,
  Move,
  Files,
  ShieldCheck,
  RefreshCw,
  ArrowUp,
} from 'lucide-react';
import type {
  FileRecord,
  Folder as FolderRecord,
} from '../../../../../packages/shared/src/contracts';
import { validateName } from '../../../../../packages/shared/src/paths';
import { api, bytes, changed, date, json } from '../../lib/api';
import { collectDrop, collectFiles, useUploads, useUploadTasks } from '../uploads';
import { FolderTree } from '../folders';
import { Modal, StatusBadge } from '../../components';

type Action =
  | { type: 'create' }
  | { type: 'rename'; folder: FolderRecord }
  | { type: 'move'; folder: FolderRecord }
  | { type: 'delete-folder'; folder: FolderRecord }
  | { type: 'delete-file'; file: FileRecord };
export function FileManager() {
  const [params, setParams] = useSearchParams(),
    path = params.get('path') ?? '';
  const [files, setFiles] = useState<FileRecord[]>([]),
    [folders, setFolders] = useState<FolderRecord[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [search, setSearch] = useState(''),
    [action, setAction] = useState<Action | null>(null),
    [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null),
    uploads = useUploads(),
    tasks = useUploadTasks();
  const navigate = (path: string) => {
    setSearch('');
    setParams(path ? { path } : {});
  };
  const refresh = useCallback(async () => {
    try {
      const [f, d] = await Promise.all([
        api<{ files: FileRecord[]; nextCursor: string | null }>(
          `/files?folderPath=${encodeURIComponent(path)}`,
        ),
        api<{ folders: FolderRecord[] }>('/folders'),
      ]);
      setFiles(f.files);
      setNextCursor(f.nextCursor);
      setFolders(d.folders);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    void refresh();
    window.addEventListener('vault:changed', refresh);
    return () => window.removeEventListener('vault:changed', refresh);
  }, [refresh]);
  const processing = files.some((f) =>
    ['pending', 'uploading', 'scanning', 'processing', 'retrying'].includes(f.status),
  );
  useEffect(() => {
    if (!processing) return;
    let fetching = false;
    const timer = setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try {
        await refresh();
      } finally {
        fetching = false;
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [processing, refresh]);
  const current = folders.find((f) => f.path === path),
    children = folders.filter((f) => f.parent_id === (current?.id ?? null) && (!path || current));
  const selectedFolders = children.filter((f) =>
      f.name.toLowerCase().includes(search.toLowerCase()),
    ),
    selectedFiles = files.filter((f) => f.filename.toLowerCase().includes(search.toLowerCase()));
  const locked = (folder: FolderRecord) =>
    tasks.some(
      (t) =>
        ['queued', 'uploading'].includes(t.state) &&
        (t.folderPath === folder.path || t.folderPath.startsWith(`${folder.path}/`)),
    );
  const select = async (list: FileList | null) => {
    if (!list) return;
    try {
      await uploads.add(collectFiles(Array.from(list), path));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="drive-layout">
      <aside className="folder-sidebar">
        <div className="sidebar-heading">
          Folders
          <button
            className="icon-button"
            aria-label="New folder"
            onClick={() => setAction({ type: 'create' })}
          >
            <FolderPlus size={17} />
          </button>
        </div>
        <button className={`tree-item ${!path ? 'selected' : ''}`} onClick={() => navigate('')}>
          <Files size={17} /> All files
        </button>
        <FolderTree folders={folders} path={path} navigate={navigate} />
        <div className="storage-note">
          <ShieldCheck size={20} />
          <strong>Private by default</strong>
          <p>Your files are checked before they become available to download.</p>
        </div>
      </aside>
      <main
        className="file-main"
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          setDrag(false);
          try {
            const selection = await collectDrop(e.dataTransfer.items, e.dataTransfer.files, path);
            await uploads.add(selection);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <div className="breadcrumbs">
          <button onClick={() => navigate('')}>My files</button>
          {path
            .split('/')
            .filter(Boolean)
            .map((segment, i, all) => (
              <span key={i}>
                <ChevronRight size={14} />
                <button onClick={() => navigate(all.slice(0, i + 1).join('/'))}>{segment}</button>
              </span>
            ))}
        </div>
        <div className="page-heading">
          <div>
            <h1>{current?.name ?? 'My files'}</h1>
            <p className="muted">Everything in its place. Ready when you need it.</p>
          </div>
          <div className="actions">
            <button onClick={() => setAction({ type: 'create' })}>
              <FolderPlus size={17} /> New folder
            </button>
            <button onClick={() => folderInput.current?.click()}>
              <Folder size={17} /> Upload folder
            </button>
            <button className="primary" onClick={() => fileInput.current?.click()}>
              <Upload size={17} /> Upload files
            </button>
          </div>
        </div>
        <input
          type="file"
          ref={fileInput}
          multiple
          hidden
          onChange={(e) => {
            void select(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          type="file"
          ref={folderInput}
          multiple
          hidden
          {...{ webkitdirectory: '' }}
          onChange={(e) => {
            void select(e.target.files);
            e.target.value = '';
          }}
        />
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button className="text-button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        <div className="file-toolbar">
          <div className="search-box">
            <Search size={17} />
            <input
              aria-label="Search this folder"
              placeholder="Search this folder"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <span className="muted">
            {children.length} folders · {files.length} files
          </span>
          <button className="icon-button" aria-label="Refresh files" onClick={() => void refresh()}>
            <RefreshCw size={17} />
          </button>
        </div>
        {path && (
          <button
            className="parent-link"
            onClick={() => navigate(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')}
          >
            <ArrowUp size={15} /> Parent folder
          </button>
        )}
        <div className="table-wrap">
          <table className="file-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Size</th>
                <th>Updated</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {selectedFolders.map((f) => (
                <tr key={f.id}>
                  <td>
                    <button className="file-name" onClick={() => navigate(f.path)}>
                      <span className="folder-icon">
                        <Folder size={23} />
                      </span>
                      <strong>{f.name}</strong>
                    </button>
                  </td>
                  <td>
                    <span className="muted">Folder</span>
                  </td>
                  <td>—</td>
                  <td className="muted">{date(f.created_at)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-button"
                        title="Rename folder"
                        aria-label={`Rename ${f.name}`}
                        disabled={locked(f)}
                        onClick={() => setAction({ type: 'rename', folder: f })}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="icon-button"
                        title="Move folder"
                        aria-label={`Move ${f.name}`}
                        disabled={locked(f)}
                        onClick={() => setAction({ type: 'move', folder: f })}
                      >
                        <Move size={16} />
                      </button>
                      <button
                        className="icon-button danger-icon"
                        title="Delete folder"
                        aria-label={`Delete folder ${f.name}`}
                        disabled={locked(f)}
                        onClick={() => setAction({ type: 'delete-folder', folder: f })}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {selectedFiles.map((f) => (
                <tr key={f.id}>
                  <td>
                    <div className="file-name">
                      <span className="document-icon">
                        <Files size={21} />
                      </span>
                      <div className="min-width">
                        <strong className="truncate">{f.filename}</strong>
                        {(f.block_reason || f.last_error) && (
                          <small
                            className="error truncate"
                            title={f.block_reason ?? f.last_error ?? ''}
                          >
                            {f.block_reason ?? f.last_error}
                          </small>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={f.status} />
                  </td>
                  <td>{bytes(f.actual_size ?? f.expected_size)}</td>
                  <td className="muted">{date(f.updated_at)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-button"
                        disabled={f.status !== 'done'}
                        title="Download approved file"
                        aria-label={`Download ${f.filename}`}
                        onClick={async () => {
                          try {
                            const { url } = await api<{ url: string }>(`/files/${f.id}/download`);
                            window.location.assign(url);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        <Download size={16} />
                      </button>
                      <button
                        className="icon-button danger-icon"
                        aria-label={`Delete file ${f.filename}`}
                        onClick={() => setAction({ type: 'delete-file', file: f })}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading ? (
          <div className="empty-state">
            <p>Loading your files…</p>
          </div>
        ) : (
          !selectedFiles.length &&
          !selectedFolders.length && (
            <div className="empty-state">
              <div className="empty-folder">
                <Folder size={42} strokeWidth={1.3} />
              </div>
              <h2>{search ? 'No matching files' : 'Make room for your work'}</h2>
              <p>
                {search
                  ? 'Try another name in this folder.'
                  : 'Drop files or a whole folder here to get started.'}
              </p>
              {!search && (
                <button className="text-button" onClick={() => fileInput.current?.click()}>
                  Choose files to upload
                </button>
              )}
            </div>
          )
        )}
        {nextCursor && (
          <button
            onClick={async () => {
              try {
                const result = await api<{ files: FileRecord[]; nextCursor: string | null }>(
                  `/files?folderPath=${encodeURIComponent(path)}&cursor=${nextCursor}`,
                );
                setFiles([...files, ...result.files]);
                setNextCursor(result.nextCursor);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Load more files
          </button>
        )}
        <div className="drop-hint">
          <Upload size={16} />
          <span>Drop files or folders anywhere here</span>
          <span className="muted">Up to 3 GB per file</span>
        </div>
        {drag && (
          <div className="drop-overlay">
            <Upload size={40} />
            <h2>Drop into {current?.name ?? 'My files'}</h2>
            <p>Folder structure stays intact.</p>
          </div>
        )}
      </main>
      {action && (
        <FolderFileDialog
          action={action}
          path={path}
          folders={folders}
          close={() => setAction(null)}
        />
      )}
    </div>
  );
}
function FolderFileDialog({
  action,
  path,
  folders,
  close,
}: {
  action: Action;
  path: string;
  folders: FolderRecord[];
  close: () => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const name =
    'folder' in action ? action.folder.name : 'file' in action ? action.file.filename : '';
  const deleting = action.type.startsWith('delete');
  const titles = {
    create: 'New folder',
    rename: 'Rename folder',
    move: 'Move folder',
    'delete-folder': 'Delete folder',
    'delete-file': 'Delete file',
  };
  return (
    <Modal title={titles[action.type]} close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          const data = new FormData(e.currentTarget);
          try {
            if (action.type === 'create') {
              const n = validateName(String(data.get('name')));
              await api('/folders', json('POST', { path: [path, n].filter(Boolean).join('/') }));
            } else if (action.type === 'rename')
              await api(
                `/folders/${action.folder.id}`,
                json('PATCH', { name: validateName(String(data.get('name'))) }),
              );
            else if (action.type === 'move')
              await api(
                `/folders/${action.folder.id}`,
                json('PATCH', { destinationParentPath: data.get('path') }),
              );
            else if (action.type === 'delete-folder')
              await api(`/folders/${action.folder.id}`, json('DELETE'));
            else await api(`/files/${action.file.id}`, json('DELETE'));
            changed();
            close();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {deleting ? (
          <>
            <p>
              Delete <strong>{name}</strong>?
            </p>
            <p className="muted">
              {action.type === 'delete-folder'
                ? 'All nested files and folders will also be deleted. '
                : ''}
              Access stops immediately. Storage cleanup may take a few minutes.
            </p>
            {action.type === 'delete-folder' && (
              <ul className="delete-preview">
                {folders
                  .filter((f) => f.path.startsWith(`${action.folder.path}/`))
                  .slice(0, 8)
                  .map((f) => (
                    <li key={f.id}>{f.path}</li>
                  ))}
              </ul>
            )}
          </>
        ) : action.type === 'move' ? (
          <label>
            Destination folder
            <select name="path" defaultValue="">
              <option value="">My files (root)</option>
              {folders
                .filter(
                  (f) => f.id !== action.folder.id && !f.path.startsWith(`${action.folder.path}/`),
                )
                .map((f) => (
                  <option key={f.id} value={f.path}>
                    {f.path}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <label>
            Folder name
            <input
              name="name"
              autoFocus
              required
              defaultValue={action.type === 'rename' ? name : ''}
              maxLength={255}
            />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className={deleting ? 'danger' : 'primary'} disabled={busy}>
            {busy
              ? 'Working…'
              : deleting
                ? 'Delete'
                : action.type === 'move'
                  ? 'Move folder'
                  : action.type === 'create'
                    ? 'Create folder'
                    : 'Save name'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
