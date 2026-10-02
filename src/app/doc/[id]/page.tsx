'use client';

import { useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  useDocument,
  deleteDocument,
  renameDocument,
  deletePage,
  updatePage,
  savePageAnnotations,
} from '@/hooks/useDocuments';
import { generatePdf, pagesToPdfInput, shareOrDownload, shareImage, downloadBlob } from '@/lib/pdf';
import { rotateImage } from '@/lib/image-processing';
import { useRenderedPageUrl } from '@/hooks/useRenderedPageUrl';
import { useSettings } from '@/hooks/useSettings';
import { usePasteImages } from '@/hooks/usePasteImages';
import { importPagesToDocument } from '@/lib/import';
import { TextSheet } from '@/components/documents/TextSheet';
import { LiveTextIcon } from '@/components/ui/LiveTextIcon';
import { suggestDocumentName } from '@/lib/naming';
import { collectDocumentText } from '@/lib/ocr-text';
import { getImageSize, getRenderedBlob } from '@/lib/annotations/flatten';
import { rotateAnnotations90 } from '@/lib/annotations/geometry';
import { AnnotationEditor } from '@/components/annotate/AnnotationEditor';
import { Annotation, Page } from '@/types';

function PageItem({
  page,
  index,
  onClick,
}: {
  page: Page;
  index: number;
  onClick: (page: Page) => void;
}) {
  const url = useRenderedPageUrl(page);

  return (
    <div
      className="relative aspect-[3/4] overflow-hidden rounded-xl bg-gray-200 dark:bg-neutral-800 shadow-sm hover:shadow-md cursor-pointer transition-shadow"
      onClick={() => url && onClick(page)}
    >
      {url ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={url}
          alt={`Page ${index + 1}`}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-gray-300 dark:bg-neutral-700" />
      )}
      <div className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2.5 py-0.5 text-xs font-semibold text-white backdrop-blur-sm">
        {index + 1}
      </div>
    </div>
  );
}

