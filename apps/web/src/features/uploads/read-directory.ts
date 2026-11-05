import { MAX_FILE_SIZE } from '../../../../../packages/shared/src/contracts';
import { validateFilePath, validatePath } from '../../../../../packages/shared/src/paths';
export type SelectedFile = { file: File; folderPath: string };
export type Selection = { files: SelectedFile[]; paths: string[] };
const join = (a: string, b: string) => [a, b].filter(Boolean).join('/');
export function collectFiles(files: File[], base: string): Selection {
  const result: Selection = { files: [], paths: [] };
  for (const file of files) {
    const relative = file.webkitRelativePath || file.name;
    const folder = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    result.files.push({ file, folderPath: join(base, folder) });
    if (folder) result.paths.push(join(base, folder));
  }
  return validateSelection(result);
}
export async function collectDrop(
  items: DataTransferItemList,
  fallback: FileList,
  base: string,
): Promise<Selection> {
  const entries = Array.from(items)
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return collectFiles(Array.from(fallback), base);
  const result: Selection = { files: [], paths: [] };
  async function visit(entry: FileSystemEntry, parent: string) {
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) =>
        (entry as FileSystemFileEntry).file(ok, fail),
      );
      result.files.push({ file, folderPath: parent });
    } else {
      const path = join(parent, entry.name);
      result.paths.push(path);
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((ok, fail) =>
          reader.readEntries(ok, fail),
        );
        if (!batch.length) break;
        for (const child of batch) await visit(child, path);
      }
    }
  }
  for (const entry of entries) await visit(entry, base);
  return validateSelection(result);
}
export function validateSelection(result: Selection) {
  for (const item of result.files) {
    validateFilePath(item.folderPath, item.file.name);
    if (item.file.size > MAX_FILE_SIZE)
      throw new Error(`${item.file.name} exceeds the 3 GB limit.`);
  }
  result.paths = [...new Set(result.paths.map(validatePath))];
  if (result.paths.length > 10_000)
    throw new Error('Select at most 10,000 folder paths at a time.');
  return result;
}
