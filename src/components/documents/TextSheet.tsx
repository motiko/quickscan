'use client';

import { useState } from 'react';
import type { Page } from '@/types';
import { retryOcr } from '@/lib/ocr-queue';
import { collectDocumentText } from '@/lib/ocr-text';

interface TextSheetProps {
  /** One page for the page viewer, or all pages of the document. */
  pages: Page[];
  title: string;
  ocrEnabled: boolean;
  onClose: () => void;
}

function PageText({ page, ocrEnabled }: { page: Page; ocrEnabled: boolean }) {
  const status = page.ocrStatus;
  const text = status === 'done' ? page.ocrText?.trim() ?? '' : '';

  return (
    <>
      {ocrEnabled && (status === 'pending' || status === 'processing') && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          Recognizing text…
        </div>
      )}
      {ocrEnabled && status === 'error' && (
        <div className="flex items-center justify-between text-sm text-red-600 dark:text-red-400">
          <span>Text recognition failed.</span>
          <button
            onClick={() => void retryOcr(page.id)}
            className="rounded-full border border-current px-3 py-1 text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      )}
      {!ocrEnabled && status !== 'done' && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Text recognition is turned off. Enable it in Settings.
        </p>
      )}
      {status === 'done' &&
        (text ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-800 dark:text-gray-200 select-text">
            {text}
          </pre>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">No text found on this page.</p>
        ))}
    </>
  );
}

export function TextSheet({ pages, title, ocrEnabled, onClose }: TextSheetProps) {
  const [copied, setCopied] = useState(false);
  const text = collectDocumentText(pages);
  const showPageHeadings = pages.length > 1;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 select-none" onClick={onClose}>
      <div
        className="flex max-h-[75dvh] flex-col rounded-t-2xl bg-white dark:bg-neutral-900 pb-safe-offset-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Recognized text"
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">{title}</h2>
          <div className="flex items-center gap-2">
            {text && (
              <button
                onClick={handleCopy}
                className="rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-full px-3 py-1 text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {pages.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">This document has no pages.</p>
          )}
          {pages.map((page, index) => (
            <section
              key={page.id}
              className={showPageHeadings && index > 0 ? 'mt-4 border-t border-gray-200 dark:border-neutral-800 pt-4' : ''}
            >
              {showPageHeadings && (
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Page {index + 1}
                </h3>
              )}
              <PageText page={page} ocrEnabled={ocrEnabled} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
