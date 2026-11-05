import { expect, it } from 'vitest';
import { filePreview } from '../packages/shared/src/contracts/previews';

it('recognizes supported previews case-insensitively without trusting a MIME type', () => {
  for (const [filename, kind] of [
    ['notes.TXT', 'text'],
    ['README.md', 'markdown'],
    ['Guide.PDF', 'pdf'],
    ['photo.JPG', 'image'],
    ['movie.mp4', 'video'],
    ['clip.webm', 'video'],
  ])
    expect(filePreview(filename)?.kind).toBe(kind);
});
it('keeps active documents and unknown files download-only', () => {
  for (const filename of [
    'index.html',
    'picture.svg',
    'script.js',
    'document.docx',
    'archive.zip',
    'photo.jpg.exe',
    'no-extension',
    'constructor',
    'toString',
  ])
    expect(filePreview(filename)).toBeNull();
});
