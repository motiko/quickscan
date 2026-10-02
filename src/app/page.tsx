'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDocuments, deleteDocument } from '@/hooks/useDocuments';
import { useOcrProgress } from '@/hooks/useProcessing';
import { usePasteImages } from '@/hooks/usePasteImages';
import { ACCEPT_ATTRIBUTE, importFiles } from '@/lib/import';
import { DocumentList } from '@/components/documents/DocumentList';
import { ProcessingBanner } from '@/components/documents/ProcessingBanner';
import { confirmDialog } from '@/lib/dialogs';

export default function Home() {
  const router = useRouter();
  const { documents, isLoading } = useDocuments();
  const [query, setQuery] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { documentIds: processingIds } = useOcrProgress();
  // Each pasted image becomes a new document, like an upload
  usePasteImages((files) => void importFiles(files));

  const openFilePicker = () => fileInputRef.current?.click();

  const handleFiles = (files: FileList | null) => {
    if (files && files.length > 0) void importFiles(Array.from(files));
  };

  const filteredDocuments = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter(
      (d) => d.name.toLowerCase().includes(q) || d.searchText?.includes(q)
    );
  }, [documents, query]);

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
        {documents.length > 0 && (
          <div className="px-4 pb-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search names and text"
              aria-label="Search documents"
              className="w-full rounded-lg bg-gray-100 dark:bg-neutral-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}
      </header>

      <main className="flex-1">
        <ProcessingBanner />
        {query && filteredDocuments.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No documents match “{query}”.
          </p>
        ) : (
          <DocumentList
            documents={filteredDocuments}
            onScanClick={() => router.push('/scan')}
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

      <div className="fixed bottom-safe-offset-6 right-4 z-20 flex gap-3">
        <button
          onClick={openFilePicker}
          className="flex h-12 items-center gap-2 rounded-full bg-white dark:bg-neutral-800 px-5 text-sm font-semibold text-gray-900 dark:text-gray-100 shadow-lg ring-1 ring-black/5 dark:ring-white/10 hover:bg-gray-50 dark:hover:bg-neutral-700 active:bg-gray-100 dark:active:bg-neutral-600"
          aria-label="Upload files"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          Upload
        </button>

        <button
          onClick={() => router.push('/scan')}
          className="flex h-12 items-center gap-2 rounded-full bg-blue-600 px-5 text-sm font-semibold text-white shadow-lg hover:bg-blue-700 active:bg-blue-800"
          aria-label="Scan new document"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
            <circle cx="12" cy="13" r="4"></circle>
          </svg>
          Camera
        </button>
      </div>
    </div>
  );
}
