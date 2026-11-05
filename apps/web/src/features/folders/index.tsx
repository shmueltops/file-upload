import { Folder, FolderOpen } from 'lucide-react';
import type { Folder as FolderRecord } from '../../../../../packages/shared/src/contracts';
export function FolderTree({
  folders,
  path,
  navigate,
}: {
  folders: FolderRecord[];
  path: string;
  navigate: (path: string) => void;
}) {
  return (
    <nav className="folder-tree" aria-label="Folder navigation">
      {folders.map((f) => (
        <button
          key={f.id}
          className={path === f.path ? 'tree-item selected' : 'tree-item'}
          style={{ paddingLeft: 14 + (f.path.split('/').length - 1) * 13 }}
          onClick={() => navigate(f.path)}
          title={f.path}
        >
          {path === f.path ? <FolderOpen size={16} /> : <Folder size={16} />}
          <span className="truncate">{f.name}</span>
        </button>
      ))}
    </nav>
  );
}
