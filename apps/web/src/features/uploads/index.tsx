import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  UploadCloud,
  X,
  RotateCcw,
  Check,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  LoaderCircle,
} from 'lucide-react';
import { UploadQueue } from './upload-queue';
import { api, bytes, timeRemaining } from '../../lib/api';
import type { FileRecord } from '../../../../../packages/shared/src/contracts';
export { collectFiles, collectDrop } from './read-directory';
const UploadContext = createContext<UploadQueue | null>(null);
export function UploadProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(() => new UploadQueue());
  const tasks = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const active = tasks.some((t) => ['queued', 'uploading'].includes(t.state));
  const processingIds = tasks
    .filter(
      (t) =>
        t.state === 'transferred' &&
        t.fileId &&
        !['done', 'infected', 'failed', 'deleted'].includes(t.backendStatus ?? ''),
    )
    .map((t) => t.fileId!)
    .join(',');
  useEffect(() => {
    if (!processingIds) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const ids = processingIds.split(',');
        for (let i = 0; i < ids.length; i += 100) {
          const result = await api<{ files: FileRecord[] }>(
            `/files?ids=${ids.slice(i, i + 100).join(',')}`,
          );
          if (!stopped) queue.syncStatuses(result.files);
        }
      } catch {
        /* The next bounded poll retries a temporary connection failure. */
      }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [processingIds, queue]);
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
  return (
    <UploadContext.Provider value={queue}>
      {children}
      <UploadPanel />
    </UploadContext.Provider>
  );
}
export const useUploads = () => useContext(UploadContext)!;
export function useUploadTasks() {
  const q = useUploads();
  return useSyncExternalStore(q.subscribe, q.snapshot);
}
function UploadPanel() {
  const queue = useUploads(),
    tasks = useUploadTasks(),
    [collapsed, setCollapsed] = useState(false),
    [error, setError] = useState('');
  if (!tasks.length) return null;
  const current =
    tasks.find((t) => t.state === 'uploading') ??
    tasks.find((t) => t.state === 'queued') ??
    tasks.at(-1)!;
  const batch = tasks.filter((t) => t.batch === current.batch),
    total = batch.reduce((n, t) => n + t.file.size, 0),
    transferred = batch.reduce((n, t) => n + t.displayed, 0),
    percent = total
      ? Math.min(100, (transferred / total) * 100)
      : batch.every((t) => t.state === 'transferred')
        ? 100
        : 0;
  const active = tasks.some((t) => ['uploading', 'queued'].includes(t.state));
  return (
    <aside className="upload-panel" aria-label="Upload manager">
      <div className="upload-title">
        <UploadCloud size={19} />
        <strong>{active ? 'Uploading your files' : 'Upload summary'}</strong>
        <button
          className="icon-button"
          aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {!active && (
          <button
            className="icon-button"
            aria-label="Clear completed uploads"
            onClick={() => queue.clearFinished()}
          >
            <X size={18} />
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          {batch.length > 1 && (
            <div className="upload-overall">
              <div className="split">
                <span>
                  {batch.filter((t) => t.state === 'transferred').length} of {batch.length} files
                  uploaded
                </span>
                <strong>{Math.floor(percent)}%</strong>
              </div>
              <progress max="100" value={percent} />
              <small>
                {bytes(transferred)} of {bytes(total)}
              </small>
            </div>
          )}
          <div className="upload-rows">
            {tasks.map((t) => (
              <div className="upload-row" key={t.id}>
                <div className="split">
                  <span className="truncate" title={t.file.name}>
                    {t.file.name}
                  </span>
                  {t.state === 'transferred' ? (
                    ['infected', 'failed'].includes(t.backendStatus ?? '') ? (
                      <ShieldAlert size={17} className="error" />
                    ) : !['done', 'deleted'].includes(t.backendStatus ?? '') ? (
                      <LoaderCircle size={17} className="loading-spinner" aria-hidden="true" />
                    ) : (
                      <Check size={17} className="success" />
                    )
                  ) : (
                    <span className="row-actions">
                      {t.state === 'failed' && (
                        <button
                          className="icon-button"
                          aria-label={`Retry ${t.file.name}`}
                          onClick={() => queue.retry(t.id)}
                        >
                          <RotateCcw size={16} />
                        </button>
                      )}
                      {['queued', 'uploading', 'failed'].includes(t.state) && (
                        <button
                          className="icon-button"
                          aria-label={`Cancel ${t.file.name}`}
                          onClick={() => void queue.cancel(t.id).catch((e) => setError(e.message))}
                        >
                          <X size={16} />
                        </button>
                      )}
                    </span>
                  )}
                </div>
                <div className="split">
                  <small
                    role={t.state === 'transferred' ? 'status' : undefined}
                    className={
                      t.state === 'failed' || ['failed', 'infected'].includes(t.backendStatus ?? '')
                        ? 'error'
                        : 'muted'
                    }
                  >
                    {t.error ?? t.operation}
                  </small>
                  {t.state === 'uploading' && (
                    <small className="muted">
                      {t.file.size ? Math.floor((t.displayed / t.file.size) * 100) : 0}%
                    </small>
                  )}
                </div>
                {t.state === 'uploading' && (
                  <>
                    <progress max={Math.max(1, t.file.size)} value={t.displayed} />
                    <small className="muted">
                      {bytes(Math.floor(t.displayed))} of {bytes(t.file.size)}
                      {t.eta !== null && (
                        <>
                          {' '}
                          · {bytes(t.speed)}/s · {timeRemaining(t.eta)}
                        </>
                      )}
                    </small>
                  </>
                )}
              </div>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
        </>
      )}
    </aside>
  );
}
