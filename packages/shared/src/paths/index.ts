import { caseFold } from 'unicode-case-folding';

export function nameKey(name: string) {
  return caseFold(name.normalize('NFC'));
}
export function validateName(input: string): string {
  const name = input.normalize('NFC');
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u.test(name) ||
    /[ .]$/.test(name)
  )
    throw new Error(
      'Names cannot contain reserved characters, navigation segments, or end with a space or period.',
    );
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\.|$)/iu.test(name))
    throw new Error('This name is reserved by Windows.');
  if (name.length > 255 || new TextEncoder().encode(name).length > 255)
    throw new Error('Names must fit within 255 bytes and 255 characters.');
  return name;
}
export function validatePath(input: string): string {
  if (input === '') return '';
  const segments = input.split('/');
  if (segments.length > 32) throw new Error('Folders cannot exceed 32 levels.');
  const path = segments.map(validateName).join('/');
  if (new TextEncoder().encode(path).length > 1024)
    throw new Error('The full path exceeds 1,024 bytes.');
  return path;
}
export function validateFilePath(path: string, filename: string) {
  const full = [validatePath(path), validateName(filename)].filter(Boolean).join('/');
  if (new TextEncoder().encode(full).length > 1024)
    throw new Error('The full file path exceeds 1,024 bytes.');
  return full;
}
