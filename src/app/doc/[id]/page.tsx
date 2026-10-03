'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  useDocument,
  deleteDocument,
  renameDocument,
  deletePage,
  updatePage,
  savePageAnnotations,
  keepConflictedCopy,
} from '@/hooks/useDocuments';
import { generatePdf, pagesToPdfInput, shareOrDownload, shareImage, downloadBlob } from '@/lib/pdf';
import { rotateImage } from '@/lib/image-processing';
import { useRenderedPageUrl } from '@/hooks/useRenderedPageUrl';
import { useSettings } from '@/hooks/useSettings';
import { usePasteImages } from '@/hooks/usePasteImages';
import { useEscape } from '@/hooks/useEscape';
import { alertDialog, confirmDialog } from '@/lib/dialogs';
import { importPagesToDocument } from '@/lib/import';
import { TextSheet } from '@/components/documents/TextSheet';
import { SummaryCard } from '@/components/documents/SummaryCard';
import { DocumentOrganizer } from '@/components/documents/DocumentOrganizer';
import { resolveLlmConfig } from '@/lib/llm/client';
import { LiveTextIcon } from '@/components/ui/LiveTextIcon';
import { ModalFocus } from '@/components/ui/ModalFocus';
import { collectDocumentText } from '@/lib/ocr-text';
import { getImageSize, getRenderedBlob } from '@/lib/annotations/flatten';
import { rotateAnnotations90 } from '@/lib/annotations/geometry';
import { AnnotationEditor } from '@/components/annotate/AnnotationEditor';
import { hasPageImage, requirePageImage } from '@/lib/page-image';
import { keepPageOrientation } from '@/lib/ocr-queue';
import { useVault } from '@/hooks/useVault';
import { PencilIcon } from '@/components/ui/icons';
import { Annotation, Page } from '@/types';

function PageItem({
  page,
  index,
  onOpen,
}: {
  page: Page;
  index: number;
  onOpen: (page: Page) => void;
}) {
  const url = useRenderedPageUrl(page);
  // Synced from another device and its image hasn't downloaded yet
  const missing = !hasPageImage(page);

  return (
    <button
      type="button"
      onClick={() => url && onOpen(page)}
      disabled={missing}
      aria-label={`Open page ${index + 1}`}
      data-page-id={page.id}
      className="relative block aspect-[3/4] w-full overflow-hidden rounded-xl bg-gray-200 dark:bg-neutral-800 shadow-sm transition-shadow enabled:hover:shadow-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500"
    >
      {missing ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-gray-600 dark:text-gray-300">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 16.6A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"></path>
            <polyline points="8 17 12 21 16 17"></polyline>
            <line x1="12" y1="12" x2="12" y2="21"></line>
          </svg>
          <span className="text-xs font-medium">Image not downloaded yet</span>
        </div>
      ) : url ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={url}
          alt={`Page ${index + 1}`}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-gray-300 dark:bg-neutral-700" />
      )}
      {page.conflictOf && (
        <div
          className="absolute left-2 top-2 rounded-full bg-amber-700 px-2.5 py-0.5 text-xs font-semibold text-white shadow-sm"
          data-testid="conflict-badge"
        >
          Conflicted copy
        </div>
      )}
      <div className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2.5 py-0.5 text-xs font-semibold text-white backdrop-blur-sm" aria-hidden="true">
        {index + 1}
      </div>
    </button>
  );
}

