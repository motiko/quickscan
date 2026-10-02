'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { ScannedDocument } from '@/types';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { db } from '@/lib/db';
import { generatePdf, pagesToPdfInput, shareOrDownload } from '@/lib/pdf';
import { getRenderedBlob } from '@/lib/annotations/flatten';
import { collectDocumentText } from '@/lib/ocr-text';

// 36px square tap targets for touch.
const actionButtonClass =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-gray-500 dark:text-gray-400 active:scale-95 disabled:opacity-50 transition-colors';

interface DocumentCardProps {
  document: ScannedDocument;
  onDelete: (id: string) => void;
}

function getRelativeTime(date: Date | number): string {
  const now = new Date();
  const d = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - d.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return 'Just now';
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return `${diffInMinutes} min ago`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) {
    return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
  }

  const diffInMonths = Math.floor(diffInDays / 30);
  if (diffInMonths < 12) {
    return `${diffInMonths} month${diffInMonths > 1 ? 's' : ''} ago`;
  }

  const diffInYears = Math.floor(diffInDays / 365);
  return `${diffInYears} year${diffInYears > 1 ? 's' : ''} ago`;
}

export function DocumentCard({ document, onDelete }: DocumentCardProps) {
  const thumbnailUrl = useBlobUrl(document.thumbnailBlob);
  const [isSharing, setIsSharing] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'empty'>('idle');

  const handleCopyText = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      const pages = await db.pages.where('documentId').equals(document.id).sortBy('pageNumber');
      const text = collectDocumentText(pages);
      if (text) {
        await navigator.clipboard.writeText(text);
      }
      setCopyState(text ? 'copied' : 'empty');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete(document.id);
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSharing) return;

    setIsSharing(true);
    try {
      const pages = await db.pages.where('documentId').equals(document.id).sortBy('pageNumber');
      if (pages.length > 0) {
        const pdfBlob = await generatePdf(await pagesToPdfInput(pages, getRenderedBlob));
        await shareOrDownload(pdfBlob, `${document.name}.pdf`, document.name);
      }
    } catch (err) {
      console.error('Quick share failed:', err);
    } finally {
      setIsSharing(false);
    }
  };

  const relativeTime = useMemo(() => getRelativeTime(document.updatedAt), [document.updatedAt]);

  return (
    <Link href={`/doc/${document.id}`} className="block w-full">
      <div className="relative group rounded-xl overflow-hidden bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 shadow-sm hover:shadow-md transition-shadow">
        {/* Thumbnail area */}
        <div className="aspect-[3/4] bg-gray-100 dark:bg-neutral-800 flex items-center justify-center overflow-hidden relative">
          {thumbnailUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={thumbnailUrl}
              alt={document.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center text-gray-400 dark:text-gray-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            </div>
          )}
        </div>

        {/* Document info */}
        <div className="p-3">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm line-clamp-1" title={document.name}>
            {document.name}
          </h3>
          <div className="flex justify-between items-center mt-1 text-xs text-gray-500 dark:text-gray-400">
            <span>{document.pageCount} page{document.pageCount !== 1 ? 's' : ''}</span>
            <span>{relativeTime}</span>
          </div>
        </div>

        {/* Always-visible action bar (mobile first: no hover-only controls) */}
        <div className="flex items-center gap-1 border-t border-gray-100 dark:border-neutral-800 px-1.5 py-1">
          <button
            onClick={handleCopyText}
            className={`${actionButtonClass} hover:bg-blue-50 dark:hover:bg-blue-950 hover:text-blue-600 dark:hover:text-blue-400`}
            aria-label="Copy text"
            title="Copy text"
          >
            {copyState === 'copied' ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-600 dark:text-green-400">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            )}
          </button>

          <button
            onClick={handleShare}
            disabled={isSharing}
            className={`${actionButtonClass} hover:bg-blue-50 dark:hover:bg-blue-950 hover:text-blue-600 dark:hover:text-blue-400`}
            aria-label="Share document"
            title="Share as PDF"
          >
            {isSharing ? (
              <div className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
            )}
          </button>

          <span role="status" className="flex-1 truncate text-center text-[11px] font-medium text-gray-500 dark:text-gray-400">
            {copyState === 'copied' ? 'Copied' : copyState === 'empty' ? 'No text yet' : ''}
          </span>

          {/* Delete sits at the far end, apart from the quick actions to avoid mis-taps */}
          <button
            onClick={handleDelete}
            className={`${actionButtonClass} hover:bg-red-50 dark:hover:bg-red-950 hover:text-red-600 dark:hover:text-red-400`}
            aria-label="Delete document"
            title="Delete"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
    </Link>
  );
}
