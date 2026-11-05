import { X, CheckCircle2, LoaderCircle, ShieldAlert, AlertCircle, Clock3 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { FileStatus } from '../../../../packages/shared/src/contracts';
export function LoadingIndicator({ children }: { children: ReactNode }) {
  return (
    <span className="loading-indicator" role="status">
      <LoaderCircle className="loading-spinner" size={17} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
export function StatusBadge({ status }: { status: FileStatus }) {
  const busy = ['pending', 'uploading', 'scanning', 'processing', 'retrying', 'deleting'].includes(
    status,
  );
  const Icon =
    status === 'done'
      ? CheckCircle2
      : status === 'infected'
        ? ShieldAlert
        : status === 'failed'
          ? AlertCircle
          : busy
            ? LoaderCircle
            : Clock3;
  return (
    <span className={`badge status-${status}`}>
      <Icon size={13} className={busy ? 'loading-spinner' : undefined} aria-hidden="true" />
      {status === 'done' ? 'Done' : status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
export function Modal({
  title,
  children,
  close,
  className = '',
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
