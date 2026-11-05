import { api, json, changed, ApiError } from '../../lib/api';
import {
  PART_SIZE,
  type UploadInfo,
  type FileRecord,
} from '../../../../../packages/shared/src/contracts';
import { putBlob, pause } from './xhr';
import type { Selection } from './read-directory';

export type UploadTask = {
  id: string;
  batch: string;
  file: File;
  folderPath: string;
  fileId?: string;
  info?: UploadInfo;
  backendStatus?: FileRecord['status'];
  state: 'queued' | 'uploading' | 'transferred' | 'failed' | 'cancelled';
  operation: string;
  confirmed: number;
  displayed: number;
  speed: number;
  eta: number | null;
  retry: number;
  error?: string;
};
export class UploadQueue {
  private tasks: UploadTask[] = [];
  private listeners = new Set<() => void>();
  private running = false;
  private controller: AbortController | null = null;
  private current: string | null = null;
  private disposed = false;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.tasks;
  dispose() {
    this.disposed = true;
    this.controller?.abort();
    this.tasks = [];
    this.listeners.clear();
  }
  private emit() {
    this.tasks = [...this.tasks];
    this.listeners.forEach((fn) => fn());
  }
  async add(selection: Selection) {
    if (this.disposed) return;
    await api('/folders/ensure-paths', json('POST', { paths: selection.paths }));
    if (this.disposed) return;
    const batch = crypto.randomUUID();
    this.tasks.push(
      ...selection.files.map(({ file, folderPath }) => ({
        id: crypto.randomUUID(),
        batch,
        file,
        folderPath,
        state: 'queued' as const,
        operation: 'Waiting',
        confirmed: 0,
        displayed: 0,
        speed: 0,
        eta: null,
        retry: 0,
      })),
    );
    changed();
    this.emit();
    void this.drain();
  }
  retry(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.state !== 'failed') return;
    task.state = 'queued';
    task.error = undefined;
    task.operation = 'Waiting';
    this.emit();
    void this.drain();
  }
  clearFinished() {
    this.tasks = this.tasks.filter((t) => ['uploading', 'queued'].includes(t.state));
    this.emit();
  }
  syncStatuses(files: FileRecord[]) {
    for (const file of files) {
      const task = this.tasks.find((t) => t.fileId === file.id);
      if (task?.state === 'transferred') {
        task.backendStatus = file.status;
        task.operation =
          file.status === 'done'
            ? 'Done · ready to download'
            : file.status === 'infected'
              ? `Infected · ${file.block_reason}`
              : file.status === 'failed'
                ? `Failed · ${file.last_error}`
                : file.status.charAt(0).toUpperCase() + file.status.slice(1);
      }
    }
    this.emit();
  }
  async cancel(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || !['queued', 'uploading', 'failed'].includes(task.state)) return;
    task.state = 'cancelled';
    task.operation = 'Cancelled';
    if (this.current === id) this.controller?.abort();
    this.emit();
    if (task.fileId) {
      await api(`/uploads/${task.fileId}`, json('DELETE'));
      changed();
    }
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.disposed) {
        const task = this.tasks.find((t) => t.state === 'queued');
        if (!task) break;
        this.current = task.id;
        const controller = (this.controller = new AbortController());
        task.state = 'uploading';
        this.emit();
        try {
          await this.transfer(task, controller.signal);
          if (!controller.signal.aborted) {
            task.state = 'transferred';
            task.operation = 'Uploaded · checking file';
            task.confirmed = task.displayed = task.file.size;
            changed();
          }
        } catch (e) {
          if (controller.signal.aborted) {
            task.state = 'cancelled';
            task.operation = 'Cancelled';
          } else {
            task.state = 'failed';
            task.operation = 'Upload stopped';
            task.error = (e as Error).message;
          }
        } finally {
          task.eta = null;
          this.emit();
        }
      }
    } finally {
      this.running = false;
      this.current = null;
      this.controller = null;
    }
  }
  private async transfer(task: UploadTask, signal: AbortSignal) {
    if (task.fileId) {
      const { file } = await api<{ file: FileRecord }>(`/files/${task.fileId}`);
      if (!['pending', 'uploading', 'failed'].includes(file.status)) return;
      if (file.status === 'failed') task.info = undefined;
    }
    task.operation = 'Preparing upload';
    this.emit();
    const info =
      task.info ??
      (await api<UploadInfo>(
        '/uploads',
        json('POST', {
          filename: task.file.name,
          size: task.file.size,
          mimeType: task.file.type || 'application/octet-stream',
          folderPath: task.folderPath,
          clientUploadId: task.id,
          ...(task.fileId ? { retryFileId: task.fileId } : {}),
        }),
      ));
    task.info = info;
    task.fileId = info.id;
    if (signal.aborted) {
      await api(`/uploads/${info.id}`, json('DELETE'));
      throw new DOMException('Cancelled', 'AbortError');
    }
    const inFlight = new Map<number, number>();
    let speedStart = performance.now(),
      usefulBytes = task.confirmed;
    const report = (part: number, loaded: number) => {
      inFlight.set(part, loaded);
      const estimated = Math.min(
        task.file.size,
        task.confirmed + [...inFlight.values()].reduce((a, b) => a + b, 0),
      );
      task.displayed = Math.max(task.displayed, Math.min(task.file.size * 0.999, estimated));
      const seconds = (performance.now() - speedStart) / 1000;
      if (seconds > 0.3) task.speed = Math.max(0, (estimated - usefulBytes) / seconds);
      task.eta = task.speed > 0 ? (task.file.size - estimated) / task.speed : null;
      this.emit();
    };
    const send = async (partNumber: number | undefined, blob: Blob) => {
      const index = partNumber ?? 0;
      for (let attempt = 0; attempt <= 5; attempt++) {
        try {
          if (!navigator.onLine) {
            task.operation = 'Reconnecting…';
            task.eta = null;
            this.emit();
            while (!navigator.onLine) await pause(1000, signal);
            speedStart = performance.now();
            usefulBytes = task.confirmed;
          }
          task.retry = attempt;
          task.operation = attempt
            ? `Retrying ${partNumber ? `part ${partNumber}` : 'file'} (${attempt}/5)`
            : partNumber
              ? `Uploading part ${partNumber}`
              : 'Uploading';
          this.emit();
          let signed: { url: string; headers?: Record<string, string> };
          if (partNumber)
            signed = (
              await api<{ parts: { url: string; headers?: Record<string, string> }[] }>(
                `/uploads/${info.id}/parts`,
                json('POST', { generation: info.generation, parts: [partNumber] }),
              )
            ).parts[0];
          else if (attempt) {
            const refreshed = await api<{ upload: UploadInfo | null; file: FileRecord }>(
              `/uploads/${info.id}`,
            );
            if (!refreshed.upload) return '';
            signed = refreshed.upload as { url: string; headers?: Record<string, string> };
          } else signed = info as { url: string; headers?: Record<string, string> };
          const etag = await putBlob(signed.url, blob, signed.headers ?? {}, signal, (loaded) =>
            report(index, loaded),
          );
          inFlight.delete(index);
          task.confirmed += blob.size;
          report(index, 0);
          return etag;
        } catch (e) {
          inFlight.delete(index);
          task.eta = null;
          this.emit();
          if (signal.aborted || (e instanceof ApiError && [401, 404, 409, 422].includes(e.status)))
            throw e;
          if (partNumber) {
            const reconciled = await api<{
              parts: { partNumber: number; etag: string; size: number }[];
            }>(`/uploads/${info.id}`).catch(() => null);
            const part = reconciled?.parts.find(
              (p) => p.partNumber === partNumber && p.size === blob.size,
            );
            if (part) {
              task.confirmed += blob.size;
              report(index, 0);
              return part.etag;
            }
          }
          if (attempt === 5) throw e;
          task.operation = navigator.onLine
            ? `Retrying in ${Math.min(16, 2 ** attempt)}s…`
            : 'Reconnecting…';
          this.emit();
          await pause(Math.min(16_000, 1000 * 2 ** attempt) + Math.random() * 250, signal);
        }
      }
      throw new Error('Upload retry limit reached.');
    };
    const parts: { partNumber: number; etag: string }[] = [];
    if (info.kind === 'single') {
      task.confirmed = 0;
      await send(undefined, task.file);
    } else {
      const existing = await api<{ parts: { partNumber: number; etag: string; size: number }[] }>(
        `/uploads/${info.id}`,
      );
      parts.push(...existing.parts);
      task.confirmed = existing.parts.reduce((n, p) => n + p.size, 0);
      const todo = Array.from(
        { length: Math.ceil(task.file.size / PART_SIZE) },
        (_, i) => i + 1,
      ).filter((n) => !parts.some((p) => p.partNumber === n));
      let next = 0;
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(4, todo.length) }, async () => {
          while (next < todo.length && !signal.aborted) {
            const p = todo[next++];
            const etag = await send(
              p,
              task.file.slice((p - 1) * PART_SIZE, Math.min(p * PART_SIZE, task.file.size)),
            );
            parts.push({ partNumber: p, etag });
          }
        }),
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    }
    task.operation = 'Finalizing upload';
    task.eta = null;
    this.emit();
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await api(
          `/uploads/${info.id}/complete`,
          json('POST', {
            generation: info.generation,
            ...(info.kind === 'multipart'
              ? { parts: parts.sort((a, b) => a.partNumber - b.partNumber) }
              : {}),
          }),
        );
        return;
      } catch (e) {
        if (attempt === 3 || (e instanceof ApiError && e.status !== 409 && e.status < 500)) throw e;
        await pause(1000 * 2 ** attempt, signal);
      }
    }
  }
}
