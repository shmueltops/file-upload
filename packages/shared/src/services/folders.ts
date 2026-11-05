import { all, first, run } from '../db/client';
import type { StoredFolder } from '../db/schema';
import { nameKey, validateName, validatePath } from '../paths';
import { AppError, type ServiceBindings } from './types';

export async function listFolders(env: ServiceBindings, userId: string) {
  const rows = await all<StoredFolder>(
    env.DB,
    'SELECT * FROM folders WHERE user_id=? AND deleted_at IS NULL AND delete_requested_at IS NULL',
    userId,
  );
  const byId = new Map(rows.map((f) => [f.id, f]));
  const pathOf = (f: StoredFolder, seen = new Set<string>()): string => {
    if (seen.has(f.id)) throw new Error('Folder cycle detected');
    seen.add(f.id);
    const parent = f.parent_id ? byId.get(f.parent_id) : null;
    return parent ? `${pathOf(parent, seen)}/${f.name}` : f.name;
  };
  return rows.map((f) => ({ ...f, path: pathOf(f) })).sort((a, b) => a.path.localeCompare(b.path));
}
export async function resolvePath(
  env: ServiceBindings,
  userId: string,
  input: string,
  create = false,
): Promise<string | null> {
  const path = validatePath(input);
  if (!path) return null;
  let parent: string | null = null;
  for (const name of path.split('/')) {
    let row: StoredFolder | null = await first(
      env.DB,
      'SELECT * FROM folders WHERE user_id=? AND parent_id IS ? AND name_key=? AND deleted_at IS NULL AND delete_requested_at IS NULL',
      userId,
      parent,
      nameKey(name),
    );
    if (!row && create) {
      const now = Date.now();
      await run(
        env.DB,
        `INSERT INTO folders(id,user_id,parent_id,name,name_key,created_at,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM folders WHERE id=? AND user_id=? AND delete_requested_at IS NULL AND deleted_at IS NULL)
        ON CONFLICT DO NOTHING`,
        crypto.randomUUID(),
        userId,
        parent,
        name,
        nameKey(name),
        now,
        now,
        parent,
        parent,
        userId,
      );
      row = await first(
        env.DB,
        'SELECT * FROM folders WHERE user_id=? AND parent_id IS ? AND name_key=? AND deleted_at IS NULL AND delete_requested_at IS NULL',
        userId,
        parent,
        nameKey(name),
      );
    }
    if (!row) throw new AppError(404, 'Folder not found.');
    if (row.delete_requested_at) throw new AppError(409, 'This folder is being deleted.');
    parent = row.id;
  }
  return parent;
}
export async function ensurePaths(env: ServiceBindings, userId: string, inputs: string[]) {
  const paths = [...new Set(inputs.map(validatePath))].sort(
    (a, b) => a.split('/').length - b.split('/').length,
  );
  for (const path of paths) await resolvePath(env, userId, path, true);
  return listFolders(env, userId);
}
export async function changeFolder(
  env: ServiceBindings,
  userId: string,
  id: string,
  input: { name?: string; destinationParentPath?: string },
) {
  const tree = await listFolders(env, userId),
    current = tree.find((f) => f.id === id);
  if (!current) throw new AppError(404, 'Folder not found.');
  const name = input.name === undefined ? current.name : validateName(input.name);
  const parent =
    input.destinationParentPath === undefined
      ? current.parent_id
      : await resolvePath(env, userId, input.destinationParentPath);
  const parentFolder = tree.find((f) => f.id === parent);
  if (parent === id || parentFolder?.path.startsWith(`${current.path}/`))
    throw new AppError(409, 'A folder cannot be moved inside itself.');
  const newPath = [parentFolder?.path, name].filter(Boolean).join('/');
  for (const f of tree.filter((f) => f.id === id || f.path.startsWith(`${current.path}/`)))
    validatePath(newPath + f.path.slice(current.path.length));
  const contents = await all<{ filename: string; folder_id: string }>(
    env.DB,
    `WITH RECURSIVE subtree(id) AS (SELECT id FROM folders WHERE id=? AND user_id=? UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT filename,folder_id FROM files WHERE folder_id IN (SELECT id FROM subtree) AND deleted_at IS NULL`,
    id,
    userId,
  );
  for (const f of contents) {
    const folder = tree.find((x) => x.id === f.folder_id)!;
    const path = newPath + folder.path.slice(current.path.length);
    if (new TextEncoder().encode(`${path}/${f.filename}`).length > 1024)
      throw new AppError(422, 'This move would make a descendant file path too long.');
  }
  try {
    const result = await run(
      env.DB,
      `UPDATE folders SET name=?,name_key=?,parent_id=?,updated_at=? WHERE id=? AND user_id=? AND delete_requested_at IS NULL AND deleted_at IS NULL
      AND (? IS NULL OR EXISTS(SELECT 1 FROM folders WHERE id=? AND user_id=? AND delete_requested_at IS NULL AND deleted_at IS NULL))
      AND NOT EXISTS(WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id WHERE f.user_id=?) SELECT 1 FROM subtree WHERE id=?)`,
      name,
      nameKey(name),
      parent,
      Date.now(),
      id,
      userId,
      parent,
      parent,
      userId,
      id,
      userId,
      parent,
    );
    if (!result.meta.changes) throw new AppError(409, 'The folder changed. Refresh and try again.');
  } catch (e) {
    if (String(e).includes('UNIQUE'))
      throw new AppError(409, 'A folder with that name already exists here.');
    throw e;
  }
  return listFolders(env, userId);
}
