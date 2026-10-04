'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDocuments, deleteDocument } from '@/hooks/useDocuments';
import { useOcrProgress } from '@/hooks/useProcessing';
import { usePasteImages } from '@/hooks/usePasteImages';
import { ACCEPT_ATTRIBUTE, importFiles } from '@/lib/import';
import { DocumentList } from '@/components/documents/DocumentList';
import { ProcessingBanner } from '@/components/documents/ProcessingBanner';
import { SyncIndicator } from '@/components/documents/SyncIndicator';
import { confirmDialog } from '@/lib/dialogs';
import { LibraryFilterBar } from '@/components/documents/LibraryFilterBar';
import { OrganizeSheet } from '@/components/documents/OrganizeSheet';
import { promptCreateFolder } from '@/components/documents/library-actions';
import { useFolders } from '@/hooks/useLibrary';
import { countByFolder, filterDocuments, type FolderFilter } from '@/lib/document-filter';
import { collectTags, hasTag, tagKey } from '@/lib/tags';
import { cameraHref, startScan } from '@/lib/platform/scanner';
import { useSystemScanner } from '@/hooks/useSystemScanner';

// The folder and tag filter survive visiting a document and coming back, for this tab only
const FILTER_STORAGE_KEY = 'quickscan.galleryFilter';

interface StoredFilter {
  folder: FolderFilter;
  tags: string[];
}

function loadFilter(): StoredFilter {
  const fallback: StoredFilter = { folder: { kind: 'all' }, tags: [] };
  try {
    const raw = typeof window !== 'undefined' ? window.sessionStorage.getItem(FILTER_STORAGE_KEY) : null;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredFilter>;
    const folder = parsed.folder;
    const validFolder =
      folder?.kind === 'all' || folder?.kind === 'unfiled' || (folder?.kind === 'folder' && typeof folder.id === 'string');
    return {
      folder: validFolder ? folder : fallback.folder,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
    };
  } catch {
    return fallback;
  }
}