/** Every page is recognized but none has text: usually a page the wrong way round. */
function NoTextNotice({ onOpenPage }: { onOpenPage: () => void }) {
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white dark:bg-neutral-900 px-4 py-3 ring-1 ring-gray-200 dark:ring-neutral-800"
    >
      <div className="min-w-[min(12rem,100%)] flex-1 text-sm">
        <p className="font-semibold text-gray-900 dark:text-gray-100">No text recognized</p>
        <p className="mt-0.5 text-gray-600 dark:text-gray-300">
          If a page is upside down or sideways, open it and use Rotate. Its text is read again automatically.
        </p>
      </div>
      <button
        onClick={onOpenPage}
        className="min-h-11 shrink-0 rounded-full bg-gray-100 dark:bg-neutral-800 px-4 text-sm font-semibold text-blue-700 dark:text-blue-300 hover:bg-gray-200 dark:hover:bg-neutral-700"
      >
        Open page
      </button>
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
  const [isAddingPages, setIsAddingPages] = useState(false);
  const { settings } = useSettings();
  const syncOn = useVault().status === 'unlocked';
  const llmConfigured = settings.llmEnabled && resolveLlmConfig(settings) !== null;
  const inputRef = useRef<HTMLInputElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  const viewerCloseRef = useRef<HTMLButtonElement>(null);
  const lastViewedPageId = useRef<string | null>(null);

  const selectedIndex = selectedPageId ? pages.findIndex((p) => p.id === selectedPageId) : -1;
  const selectedPage = selectedIndex >= 0 ? pages[selectedIndex] : null;

  // The viewer is a modal layer (UX-008, <ModalFocus> inside it): focus moves into it, and back to
  // the thumbnail of the page last shown when it closes
  const viewerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedPageId) lastViewedPageId.current = selectedPageId;
  }, [selectedPageId]);
  const viewerReturnFocus = useCallback(
    () =>
      lastViewedPageId.current
        ? window.document.querySelector<HTMLButtonElement>(`button[data-page-id="${lastViewedPageId.current}"]`)
        : null,
    []
  );
  const selectedPageUrl = useRenderedPageUrl(selectedPage);
  const hasPrevPage = selectedIndex > 0;
  const hasNextPage = selectedIndex >= 0 && selectedIndex < pages.length - 1;
  // Horizontal swipe in the page viewer; dragX makes the image follow the finger
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [dragX, setDragX] = useState(0);

  const goToPage = (delta: number) => {
    const next = pages[selectedIndex + delta];
    if (selectedIndex < 0 || !next) return;
    setSelectedPageId(next.id);
    setShowText(false);
  };

  const closePageViewer = () => {
    setSelectedPageId(null);
    setShowText(false);
    setIsAnnotating(false);
  };

  // Escape closes the viewer once the text sheet or annotation editor on top of it is closed
  useEscape(closePageViewer, !!selectedPage);

  // Arrow keys switch pages (not while annotating or reading text)
  useEffect(() => {
    if (!selectedPageId || isAnnotating || showText) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goToPage(-1);
      if (e.key === 'ArrowRight') goToPage(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Pasted images are appended as new pages; ignored while a page is open in the viewer
  usePasteImages(async (files) => {
    setIsAddingPages(true);
    try {
      const failures = await importPagesToDocument(id, files);
      if (failures.length > 0) {
        void alertDialog({
          title: failures.length === 1 ? 'Couldn’t add an image' : `Couldn’t add ${failures.length} images`,
          message: failures.map((f) => `${f.fileName} (${f.reason})`).join(', '),
        });
      }
    } finally {
      setIsAddingPages(false);
    }
  }, !!document && !selectedPage);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-gray-50 dark:bg-neutral-950">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Loading document...</p>
        </div>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center p-4 bg-gray-50 dark:bg-neutral-950">
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

  const finishRename = () => {
    setIsEditingName(false);
    // Back on the title, so keyboard and screen reader users don't lose their place
    setTimeout(() => titleButtonRef.current?.focus(), 0);
  };

  const handleNameSubmit = async () => {
    if (editName.trim() && editName !== document.name) {
      await renameDocument(id, editName.trim());
    }
    finishRename();
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleNameSubmit();
    if (e.key === 'Escape') {
      e.preventDefault(); // cancel the rename only, not an open layer
      finishRename();
    }
  };

  const handleDelete = async () => {
    const what = pages.length === 1 ? 'Its page is' : `All ${pages.length} pages are`;
    const confirmed = await confirmDialog({
      title: 'Delete this document?',
      message: `${what} deleted from this device${syncOn ? ' and your other synced devices' : ''}. This can’t be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (confirmed) {
      await deleteDocument(id);
      router.push('/');
    }
  };

  const handleExport = async (mode: 'share' | 'download') => {
    if (pages.length === 0 || isExporting) return;
    if (!pages.every(hasPageImage)) {
      void alertDialog({
        title: 'Some pages are still downloading',
        message: 'Their images are synced from another device. Export once every page shows its image.',
      });
      return;
    }
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
      void alertDialog({ title: 'Couldn’t export the PDF', message: 'Please try again.' });
    } finally {
      setIsExporting(false);
    }
  };

  const handleSwipeStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      swipeStart.current = null;
      setDragX(0);
      return;
    }
    swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleSwipeMove = (e: React.TouchEvent) => {
    if (!swipeStart.current) return;
    const dx = e.touches[0].clientX - swipeStart.current.x;
    const dy = e.touches[0].clientY - swipeStart.current.y;
    if (Math.abs(dx) < Math.abs(dy)) return;
    // Resist dragging past the first or last page
    setDragX((dx > 0 && !hasPrevPage) || (dx < 0 && !hasNextPage) ? dx / 4 : dx);
  };

  const handleSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    setDragX(0);
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) goToPage(dx < 0 ? 1 : -1);
  };

  const handleRotateCurrentPage = async () => {
    if (!selectedPage || isUpdatingPage) return;
    setIsUpdatingPage(true);
    // The user picks the orientation now; text recognition (re-run below) mustn't turn it back
    keepPageOrientation(selectedPage.id);
    try {
      const currentBlob = requirePageImage(selectedPage);
      const [rotatedBlob, size] = await Promise.all([rotateImage(currentBlob, 90), getImageSize(currentBlob)]);
      await updatePage(selectedPage.id, { processedBlob: rotatedBlob });
      // Keep annotations aligned with the rotated image (also refreshes the thumbnail for page 1)
      await savePageAnnotations(
        selectedPage.id,
        rotateAnnotations90(selectedPage.annotations ?? [], size.width, size.height)
      );
    } catch (err) {
      console.error('Failed to rotate page:', err);
      void alertDialog({ title: 'Couldn’t rotate the page', message: 'Please try again.' });
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
    const confirmed = await confirmDialog({
      title: `Delete page ${selectedPage.pageNumber}?`,
      message: 'This can’t be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (confirmed) {
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
      void alertDialog({ title: 'Couldn’t save annotations', message: 'Please try again.' });
    }
  };

  const ocrSettled = pages.length > 0 && pages.every((p) => p.ocrStatus === 'done' && hasPageImage(p));
  const showNoText = ocrSettled && !collectDocumentText(pages);
  const pageHasNoText =
    !!selectedPage && selectedPage.ocrStatus === 'done' && !selectedPage.ocrText?.trim() && hasPageImage(selectedPage);
  const viewerAction =
    'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-center text-xs font-medium leading-tight text-gray-200 hover:bg-white/10 hover:text-white disabled:opacity-60';

  // Labels give way to icons (names stay for screen readers) when large text can't fit them
  const toolbarLabel = 'sr-only @min-[20rem]:not-sr-only';
  const toolbarButton =
    'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-center text-xs font-semibold leading-tight text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-50 transition-colors';
  const toolbarAction = `${toolbarButton} hover:text-blue-700 dark:hover:text-blue-300`;

  return (
    <div className="flex min-h-dvh flex-col bg-gray-50 dark:bg-neutral-950">
      {/* Top Header */}
      <header
        className="@container sticky top-0 z-30 bg-white dark:bg-neutral-900 pl-safe pr-safe pt-safe shadow-xs dark:shadow-none dark:border-b dark:border-neutral-800"
      >
        <div className="flex min-h-16 flex-wrap items-center gap-2 px-4 py-2">
          <button
            onClick={() => router.push('/')}
            className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-neutral-800 active:bg-gray-200 dark:active:bg-neutral-700"
            aria-label="Back to gallery"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>

          <div className="order-last min-w-0 basis-full @min-[22rem]:order-none @min-[22rem]:flex-1 @min-[22rem]:basis-0">
            {isEditingName ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => void handleNameSubmit()}
                onKeyDown={handleNameKeyDown}
                aria-label="Document name"
                enterKeyHint="done"
                className="min-h-11 w-full rounded-lg border border-blue-500 bg-white dark:bg-neutral-900 px-2.5 py-1 text-base font-semibold text-gray-900 dark:text-gray-100 outline-none"
              />
            ) : (
              <h1 className="min-w-0">
                {/* The pencil says the title is editable, for touch, mouse and keyboard alike */}
                <button
                  ref={titleButtonRef}
                  onClick={handleNameClick}
                  aria-describedby="rename-hint"
                  className="group -ml-1 flex min-h-11 max-w-full items-center gap-1.5 rounded-lg px-1 text-left text-base font-bold text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-neutral-800"
                >
                  <span className="line-clamp-2 min-w-0 break-words">{document.name}</span>
                  <span className="shrink-0 text-gray-500 group-hover:text-blue-600 dark:text-gray-400 dark:group-hover:text-blue-400">
                    <PencilIcon size={16} />
                  </span>
                </button>
                <span id="rename-hint" hidden>
                  Rename
                </span>
              </h1>
            )}
            <p className="px-0.5 text-xs text-gray-600 dark:text-gray-400">
              {pages.length} page{pages.length !== 1 ? 's' : ''}
            </p>
          </div>

          <button
            onClick={() => handleExport('share')}
            disabled={isExporting || pages.length === 0}
            aria-busy={isExporting}
            className="ml-auto flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-blue-600 px-3.5 text-sm font-semibold text-white shadow hover:bg-blue-700 active:scale-95 disabled:opacity-50 transition-all"
          >
            {isExporting ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
            )}
            <span>Share PDF</span>
          </button>
        </div>
      </header>

      {/* Pages Grid */}
      <main className="mx-auto w-full max-w-2xl flex-1 py-4 px-safe-offset-4">
        {isAddingPages && (
          <div
            className="mb-4 flex items-center gap-3 rounded-xl bg-blue-50 dark:bg-blue-950/60 px-4 py-3 text-sm font-medium text-blue-900 dark:text-blue-100"
            role="status"
          >
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            Adding pasted pages…
          </div>
        )}
        <DocumentOrganizer document={document} />
        {showNoText && <NoTextNotice onOpenPage={() => setSelectedPageId(pages[0].id)} />}
        {llmConfigured && pages.length > 0 && (
          <SummaryCard document={document} pages={pages} />
        )}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {pages.map((page, index) => (
            <PageItem
              key={page.id}
              page={page}
              index={index}
              onOpen={(p) => setSelectedPageId(p.id)}
            />
          ))}
        </div>
      </main>

      {/* Bottom action bar: sticky at the end of the column, so the last page scrolls clear of it */}
      <div
        className="@container sticky bottom-0 z-20 border-t border-gray-200 dark:border-neutral-800 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-md px-safe-offset-3 pt-2 pb-safe-offset-2 shadow-lg"
      >
        <div role="group" aria-label="Document actions" className="mx-auto flex max-w-2xl items-stretch gap-1">
          <button onClick={() => router.push(`/scan?docId=${id}`)} className={toolbarAction}>
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span className={toolbarLabel}>Add Page</span>
          </button>

          <button
            onClick={() => setShowDocumentText(true)}
            disabled={pages.length === 0}
            aria-label="Show text of all pages"
            className={toolbarAction}
          >
            <LiveTextIcon size={22} />
            <span className={toolbarLabel}>Text</span>
          </button>

          <button
            onClick={() => handleExport('download')}
            disabled={isExporting || pages.length === 0}
            className={toolbarAction}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span className={toolbarLabel}>Download PDF</span>
          </button>

          {/* Destructive action set apart from the everyday ones */}
          <div aria-hidden="true" className="mx-2 my-2 w-px shrink-0 bg-gray-200 dark:bg-neutral-700" />

          <button
            onClick={handleDelete}
            className={`${toolbarButton} hover:text-red-700 dark:hover:text-red-300`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            <span className={toolbarLabel}>Delete</span>
          </button>
        </div>
      </div>

      {showDocumentText && (
        <TextSheet
          pages={pages}
          title="Text · All pages"
          ocrLanguages={settings.ocrLanguages}
          documentId={id}
          onClose={() => setShowDocumentText(false)}
        />
      )}

      {/* Full Screen Page Viewer Modal */}
      {selectedPage && (
        <div
          ref={viewerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="page-viewer-title"
          className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-md select-none"
        >
          <ModalFocus layer={viewerRef} initial={viewerCloseRef} returnFocus={viewerReturnFocus} />
          {/* Top modal header */}
          <div className="flex items-center justify-between px-safe-offset-4 pb-3 pt-safe-offset-3 bg-black/50">
            <h2 id="page-viewer-title" className="text-white text-sm font-semibold">
              Page {selectedIndex + 1} of {pages.length}
            </h2>
            <button
              ref={viewerCloseRef}
              onClick={closePageViewer}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              aria-label="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          {selectedPage.conflictOf && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-amber-500/20 px-4 py-2 text-sm text-amber-100" role="status">
              <p className="flex-1 min-w-[12rem]">
                <span className="font-semibold">Conflicted copy.</span> This version was changed on another device at the
                same time and kept so nothing is lost.
              </p>
              <button
                onClick={() => void keepConflictedCopy(selectedPage.id)}
                className="min-h-11 min-w-11 px-3 font-semibold text-white"
              >
                Keep
              </button>
              <button onClick={handleDeleteCurrentPage} className="min-h-11 min-w-11 px-3 font-semibold text-red-300">
                Delete
              </button>
            </div>
          )}

          {/* Image — swipe left/right or use the arrows to change page */}
          <div
            className="relative flex-1 flex items-center justify-center p-4 overflow-hidden touch-pan-y"
            onTouchStart={handleSwipeStart}
            onTouchMove={handleSwipeMove}
            onTouchEnd={handleSwipeEnd}
            onTouchCancel={() => {
              swipeStart.current = null;
              setDragX(0);
            }}
          >
            {selectedPageUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={selectedPageUrl}
                alt={`Page ${selectedPage.pageNumber}`}
                draggable={false}
                style={{ transform: dragX ? `translateX(${dragX}px)` : undefined }}
                className={`max-h-[80dvh] max-w-full object-contain rounded-md shadow-2xl ${
                  dragX ? '' : 'transition-transform duration-200'
                }`}
              />
            )}

            {hasPrevPage && (
              <button
                onClick={() => goToPage(-1)}
                className="absolute left-2 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 active:scale-95 transition-all"
                aria-label="Previous page"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </button>
            )}

            {hasNextPage && (
              <button
                onClick={() => goToPage(1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 active:scale-95 transition-all"
                aria-label="Next page"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              </button>
            )}
          </div>

          {/* Bottom actions for this page */}
          <div className="bg-black/60 border-t border-gray-800 px-safe-offset-3 pt-2 pb-safe-offset-3">
            {pageHasNoText && (
              <p className="pb-2 text-center text-sm text-gray-200" role="status">
                No text found on this page. If it’s upside down or sideways, use Rotate.
              </p>
            )}
            <div role="group" aria-label="Page actions" className="mx-auto flex max-w-2xl items-stretch gap-1">
              <button
                onClick={handleRotateCurrentPage}
                disabled={isUpdatingPage}
                aria-busy={isUpdatingPage}
                className={viewerAction}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
                Rotate
              </button>

              <button onClick={() => setShowText(true)} aria-label="Show page text" className={viewerAction}>
                <LiveTextIcon />
                <span>Text</span>
              </button>

              <button onClick={() => setIsAnnotating(true)} className={viewerAction}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
                Annotate
              </button>

              <button onClick={handleShareCurrentPage} className={viewerAction}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="18" cy="5" r="3"></circle>
                  <circle cx="6" cy="12" r="3"></circle>
                  <circle cx="18" cy="19" r="3"></circle>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
                </svg>
                Share
              </button>

              {/* Destructive action set apart from the everyday ones */}
              <div aria-hidden="true" className="mx-1 my-2 w-px shrink-0 bg-white/20" />

              <button onClick={handleDeleteCurrentPage} className={`${viewerAction} hover:text-red-300`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Delete Page
              </button>
            </div>
          </div>

          {showText && (
            <TextSheet
              pages={[selectedPage]}
              title={`Text · Page ${selectedPage.pageNumber}`}
              ocrLanguages={settings.ocrLanguages}
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
