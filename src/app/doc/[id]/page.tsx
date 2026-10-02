'use client';

import { useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  useDocument,
  deleteDocument,
  renameDocument,
  deletePage,
  updatePage,
} from '@/hooks/useDocuments';
import { generatePdf, pagesToPdfInput, shareOrDownload, shareImage } from '@/lib/pdf';
import { rotateImage } from '@/lib/image-processing';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { useSettings } from '@/hooks/useSettings';
import { PageTextSheet } from '@/components/documents/PageTextSheet';
import { Page } from '@/types';

function PageItem({
  page,
  index,
  onClick,
}: {
  page: Page;
  index: number;
  onClick: (page: Page, url: string) => void;
}) {
  const url = useBlobUrl(page.processedBlob || page.originalBlob);

  return (
    <div
      className="relative aspect-[3/4] overflow-hidden rounded-xl bg-gray-200 dark:bg-neutral-800 shadow-sm hover:shadow-md cursor-pointer transition-shadow"
      onClick={() => url && onClick(page, url)}
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
  const [selectedPage, setSelectedPage] = useState<{ page: Page; url: string } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isUpdatingPage, setIsUpdatingPage] = useState(false);
  const [showText, setShowText] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const { settings } = useSettings();
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleExport = async () => {
    if (pages.length === 0 || isExporting) return;
    setIsExporting(true);
    try {
      const pdfBlob = await generatePdf(pagesToPdfInput(pages));
      await shareOrDownload(pdfBlob, `${document.name}.pdf`, document.name);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Failed to export PDF.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyAllText = async () => {
    const text = pages
      .map((p) => (p.ocrStatus === 'done' ? p.ocrText ?? '' : ''))
      .filter(Boolean)
      .join('\n\n');
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

  // The modal keeps a snapshot of the page; read OCR progress from the live query
  const liveSelectedPage = selectedPage
    ? pages.find((p) => p.id === selectedPage.page.id) ?? selectedPage.page
    : null;

  const handleRotateCurrentPage = async () => {
    if (!selectedPage || isUpdatingPage) return;
    setIsUpdatingPage(true);
    try {
      const currentBlob = selectedPage.page.processedBlob || selectedPage.page.originalBlob;
      const rotatedBlob = await rotateImage(currentBlob, 90);
      await updatePage(selectedPage.page.id, { processedBlob: rotatedBlob });
      const newUrl = URL.createObjectURL(rotatedBlob);
      setSelectedPage({
        page: { ...selectedPage.page, processedBlob: rotatedBlob },
        url: newUrl,
      });
    } catch (err) {
      console.error('Failed to rotate page:', err);
    } finally {
      setIsUpdatingPage(false);
    }
  };

  const handleShareCurrentPage = async () => {
    if (!selectedPage) return;
    try {
      const currentBlob = selectedPage.page.processedBlob || selectedPage.page.originalBlob;
      await shareImage(
        currentBlob,
        `${document.name}_Page_${selectedPage.page.pageNumber}.${currentBlob.type === 'image/png' ? 'png' : 'jpg'}`,
        `${document.name} - Page ${selectedPage.page.pageNumber}`
      );
    } catch (err) {
      console.error('Failed to share page:', err);
    }
  };

  const handleDeleteCurrentPage = async () => {
    if (!selectedPage) return;
    if (window.confirm(`Delete page ${selectedPage.page.pageNumber}?`)) {
      await deletePage(selectedPage.page.id);
      setSelectedPage(null);
      setShowText(false);
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

          <div className="flex-1 truncate">
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
              <h1
                onClick={handleNameClick}
                className="truncate text-base font-bold text-gray-900 dark:text-gray-100 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                title="Click to rename"
              >
                {document.name}
              </h1>
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
            onClick={handleExport}
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
        <div className="grid grid-cols-2 gap-4">
          {pages.map((page, index) => (
            <PageItem
              key={page.id}
              page={page}
              index={index}
              onClick={(p, url) => setSelectedPage({ page: p, url })}
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
          onClick={handleExport}
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

      {/* Full Screen Page Viewer Modal */}
      {selectedPage && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-md select-none">
          {/* Top modal header */}
          <div className="flex items-center justify-between px-4 pb-4 pt-safe-offset-4 bg-black/50">
            <span className="text-white text-sm font-semibold">
              Page {selectedPage.page.pageNumber} of {pages.length}
            </span>
            <button
              onClick={() => {
                setSelectedPage(null);
                setShowText(false);
              }}
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={selectedPage.url}
              alt={`Page ${selectedPage.page.pageNumber}`}
              className="max-h-[80dvh] max-w-full object-contain rounded-md shadow-2xl"
            />
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
              className="flex flex-col items-center text-gray-300 hover:text-white"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 7 4 4 20 4 20 7"></polyline>
                <line x1="9" y1="20" x2="15" y2="20"></line>
                <line x1="12" y1="4" x2="12" y2="20"></line>
              </svg>
              <span className="text-[11px] font-medium mt-1">Text</span>
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

          {showText && liveSelectedPage && (
            <PageTextSheet
              page={liveSelectedPage}
              ocrEnabled={settings.ocrEnabled}
              onClose={() => setShowText(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