export default function DocumentViewer() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const { document, pages, isLoading } = useDocument(id);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isUpdatingPage, setIsUpdatingPage] = useState(false);
  const [showText, setShowText] = useState(false);
  const [showDocumentText, setShowDocumentText] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isAddingPages, setIsAddingPages] = useState(false);
  const { settings } = useSettings();
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedPage = selectedPageId ? pages.find((p) => p.id === selectedPageId) ?? null : null;
  const selectedPageUrl = useRenderedPageUrl(selectedPage);

  // Pasted images are appended as new pages; ignored while a page is open in the viewer
  usePasteImages(async (files) => {
    setIsAddingPages(true);
    try {
      const failures = await importPagesToDocument(id, files);
      if (failures.length > 0) {
        alert(`Couldn’t add ${failures.map((f) => `${f.fileName} (${f.reason})`).join(', ')}`);
      }
    } finally {
      setIsAddingPages(false);
    }
  }, !!document && !selectedPage);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-neutral-950">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Loading document...</p>
        </div>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4 bg-gray-50 dark:bg-neutral-950">
        <p className="mb-4 text-lg font-medium text-gray-700 dark:text-gray-300">Document not found</p>
        <button
          onClick={() => router.push('/')}
          className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-blue-700"
        >
          Return Home
        </button>
      </div>
    );
  }

  const handleNameClick = () => {
    setEditName(document.name);
    setIsEditingName(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleNameSubmit = async () => {
    if (editName.trim() && editName !== document.name) {
      await renameDocument(id, editName.trim());
    }
    setIsEditingName(false);
  };

  const handleSuggestName = async () => {
    if (isSuggesting) return;
    setIsSuggesting(true);
    try {
      const suggestion = await suggestDocumentName(id);
      if (!suggestion) {
        alert('No recognized text yet, so a name can’t be suggested.');
        return;
      }
      // Pre-fill the rename field; the user confirms with Enter like a normal rename
      setEditName(suggestion.name);
      setIsEditingName(true);
      setTimeout(() => inputRef.current?.select(), 50);
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleNameSubmit();
    if (e.key === 'Escape') setIsEditingName(false);
  };

  const handleDelete = async () => {
    if (window.confirm('Are you sure you want to delete this entire document?')) {
      await deleteDocument(id);
      router.push('/');
    }
  };

  const handleExport = async (mode: 'share' | 'download') => {
    if (pages.length === 0 || isExporting) return;
    setIsExporting(true);
    try {
      const pdfBlob = await generatePdf(await pagesToPdfInput(pages, getRenderedBlob));
      if (mode === 'download') {
        downloadBlob(pdfBlob, `${document.name}.pdf`);
      } else {
        await shareOrDownload(pdfBlob, `${document.name}.pdf`, document.name);
      }
    } catch (err) {
      console.error('Export failed:', err);
      alert('Failed to export PDF.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyAllText = async () => {
    const text = collectDocumentText(pages);
    if (!text) {
      alert('No recognized text yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const closePageViewer = () => {
    setSelectedPageId(null);
    setShowText(false);
    setIsAnnotating(false);
  };

  const handleRotateCurrentPage = async () => {
    if (!selectedPage || isUpdatingPage) return;
    setIsUpdatingPage(true);
    try {
      const currentBlob = selectedPage.processedBlob || selectedPage.originalBlob;
      const [rotatedBlob, size] = await Promise.all([rotateImage(currentBlob, 90), getImageSize(currentBlob)]);
      await updatePage(selectedPage.id, { processedBlob: rotatedBlob });
      // Keep annotations aligned with the rotated image (also refreshes the thumbnail for page 1)
      await savePageAnnotations(
        selectedPage.id,
        rotateAnnotations90(selectedPage.annotations ?? [], size.width, size.height)
      );
    } catch (err) {
      console.error('Failed to rotate page:', err);
    } finally {
      setIsUpdatingPage(false);
    }
  };

  const handleShareCurrentPage = async () => {
    if (!selectedPage) return;
    try {
      const currentBlob = await getRenderedBlob(selectedPage);
      await shareImage(
        currentBlob,
        `${document.name}_Page_${selectedPage.pageNumber}.${currentBlob.type === 'image/png' ? 'png' : 'jpg'}`,
        `${document.name} - Page ${selectedPage.pageNumber}`
      );
    } catch (err) {
      console.error('Failed to share page:', err);
    }
  };

  const handleDeleteCurrentPage = async () => {
    if (!selectedPage) return;
    if (window.confirm(`Delete page ${selectedPage.pageNumber}?`)) {
      await deletePage(selectedPage.id);
      closePageViewer();
    }
  };

  const handleSaveAnnotations = async (annotations: Annotation[]) => {
    if (!selectedPage) return;
    try {
      await savePageAnnotations(selectedPage.id, annotations);
      setIsAnnotating(false);
    } catch (err) {
      console.error('Failed to save annotations:', err);
      alert('Failed to save annotations.');
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 dark:bg-neutral-950 pb-safe-offset-6">
      {/* Top Header */}
      <header className="sticky top-0 z-30 bg-white dark:bg-neutral-900 px-4 shadow-xs pt-safe dark:shadow-none dark:border-b dark:border-neutral-800">
        <div className="flex h-16 items-center justify-between gap-3">
          <button
            onClick={() => router.push('/')}
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-neutral-800 active:bg-gray-200 dark:active:bg-neutral-700"
            aria-label="Back to gallery"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            {isEditingName ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleNameSubmit}
                onKeyDown={handleNameKeyDown}
                className="w-full rounded-lg border border-blue-500 bg-white dark:bg-neutral-900 px-2.5 py-1 text-base font-semibold text-gray-900 dark:text-gray-100 outline-none"
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1">
                <h1
                  onClick={handleNameClick}
                  className="truncate text-base font-bold text-gray-900 dark:text-gray-100 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  title="Click to rename"
                >
                  {document.name}
                </h1>
                <button
                  onClick={handleSuggestName}
                  disabled={isSuggesting}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 disabled:opacity-50"
                  aria-label="Suggest name"
                  title="Suggest a name from the document text"
                >
                  {isSuggesting ? (
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zm7 11l.9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9L19 13zM6 15l.7 1.6L8.3 17.3l-1.6.7L6 19.6l-.7-1.6L3.7 17.3l1.6-.7L6 15z" />
                    </svg>
                  )}
                </button>
              </div>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {pages.length} page{pages.length !== 1 ? 's' : ''} • Tap title to rename
            </p>
          </div>

          <button
            onClick={handleCopyAllText}
            className="flex h-9 items-center justify-center rounded-full px-2.5 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
            aria-label="Copy all text"
            title="Copy all text"
          >
            {copiedAll ? (
              'Copied'
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            )}
          </button>

          <button
            onClick={() => handleExport('share')}
            disabled={isExporting || pages.length === 0}
            className="flex items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow hover:bg-blue-700 active:scale-95 disabled:opacity-50 transition-all"
          >
            {isExporting ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
            )}
            Share PDF
          </button>
        </div>
      </header>

      {/* Pages Grid */}
      <main className="flex-1 p-4 max-w-2xl mx-auto w-full">
        {isAddingPages && (
          <div
            className="mb-4 flex items-center gap-3 rounded-xl bg-blue-50 dark:bg-blue-950/60 px-4 py-3 text-sm font-medium text-blue-900 dark:text-blue-100"
            role="status"
          >
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            Adding pasted pages…
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          {pages.map((page, index) => (
            <PageItem
              key={page.id}
              page={page}
              index={index}
              onClick={(p) => setSelectedPageId(p.id)}
            />
          ))}
        </div>
      </main>

      {/* Bottom Sticky Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-20 flex justify-around border-t border-gray-200 dark:border-neutral-800 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-md px-3 pt-3 pb-safe-offset-3 shadow-lg">
        <button
          onClick={() => router.push(`/scan?docId=${id}`)}
          className="flex flex-col items-center justify-center p-2 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span className="text-[11px] font-semibold mt-1">Add Page</span>
        </button>

        <button
          onClick={() => setShowDocumentText(true)}
          disabled={pages.length === 0}
          aria-label="Show text of all pages"
          className="flex flex-col items-center justify-center p-2 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 transition-colors"
        >
          <LiveTextIcon size={22} />
          <span className="text-[11px] font-semibold mt-1">Text</span>
        </button>

        <button
          onClick={() => handleExport('download')}
          disabled={isExporting || pages.length === 0}
          className="flex flex-col items-center justify-center p-2 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <span className="text-[11px] font-semibold mt-1">Download PDF</span>
        </button>

        <button
          onClick={handleDelete}
          className="flex flex-col items-center justify-center p-2 text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          <span className="text-[11px] font-semibold mt-1">Delete</span>
        </button>
      </div>

      {showDocumentText && (
        <TextSheet
          pages={pages}
          title="Text · All pages"
          ocrEnabled={settings.ocrEnabled}
          onClose={() => setShowDocumentText(false)}
        />
      )}

      {/* Full Screen Page Viewer Modal */}
      {selectedPage && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-md select-none">
          {/* Top modal header */}
          <div className="flex items-center justify-between px-4 pb-4 pt-safe-offset-4 bg-black/50">
            <span className="text-white text-sm font-semibold">
              Page {selectedPage.pageNumber} of {pages.length}
            </span>
            <button
              onClick={closePageViewer}
              className="rounded-full bg-white/20 p-2 text-white hover:bg-white/30"
              aria-label="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          {/* Image */}
          <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
            {selectedPageUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={selectedPageUrl}
                alt={`Page ${selectedPage.pageNumber}`}
                className="max-h-[80dvh] max-w-full object-contain rounded-md shadow-2xl"
              />
            )}
          </div>

          {/* Bottom actions for this page */}
          <div className="flex items-center justify-around px-4 pt-4 pb-safe-offset-4 bg-black/60 border-t border-gray-800">
            <button
              onClick={handleRotateCurrentPage}
              disabled={isUpdatingPage}
              className="flex flex-col items-center text-gray-300 hover:text-white"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              <span className="text-[11px] font-medium mt-1">Rotate</span>
            </button>

            <button
              onClick={() => setShowText(true)}
              aria-label="Show page text"
              className="flex flex-col items-center text-gray-300 hover:text-white"
            >
              <LiveTextIcon />
              <span className="text-[11px] font-medium mt-1">Text</span>
            </button>

            <button
              onClick={() => setIsAnnotating(true)}
              className="flex flex-col items-center text-gray-300 hover:text-white"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
              <span className="text-[11px] font-medium mt-1">Annotate</span>
            </button>

            <button
              onClick={handleShareCurrentPage}
              className="flex flex-col items-center text-gray-300 hover:text-white"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
              <span className="text-[11px] font-medium mt-1">Share</span>
            </button>

            <button
              onClick={handleDeleteCurrentPage}
              className="flex flex-col items-center text-gray-300 hover:text-red-400"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              <span className="text-[11px] font-medium mt-1">Delete Page</span>
            </button>
          </div>

          {showText && (
            <TextSheet
              pages={[selectedPage]}
              title={`Text · Page ${selectedPage.pageNumber}`}
              ocrEnabled={settings.ocrEnabled}
              onClose={() => setShowText(false)}
            />
          )}

          {isAnnotating && (
            <AnnotationEditor
              key={selectedPage.id}
              page={selectedPage}
              onSave={handleSaveAnnotations}
              onCancel={() => setIsAnnotating(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
