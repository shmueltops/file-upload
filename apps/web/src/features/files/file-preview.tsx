import { useEffect, useState } from 'react';
import { Download, FileWarning } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileRecord } from '../../../../../packages/shared/src/contracts';
import {
  filePreview,
  MAX_TEXT_PREVIEW_BYTES,
} from '../../../../../packages/shared/src/contracts/previews';
import { LoadingIndicator, Modal } from '../../components';
import { bytes } from '../../lib/api';

export default function FilePreview({ file, close }: { file: FileRecord; close: () => void }) {
  const format = filePreview(file.filename);
  const textFormat = format?.kind === 'text' || format?.kind === 'markdown';
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const url = `/api/files/${encodeURIComponent(file.id)}/content?preview=1`;
  const size = file.actual_size ?? file.expected_size;
  useEffect(() => {
    if (!textFormat) return;
    const controller = new AbortController();
    if (size > MAX_TEXT_PREVIEW_BYTES) {
      setError(
        `This text file is too large to preview (limit ${bytes(MAX_TEXT_PREVIEW_BYTES)}). Download it to read the full file.`,
      );
      setLoading(false);
      return;
    }
    void fetch(url, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || 'This file could not be opened. Try again or download it.');
        }
        return response.text();
      })
      .then(setText)
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [textFormat, url, size]);
  const failed = () => {
    setLoading(false);
    setError('Your browser could not display this file. Download it to open it in another app.');
  };
  return (
    <Modal title={file.filename} close={close} className="file-preview-modal">
      <div className="preview-toolbar">
        <span className="muted">
          {format?.kind === 'markdown'
            ? 'Markdown'
            : format?.kind === 'text'
              ? 'Plain text'
              : format?.kind === 'pdf'
                ? 'PDF document'
                : format?.kind === 'image'
                  ? 'Image'
                  : 'Video'}{' '}
          · {bytes(size)}
        </span>
        <a
          className="preview-download"
          href={`/api/files/${encodeURIComponent(file.id)}/content`}
          download
        >
          <Download size={16} aria-hidden="true" /> Download
        </a>
      </div>
      <div className={`preview-content preview-kind-${format?.kind}`} aria-busy={loading}>
        {loading && !error && (
          <div className="preview-loading">
            <LoadingIndicator>Opening preview…</LoadingIndicator>
          </div>
        )}
        {error ? (
          <div className="preview-error" role="alert">
            <FileWarning size={30} aria-hidden="true" />
            <p>{error}</p>
          </div>
        ) : text !== null ? (
          format?.kind === 'markdown' ? (
            <article className="markdown-preview">
              <Markdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  img: ({ alt }) => <span className="muted">[Image{alt ? `: ${alt}` : ''}]</span>,
                }}
              >
                {text}
              </Markdown>
            </article>
          ) : (
            <pre className="text-preview">{text}</pre>
          )
        ) : format?.kind === 'image' ? (
          <img
            className="preview-image"
            src={url}
            alt={file.filename}
            onLoad={() => setLoading(false)}
            onError={failed}
          />
        ) : format?.kind === 'video' ? (
          <video
            className="preview-video"
            src={url}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={() => setLoading(false)}
            onError={failed}
          >
            Your browser cannot play this video. Use Download to open it in another app.
          </video>
        ) : format?.kind === 'pdf' ? (
          <iframe
            className="preview-pdf"
            src={url}
            title={`Preview of ${file.filename}`}
            onLoad={() => setLoading(false)}
          />
        ) : null}
      </div>
    </Modal>
  );
}
