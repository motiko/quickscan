'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Page, ScannedDocument } from '@/types';
import { collectDocumentText } from '@/lib/ocr-text';
import { generateDocumentSummary, isSummaryOutdated } from '@/lib/document-summary';
import { CheckIcon, CopyIcon, RetryIcon } from '@/components/ui/icons';

interface SummaryCardProps {
  document: ScannedDocument;
  pages: Page[];
}

const COLLAPSED_KEY = 'quickscan.summaryCollapsed';

const iconButton =
  'flex h-11 w-11 items-center justify-center rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage may be unavailable (private mode); the preference just isn't remembered
  }
}

function SparkleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5c.4 4.9 2.6 7.1 7.5 7.5-4.9.4-7.1 2.6-7.5 7.5-.4-4.9-2.6-7.1-7.5-7.5 4.9-.4 7.1-2.6 7.5-7.5Z" />
      <path d="M19 15.5c.2 2 1 2.8 3 3-2 .2-2.8 1-3 3-.2-2-1-2.8-3-3 2-.2 2.8-1 3-3Z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 py-1" aria-hidden="true">
      <div className="h-3 w-full animate-pulse rounded bg-gray-200 dark:bg-neutral-800" />
      <div className="h-3 w-11/12 animate-pulse rounded bg-gray-200 dark:bg-neutral-800" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-neutral-800" />
    </div>
  );
}

/** LLM summary of the document, shown above the page grid. Only rendered when an LLM is configured. */
export function SummaryCard({ document, pages }: SummaryCardProps) {
  const summary = document.summary;
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const hintId = useId();

  const ocrBusy = pages.some((p) => p.ocrStatus === 'pending' || p.ocrStatus === 'processing');
  const hasText = collectDocumentText(pages).length > 0;
  const canGenerate = hasText && !ocrBusy && !isGenerating;
  // Text is in flux while OCR runs; only flag the summary once it has settled
  const outdated = !!summary && !ocrBusy && isSummaryOutdated(summary, pages);

  // "Show more" only when the clamped text is actually cut off
  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [summary?.text, expanded, collapsed, isGenerating]);

  const toggleCollapsed = () => {
    writeCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };

  const generate = async () => {
    if (!canGenerate) return;
    setIsGenerating(true);
    setError(null);
    // Open the card so the loading state and the result are visible
    if (collapsed) toggleCollapsed();
    try {
      await generateDocumentSummary(document.id);
      setExpanded(false);
    } catch (err) {
      console.warn('Summary failed:', err);
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const errorRow = error && !isGenerating && (
    <div className="mt-2 flex items-start justify-between gap-3 text-sm text-red-600 dark:text-red-400" role="alert">
      <span className="line-clamp-2 min-w-0 break-words">Couldn&apos;t summarize. {error}</span>
      <button
        onClick={() => void generate()}
        disabled={!canGenerate}
        className="min-h-11 shrink-0 rounded-full border border-current px-4 text-xs font-semibold disabled:opacity-60"
      >
        Retry
      </button>
    </div>
  );

  // No summary yet: a slim call to action
  if (!summary && !isGenerating) {
    // Nothing to summarize and nothing coming: no button (the page explains the missing text)
    if (!hasText && !ocrBusy && !error) return null;
    const hint = ocrBusy ? 'Available once text recognition finishes' : null;
    return (
      <section className="mb-4" aria-label="Summary">
        <button
          onClick={() => void generate()}
          disabled={!canGenerate}
          aria-describedby={hint ? hintId : undefined}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-blue-700 dark:text-blue-300 shadow-sm enabled:hover:bg-blue-50 dark:enabled:hover:bg-blue-950/40 enabled:active:scale-[0.99] disabled:border-dashed disabled:bg-transparent disabled:text-gray-600 dark:disabled:bg-transparent dark:disabled:text-gray-400 disabled:shadow-none transition-all"
        >
          <SparkleIcon />
          Summarize
        </button>
        {hint && (
          <p id={hintId} className="mt-1.5 text-center text-xs text-gray-600 dark:text-gray-400">
            {hint}
          </p>
        )}
        {errorRow}
      </section>
    );
  }

  return (
    <section
      className="mb-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm"
      aria-label="Summary"
      aria-busy={isGenerating}
    >
      <div className="flex items-center gap-1 py-1 pl-2 pr-1">
        <button
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="document-summary-body"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          <ChevronIcon open={!collapsed} />
          <span className="text-blue-600 dark:text-blue-400">
            <SparkleIcon size={14} />
          </span>
          Summary
          {collapsed && outdated && (
            <span className="ml-1 truncate normal-case tracking-normal font-medium text-amber-600 dark:text-amber-400">
              · Outdated
            </span>
          )}
        </button>
        {!collapsed && (
          <>
            <button
              onClick={() => void generate()}
              disabled={!canGenerate}
              aria-label="Regenerate summary"
              title="Regenerate summary"
              className={iconButton}
            >
              <RetryIcon size={18} />
            </button>
            {summary && (
              <button
                onClick={handleCopy}
                disabled={isGenerating}
                aria-label="Copy summary"
                title={copied ? 'Copied' : 'Copy summary'}
                className={`${iconButton} ${copied ? 'text-green-600 dark:text-green-400' : ''}`}
              >
                {copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
              </button>
            )}
            <span className="sr-only" aria-live="polite">
              {copied ? 'Copied' : isGenerating ? 'Summarizing' : ''}
            </span>
          </>
        )}
      </div>

      {!collapsed && (
        <div id="document-summary-body" className="px-4 pb-3">
          {isGenerating || !summary ? (
            <Skeleton />
          ) : (
            <>
              <p
                ref={textRef}
                className={`text-sm leading-relaxed text-gray-800 dark:text-gray-200 select-text ${expanded ? '' : 'line-clamp-3'}`}
              >
                {summary.text}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {(overflows || expanded) && (
                  <button
                    onClick={() => setExpanded((e) => !e)}
                    className="min-h-11 font-semibold text-blue-700 dark:text-blue-300 hover:underline"
                  >
                    {expanded ? 'Show less' : 'Show more'}
                  </button>
                )}
                {outdated ? (
                  <span className="text-gray-500 dark:text-gray-400">
                    Pages changed ·{' '}
                    <button
                      onClick={() => void generate()}
                      disabled={!canGenerate}
                      className="min-h-11 font-semibold text-blue-700 dark:text-blue-300 hover:underline disabled:opacity-60"
                    >
                      Refresh
                    </button>
                  </span>
                ) : (
                  <span className="min-w-0 truncate text-gray-600 dark:text-gray-400" title={summary.model}>
                    {summary.model}
                  </span>
                )}
              </div>
            </>
          )}
          {errorRow}
        </div>
      )}
    </section>
  );
}
