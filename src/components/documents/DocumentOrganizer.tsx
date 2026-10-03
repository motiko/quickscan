'use client';

import { useRef, useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { CheckIcon, CloseIcon, FolderIcon, PlusIcon, TagIcon } from '@/components/ui/icons';
import { useAllTags, useFolders } from '@/hooks/useLibrary';
import { alertDialog } from '@/lib/dialogs';
import { effectiveFolderId } from '@/lib/document-filter';
import { moveDocumentToFolder } from '@/lib/folders';
import {
  addTagToDocument,
  hasTag,
  MAX_TAG_LENGTH,
  normalizeTag,
  removeTagFromDocument,
  suggestTags,
} from '@/lib/tags';
import type { Folder, ScannedDocument } from '@/types';
import { promptCreateFolder } from './library-actions';

function FolderPickerSheet({
  folders,
  currentId,
  onPick,
  onClose,
}: {
  folders: Folder[];
  currentId: string | undefined;
  onPick: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const option = (id: string | null, name: string, icon: React.ReactNode) => {
    const selected = (currentId ?? null) === id;
    return (
      <li key={id ?? 'unfiled'}>
        <button
          onClick={() => onPick(id)}
          aria-pressed={selected}
          className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-sm text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-neutral-800"
        >
          <span className="shrink-0 text-gray-400 dark:text-gray-500">{icon}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          {selected && (
            <span className="text-blue-600 dark:text-blue-400">
              <CheckIcon size={18} />
            </span>
          )}
        </button>
      </li>
    );
  };

  return (
    <BottomSheet title="Move to folder" onClose={onClose}>
      <ul className="py-2">
        {option(null, 'Unfiled', <FolderIcon size={20} />)}
        {folders.map((f) => option(f.id, f.name, <FolderIcon size={20} />))}
        <li>
          <button
            onClick={async () => {
              const id = await promptCreateFolder();
              if (id) onPick(id);
            }}
            className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-sm font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/60"
          >
            <PlusIcon size={20} />
            New folder…
          </button>
        </li>
      </ul>
    </BottomSheet>
  );
}

/** Tags of a document; `leading` (the folder picker) shares their row, so the card stays one line when it can. */
function TagEditor({ document, leading }: { document: ScannedDocument; leading?: React.ReactNode }) {
  const allTags = useAllTags();
  const tags = document.tags ?? [];
  const [isAdding, setIsAdding] = useState(false);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestions = isAdding ? suggestTags(input, allTags, tags) : [];
  const typed = normalizeTag(input);
  // Offer creating what's typed unless it's an existing tag or already on the document
  const canCreate = typed !== '' && !hasTag(allTags, typed) && !hasTag(tags, typed);

  const add = async (raw: string) => {
    if (!normalizeTag(raw)) return;
    // Clear before saving so text typed in the meantime isn't wiped
    setInput('');
    inputRef.current?.focus();
    await addTagToDocument(document.id, raw);
  };

  const close = () => {
    setIsAdding(false);
    setInput('');
  };

  return (
    <div>
      <div className="flex flex-wrap items-start gap-2">
        {leading}
        <ul aria-label="Tags" className="flex min-w-[8rem] flex-1 basis-0 flex-wrap items-center gap-2">
          {tags.map((tag) => (
            <li
              key={tag}
              className="flex h-11 min-w-0 max-w-full items-center rounded-full bg-blue-50 pl-3.5 text-sm font-medium text-blue-800 dark:bg-blue-950/60 dark:text-blue-200"
            >
              <span className="min-w-0 truncate" title={tag}>{tag}</span>
              <button
                onClick={() => void removeTagFromDocument(document.id, tag)}
                aria-label={`Remove tag ${tag}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-blue-100 dark:hover:bg-blue-900"
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
          {!isAdding && (
            <li>
              <button
                onClick={() => {
                  setIsAdding(true);
                  setTimeout(() => inputRef.current?.focus(), 0);
                }}
                className="flex h-11 items-center gap-1.5 rounded-full border border-dashed border-gray-400 px-3.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-800"
              >
                <PlusIcon size={14} />
                Add tag
              </button>
            </li>
          )}
        </ul>
      </div>

      {isAdding && (
        <div className="mt-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add(input);
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => {
                const value = e.target.value;
                // A comma finishes a tag, like Enter
                if (value.includes(',')) {
                  const parts = value.split(',');
                  setInput(parts.pop() ?? '');
                  void (async () => {
                    for (const part of parts) await addTagToDocument(document.id, part);
                  })();
                } else {
                  setInput(value);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault(); // close the editor only, not an open layer
                  close();
                }
              }}
              onBlur={(e) => {
                // Keep the editor open while moving to a suggestion or the Add/Done buttons
                if (e.relatedTarget && e.currentTarget.form?.parentElement?.contains(e.relatedTarget)) return;
                if (!input.trim()) close();
              }}
              aria-label="New tag"
              placeholder="Tag name"
              maxLength={MAX_TAG_LENGTH}
              autoComplete="off"
              enterKeyHint="done"
              className="min-h-11 min-w-0 flex-1 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-2 text-base text-gray-900 dark:text-gray-100 placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              onMouseDown={(e) => e.preventDefault()}
              disabled={!typed}
              className="min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={close}
              className="min-h-11 rounded-xl px-3 text-sm font-semibold text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-800"
            >
              Done
            </button>
          </form>
          {(suggestions.length > 0 || canCreate) && (
            <div role="group" aria-label="Tag suggestions" className="mt-2 flex flex-wrap gap-2">
              {suggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  // Keep focus in the field so its blur doesn't close the editor first (Safari)
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void add(tag)}
                  aria-label={`Add tag ${tag}`}
                  className="flex h-11 items-center gap-1 rounded-full bg-gray-100 px-3.5 text-sm text-gray-800 hover:bg-gray-200 dark:bg-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-700"
                >
                  <TagIcon size={13} />
                  {tag}
                </button>
              ))}
              {canCreate && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void add(typed)}
                  className="flex h-11 items-center gap-1 rounded-full px-3.5 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/60"
                >
                  <PlusIcon size={13} />
                  Create “{typed}”
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Folder and tags of a document, shown on its page. */
export function DocumentOrganizer({ document }: { document: ScannedDocument }) {
  const { folders } = useFolders();
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const folderId = effectiveFolderId(document, new Set(folders.map((f) => f.id)));
  const folderName = folders.find((f) => f.id === folderId)?.name ?? 'Unfiled';

  const pick = async (id: string | null) => {
    setIsPickingFolder(false);
    try {
      await moveDocumentToFolder(document.id, id);
    } catch (err) {
      console.error('Move failed:', err);
      void alertDialog({ title: 'Couldn’t move the document', message: 'Please try again.' });
    }
  };

  return (
    <section aria-label="Folder and tags" className="mb-4 rounded-xl bg-white dark:bg-neutral-900 p-2 ring-1 ring-gray-200 dark:ring-neutral-800">
      <TagEditor
        document={document}
        leading={
          <button
            onClick={() => setIsPickingFolder(true)}
            aria-label={`Folder: ${folderName}. Move to folder`}
            className="flex h-11 min-w-0 max-w-full items-center gap-2 rounded-full bg-gray-100 px-3.5 text-sm font-medium text-gray-800 hover:bg-gray-200 dark:bg-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-700"
          >
            <span className="shrink-0">
              <FolderIcon size={16} />
            </span>
            <span className="min-w-0 truncate">{folderName}</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        }
      />

      {isPickingFolder && (
        <FolderPickerSheet
          folders={folders}
          currentId={folderId}
          onPick={(id) => void pick(id)}
          onClose={() => setIsPickingFolder(false)}
        />
      )}
    </section>
  );
}
