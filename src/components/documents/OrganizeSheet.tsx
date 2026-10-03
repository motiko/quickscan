'use client';

import { BottomSheet, sheetIconButton } from '@/components/ui/BottomSheet';
import { FolderIcon, PencilIcon, PlusIcon, TagIcon, TrashIcon } from '@/components/ui/icons';
import type { TagCount } from '@/lib/tags';
import type { Folder } from '@/types';
import {
  confirmDeleteFolder,
  confirmDeleteTag,
  promptCreateFolder,
  promptRenameFolder,
  promptRenameTag,
} from './library-actions';

interface OrganizeSheetProps {
  folders: Folder[];
  folderCounts: Map<string | null, number>;
  tags: TagCount[];
  onClose: () => void;
}

const sectionHeading = 'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';

function countLabel(n: number) {
  return `${n} document${n === 1 ? '' : 's'}`;
}

function Row({
  icon,
  name,
  count,
  kind,
  onRename,
  onDelete,
}: {
  icon: React.ReactNode;
  name: string;
  count: number;
  kind: 'folder' | 'tag';
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-1 pl-4 pr-1">
      <span className="shrink-0 text-gray-400 dark:text-gray-500">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{name}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{countLabel(count)}</p>
      </div>
      <button onClick={onRename} aria-label={`Rename ${kind} ${name}`} title="Rename" className={sheetIconButton}>
        <PencilIcon size={18} />
      </button>
      <button
        onClick={onDelete}
        aria-label={`Delete ${kind} ${name}`}
        title="Delete"
        className={`${sheetIconButton} hover:text-red-600 dark:hover:text-red-400`}
      >
        <TrashIcon size={18} />
      </button>
    </li>
  );
}

/** Create, rename and delete folders; rename and delete tags across all documents. */
export function OrganizeSheet({ folders, folderCounts, tags, onClose }: OrganizeSheetProps) {
  return (
    <BottomSheet title="Folders & tags" onClose={onClose}>
      <section className="py-3">
        <div className="flex items-center justify-between pl-4 pr-2">
          <h3 className={sectionHeading}>Folders</h3>
          <button
            onClick={() => void promptCreateFolder()}
            className="flex h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/60"
          >
            <PlusIcon size={18} />
            New folder
          </button>
        </div>
        {folders.length === 0 ? (
          <p className="px-4 pt-1 text-sm text-gray-500 dark:text-gray-400">
            No folders yet. Documents not in a folder are listed under Unfiled.
          </p>
        ) : (
          <ul aria-label="Folders">
            {folders.map((folder) => (
              <Row
                key={folder.id}
                icon={<FolderIcon size={20} />}
                name={folder.name}
                count={folderCounts.get(folder.id) ?? 0}
                kind="folder"
                onRename={() => void promptRenameFolder(folder)}
                onDelete={() => void confirmDeleteFolder(folder, folderCounts.get(folder.id) ?? 0)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="border-t border-gray-200 dark:border-neutral-800 py-3">
        <h3 className={`${sectionHeading} px-4 py-2`}>Tags</h3>
        {tags.length === 0 ? (
          <p className="px-4 text-sm text-gray-500 dark:text-gray-400">
            No tags yet. Add tags to a document from its page.
          </p>
        ) : (
          <ul aria-label="Tags">
            {tags.map(({ tag, count }) => (
              <Row
                key={tag}
                icon={<TagIcon size={20} />}
                name={tag}
                count={count}
                kind="tag"
                onRename={() => void promptRenameTag(tag)}
                onDelete={() => void confirmDeleteTag(tag, count)}
              />
            ))}
          </ul>
        )}
      </section>
    </BottomSheet>
  );
}
