'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { FolderIcon, PlusIcon, SlidersIcon, TagIcon } from '@/components/ui/icons';
import { showUnfiledFilter, type FolderFilter } from '@/lib/document-filter';
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
  muted = false,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  label?: string;
  /** De-emphasized look for an empty folder; it stays selectable. */
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      aria-label={label}
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors active:scale-95 ${
        selected
          ? 'bg-blue-600 text-white'
          : muted
            ? 'bg-white text-gray-400 ring-1 ring-gray-200 hover:bg-gray-100 dark:bg-neutral-900 dark:text-gray-500 dark:ring-neutral-800 dark:hover:bg-neutral-800'
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

/**
 * Folder chips (single choice) and tag chips (all selected tags must match) above the gallery,
 * in one horizontally scrolling row with the "Folders & tags" button pinned on the right.
 */
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
  const unfiledCount = folderCounts.get(null) ?? 0;
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Bring a selected chip that sits past the right edge into view on mount (e.g. coming back from
  // a document with a filter kept). Only the row scrolls horizontally; the page never moves.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const chips = scroller?.querySelectorAll<HTMLElement>('[aria-pressed="true"]');
    if (!scroller || !chips?.length) return;
    const view = scroller.getBoundingClientRect();
    const chip = chips[chips.length - 1].getBoundingClientRect();
    const margin = 16;
    if (chip.right > view.right) scroller.scrollLeft += chip.right - view.right + margin;
    else if (chip.left < view.left) scroller.scrollLeft -= view.left - chip.left + margin;
  }, []);

  return (
    <div className="flex items-center pt-3">
      <div
        ref={scrollerRef}
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto py-1 pl-4 pr-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div role="group" aria-label="Filter by folder" className="flex shrink-0 gap-2">
          <Chip selected={folder.kind === 'all'} onClick={() => onFolderChange({ kind: 'all' })}>
            All <Count n={totalCount} />
          </Chip>
          {showUnfiledFilter({ hasFolders: folders.length > 0, unfiledCount, totalCount, folder }) && (
            <Chip
              selected={folder.kind === 'unfiled'}
              onClick={() => onFolderChange({ kind: 'unfiled' })}
              muted={unfiledCount === 0}
            >
              Unfiled <Count n={unfiledCount} />
            </Chip>
          )}
          {folders.map((f) => {
            const count = folderCounts.get(f.id) ?? 0;
            return (
              <Chip
                key={f.id}
                selected={isFolder(f.id)}
                onClick={() => onFolderChange({ kind: 'folder', id: f.id })}
                muted={count === 0}
              >
                <FolderIcon size={15} />
                <span className="max-w-[10rem] truncate">{f.name}</span>
                <Count n={count} />
              </Chip>
            );
          })}
          <button
            onClick={onCreateFolder}
            className="flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-sm font-medium text-blue-600 dark:text-blue-400 border border-dashed border-blue-300 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-950/60"
          >
            <PlusIcon size={15} />
            New folder
          </button>
        </div>

        {tags.length > 0 && (
          <>
            <div aria-hidden className="mx-1 h-6 w-px shrink-0 bg-gray-300 dark:bg-neutral-700" />
            <div role="group" aria-label="Filter by tag" className="flex shrink-0 gap-2">
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
          </>
        )}
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
  );
}
