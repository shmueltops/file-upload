export function putBlob(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  signal: AbortSignal,
  progress: (loaded: number) => void,
) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    const done = () => signal.removeEventListener('abort', abort);
    xhr.upload.onprogress = (e) => progress(e.loaded);
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag') ?? '');
      else
        reject(
          Object.assign(new Error(`Upload request failed (${xhr.status}).`), {
            status: xhr.status,
          }),
        );
    };
    xhr.onerror = () => {
      done();
      reject(new Error('Connection interrupted.'));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
    };
    if (signal.aborted) {
      done();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    xhr.send(body);
  });
}
export function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
