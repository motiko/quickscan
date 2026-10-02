'use client';

import React from 'react';
import { dismissImportFailures } from '@/lib/import';
import { useImportState, useOcrProgress } from '@/hooks/useProcessing';

/** Shows upload progress, then how many pages are still being recognized. */
export function ProcessingBanner() {
  const importState = useImportState();
  const { pendingPages } = useOcrProgress();

  const importing = importState.active;
  const recognizing = pendingPages > 0;
  const failures = importState.failures;

  if (!importing && !recognizing && failures.length === 0) return null;

  return (
    <div className="mx-4 mt-4 space-y-2" role="status" aria-live="polite">
      {(importing || recognizing) && (
        <div className="flex items-center gap-3 rounded-xl bg-blue-50 dark:bg-blue-950/60 px-4 py-3 text-sm text-blue-900 dark:text-blue-100">
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <div className="min-w-0 flex-1">
            {importing ? (
              <p className="font-medium">
                Importing {Math.min(importState.done + 1, importState.total)} of {importState.total} file
                {importState.total !== 1 ? 's' : ''}…
              </p>
            ) : (
              <p className="font-medium">
                Recognizing text · {pendingPages} page{pendingPages !== 1 ? 's' : ''} left
              </p>
            )}
            {importing && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900">
                <div
                  className="h-full rounded-full bg-blue-600 transition-[width]"
                  style={{ width: `${(importState.done / importState.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {failures.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl bg-red-50 dark:bg-red-950/60 px-4 py-3 text-sm text-red-900 dark:text-red-100">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {failures.length} file{failures.length !== 1 ? 's' : ''} couldn’t be imported
            </p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {failures.map((f, i) => (
                <li key={i} className="truncate">
                  {f.fileName} — {f.reason}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs opacity-80">Supported: JPEG, PNG, WebP, HEIC</p>
          </div>
          {!importing && (
            <button
              onClick={dismissImportFailures}
              className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-red-100 dark:hover:bg-red-900"
              aria-label="Dismiss import errors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
