import { X, CheckCircle2, LoaderCircle, ShieldAlert, AlertCircle, Clock3 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { FileStatus } from '../../../../packages/shared/src/contracts';
export function StatusBadge({ status }: { status: FileStatus }) {
  const Icon =
    status === 'done'
      ? CheckCircle2
      : status === 'infected'
        ? ShieldAlert
        : status === 'failed'
          ? AlertCircle
          : ['scanning', 'processing', 'retrying'].includes(status)
            ? LoaderCircle
            : Clock3;
  return (
    <span className={`badge status-${status}`}>
      <Icon size={13} />
      {status === 'done' ? 'Done' : status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
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