export default function Home() {
  const router = useRouter();
  const { documents, isLoading } = useDocuments();
  const { folders, isLoading: foldersLoading } = useFolders();
  const [query, setQuery] = useState('');
  const [storedFilter, setStoredFilter] = useState<StoredFilter>(loadFilter);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { documentIds: processingIds } = useOcrProgress();
  const systemScanner = useSystemScanner();
  const scan = () => void startScan(router.push);
  const openCamera = () => router.push(cameraHref());
  // Each pasted image becomes a new document, like an upload
  usePasteImages((files) => void importFiles(files));

  const openFilePicker = () => fileInputRef.current?.click();

  const handleFiles = (files: FileList | null) => {
    if (files && files.length > 0) void importFiles(Array.from(files));
  };

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const folderCounts = useMemo(() => countByFolder(documents, folderIds), [documents, folderIds]);
  const tagCounts = useMemo(() => collectTags(documents), [documents]);

  // Drop a deleted folder or tag from the filter
  const folderFilter = useMemo<FolderFilter>(() => {
    const folder = storedFilter.folder;
    if (foldersLoading) return folder;
    if (folder.kind === 'folder' && !folderIds.has(folder.id)) return { kind: 'all' };
    if (folder.kind === 'unfiled' && folderIds.size === 0) return { kind: 'all' };
    return folder;
  }, [storedFilter.folder, foldersLoading, folderIds]);
  const allTagNames = useMemo(() => tagCounts.map((t) => t.tag), [tagCounts]);
  const selectedTags = useMemo(
    () => storedFilter.tags.filter((t) => hasTag(allTagNames, t)),
    [storedFilter.tags, allTagNames]
  );

  useEffect(() => {
    try {
      window.sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(storedFilter));
    } catch {
      // Storage unavailable (private mode): the filter just isn't remembered
    }
  }, [storedFilter]);

  const filteredDocuments = useMemo(
    () => filterDocuments(documents, { folder: folderFilter, tags: selectedTags, query }, folderIds),
    [documents, folderFilter, selectedTags, query, folderIds]
  );

  const setFolderFilter = (folder: FolderFilter) => setStoredFilter((f) => ({ ...f, folder }));
  const toggleTag = (tag: string) =>
    setStoredFilter((f) => ({
      ...f,
      tags: hasTag(f.tags, tag) ? f.tags.filter((t) => tagKey(t) !== tagKey(tag)) : [...f.tags, tag],
    }));
  const clearFilters = () => {
    setStoredFilter({ folder: { kind: 'all' }, tags: [] });
    setQuery('');
  };
  const isNarrowed = folderFilter.kind !== 'all' || selectedTags.length > 0 || query.trim() !== '';
  const activeFolderName =
    folderFilter.kind === 'folder' ? folders.find((f) => f.id === folderFilter.id)?.name : undefined;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-screen flex-col bg-gray-50 dark:bg-neutral-950 pb-safe-offset-24"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        multiple
        className="hidden"
        data-testid="upload-input"
        onChange={(e) => {
          handleFiles(e.target.files);
          // Allow picking the same files again
          e.target.value = '';
        }}
      />
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-blue-600/10 border-4 border-dashed border-blue-500">
          <p className="rounded-full bg-white dark:bg-neutral-900 px-6 py-3 font-semibold text-blue-600 dark:text-blue-400 shadow-lg">
            Drop images to import
          </p>
        </div>
      )}

      <header className="sticky top-0 left-0 right-0 z-20 bg-white dark:bg-neutral-900 shadow-xs pt-safe dark:shadow-none dark:border-b dark:border-neutral-800">
        <div className="flex h-14 items-center justify-between px-4">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            QuickScan <span role="img" aria-label="camera">📸</span>
          </h1>
          <div className="flex items-center">
            <SyncIndicator />
            <button
              onClick={() => router.push('/settings')}
              className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
              aria-label="Settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </div>
        </div>
        {documents.length > 0 && (
          <div className="px-4 pb-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search names, text and tags"
              aria-label="Search documents"
              className="w-full rounded-lg bg-gray-100 dark:bg-neutral-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-600 dark:placeholder:text-neutral-400 outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}
      </header>

      <main className="flex-1">
        <ProcessingBanner />
        {documents.length > 0 && (
          <LibraryFilterBar
            folders={folders}
            folderCounts={folderCounts}
            totalCount={documents.length}
            tags={tagCounts}
            folder={folderFilter}
            selectedTags={selectedTags}
            onFolderChange={setFolderFilter}
            onToggleTag={toggleTag}
            onCreateFolder={async () => {
              const id = await promptCreateFolder();
              if (id) setFolderFilter({ kind: 'folder', id });
            }}
            onOrganize={() => setIsOrganizing(true)}
          />
        )}
        {documents.length > 0 && filteredDocuments.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            <p>
              {query.trim()
                ? `No documents match “${query}”.`
                : activeFolderName && selectedTags.length === 0
                  ? `“${activeFolderName}” is empty. Open a document and tap its folder to move it here.`
                  : folderFilter.kind === 'unfiled' && selectedTags.length === 0
                    ? 'Every document is in a folder.'
                    : 'No documents match these filters.'}
            </p>
            {isNarrowed && (
              <button
                onClick={clearFilters}
                className="mt-3 rounded-full px-4 py-2 font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/60"
              >
                Show all documents
              </button>
            )}
          </div>
        ) : (
          <DocumentList
            documents={filteredDocuments}
            onScanClick={scan}
            onCameraClick={systemScanner ? openCamera : undefined}
            onUploadClick={openFilePicker}
            processingIds={processingIds}
            onDeleteDocument={async (id: string) => {
              const confirmed = await confirmDialog({
                title: 'Delete this document?',
                message: 'All of its pages are deleted. This can’t be undone.',
                confirmLabel: 'Delete',
                destructive: true,
              });
              if (confirmed) {
                await deleteDocument(id);
              }
            }}
          />
        )}
      </main>

      {isOrganizing && (
        <OrganizeSheet
          folders={folders}
          folderCounts={folderCounts}
          tags={tagCounts}
          onClose={() => setIsOrganizing(false)}
        />
      )}

      {/* Fades the grid out behind the buttons so they don't merge with thumbnails */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-10 h-[calc(env(safe-area-inset-bottom,0px)+6rem)] bg-linear-to-t from-gray-50 via-gray-50/70 to-transparent dark:from-neutral-950 dark:via-neutral-950/70"
      />
      <div className="fixed bottom-safe-offset-6 right-4 z-20 flex gap-3">
        {/* Accessible names are the visible text (WCAG 2.5.3 Label in Name) */}
        <button
          onClick={openFilePicker}
          className="flex h-12 items-center gap-2 rounded-full bg-white dark:bg-neutral-800 px-5 text-sm font-semibold text-gray-900 dark:text-gray-100 shadow-xl shadow-black/20 ring-1 ring-black/10 dark:shadow-black/60 dark:ring-white/15 hover:bg-gray-50 dark:hover:bg-neutral-700 active:bg-gray-100 dark:active:bg-neutral-600"
          title="Upload images"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          Upload
        </button>

        {systemScanner && (
          <button
            onClick={openCamera}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100 shadow-xl shadow-black/20 ring-1 ring-black/10 dark:shadow-black/60 dark:ring-white/15 hover:bg-gray-50 dark:hover:bg-neutral-700 active:bg-gray-100 dark:active:bg-neutral-600"
            aria-label="Use the built-in camera"
            title="Use the built-in camera"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
              <circle cx="12" cy="13" r="4"></circle>
            </svg>
          </button>
        )}

        <button
          onClick={scan}
          className="flex h-12 items-center gap-2 rounded-full bg-blue-600 px-5 text-sm font-semibold text-white shadow-xl shadow-black/25 ring-2 ring-white/90 dark:shadow-black/60 dark:ring-neutral-950 hover:bg-blue-700 active:bg-blue-800"
          title="Scan a new document"
        >
          {systemScanner ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"></path>
              <line x1="7" y1="12" x2="17" y2="12"></line>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
              <circle cx="12" cy="13" r="4"></circle>
            </svg>
          )}
          {systemScanner ? 'Scan' : 'Camera'}
        </button>
      </div>
    </div>
  );
}
