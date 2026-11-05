export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
export type PreviewKind = 'text' | 'markdown' | 'pdf' | 'image' | 'video';

const formats: Record<string, { kind: PreviewKind; contentType: string }> = {
  txt: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  log: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  csv: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  json: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  md: { kind: 'markdown', contentType: 'text/plain; charset=utf-8' },
  markdown: { kind: 'markdown', contentType: 'text/plain; charset=utf-8' },
  pdf: { kind: 'pdf', contentType: 'application/pdf' },
  png: { kind: 'image', contentType: 'image/png' },
  jpg: { kind: 'image', contentType: 'image/jpeg' },
  jpeg: { kind: 'image', contentType: 'image/jpeg' },
  gif: { kind: 'image', contentType: 'image/gif' },
  webp: { kind: 'image', contentType: 'image/webp' },
  avif: { kind: 'image', contentType: 'image/avif' },
  bmp: { kind: 'image', contentType: 'image/bmp' },
  mp4: { kind: 'video', contentType: 'video/mp4' },
  m4v: { kind: 'video', contentType: 'video/mp4' },
  webm: { kind: 'video', contentType: 'video/webm' },
  ogv: { kind: 'video', contentType: 'video/ogg' },
  mov: { kind: 'video', contentType: 'video/quicktime' },
};

// User-declared MIME types never grant permission to render active HTML/SVG.
export function filePreview(filename: string) {
  const extension = filename.includes('.') ? filename.split('.').at(-1)!.toLowerCase() : '';
  return Object.hasOwn(formats, extension) ? formats[extension] : null;
}
