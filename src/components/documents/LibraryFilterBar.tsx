'use client';

import type { ReactNode } from 'react';
import { FolderIcon, PlusIcon, SlidersIcon, TagIcon } from '@/components/ui/icons';
import type { FolderFilter } from '@/lib/document-filter';
import type { TagCount } from '@/lib/tags';
import { tagKey } from '@/lib/tags';
import type { Folder } from '@/types';

interface LibraryFilterBarProps {
  folders: Folder[];
  folderCounts: Map<string | null, number>;
  totalCount: number;
  tags: TagCount[];
  folder: FolderFilter;
  selectedTags: string[];
  onFolderChange: (folder: FolderFilter) => void;
  onToggleTag: (tag: string) => void;
  onCreateFolder: () => void;
  onOrganize: () => void;
}

function Chip({
  selected,
  onClick,
  children,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      aria-label={label}
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors active:scale-95 ${
        selected
          ? 'bg-blue-600 text-white'
          : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-100 dark:bg-neutral-900 dark:text-gray-200 dark:ring-neutral-800 dark:hover:bg-neutral-800'
      }`}
    >
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="text-xs opacity-70">{n}</span>;
}

const row = 'flex gap-2 overflow-x-auto px-4 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

/** Folder chips (single choice) and tag chips (all selected tags must match) above the gallery. */
export function LibraryFilterBar({
  folders,
  folderCounts,
  totalCount,
  tags,
  folder,
  selectedTags,
  onFolderChange,
  onToggleTag,
  onCreateFolder,
  onOrganize,
}: LibraryFilterBarProps) {
  const selectedTagKeys = new Set(selectedTags.map(tagKey));
  const isFolder = (id: string) => folder.kind === 'folder' && folder.id === id;

  return (
    <div className="pt-3">
      <div className="flex items-center">
        <div role="group" aria-label="Filter by folder" className={`${row} flex-1`}>
          <Chip selected={folder.kind === 'all'} onClick={() => onFolderChange({ kind: 'all' })}>
            All <Count n={totalCount} />
          </Chip>
          {folders.length > 0 && (
            <Chip selected={folder.kind === 'unfiled'} onClick={() => onFolderChange({ kind: 'unfiled' })}>
              Unfiled <Count n={folderCounts.get(null) ?? 0} />
            </Chip>
          )}
          {folders.map((f) => (
            <Chip key={f.id} selected={isFolder(f.id)} onClick={() => onFolderChange({ kind: 'folder', id: f.id })}>
              <FolderIcon size={15} />
              <span className="max-w-[10rem] truncate">{f.name}</span>
              <Count n={folderCounts.get(f.id) ?? 0} />
            </Chip>
          ))}
          <button
            onClick={onCreateFolder}
            className="flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-sm font-medium text-blue-600 dark:text-blue-400 border border-dashed border-blue-300 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-950/60"
          >
            <PlusIcon size={15} />
            New folder
          </button>
        </div>
        <button
          onClick={onOrganize}
          aria-label="Manage folders and tags"
          title="Manage folders and tags"
          className="mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
        >
          <SlidersIcon size={20} />
        </button>
      </div>

      {tags.length > 0 && (
        <div role="group" aria-label="Filter by tag" className={row}>
          {tags.map(({ tag, count }) => (
            <Chip
              key={tag}
              selected={selectedTagKeys.has(tagKey(tag))}
              onClick={() => onToggleTag(tag)}
              label={`Tag ${tag}`}
            >
              <TagIcon size={14} />
              <span className="max-w-[10rem] truncate">{tag}</span>
              <Count n={count} />
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
