'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import type { Page } from '@/types';
import { retryDocumentOcr, retryOcr } from '@/lib/ocr-queue';
import {
  dismissCloudOcrError,
  getCloudOcrStates,
  retryOcrWithLlm,
  subscribeCloudOcr,
  type CloudOcrState,
} from '@/lib/cloud-ocr';
import { resolveLlmConfig } from '@/lib/llm/client';
import { useSettings } from '@/hooks/useSettings';
import { collectDocumentText } from '@/lib/ocr-text';
import { ocrLanguageName } from '@/lib/ocr-languages';
import { getSettings, updateSettings } from '@/lib/settings';
import { useEscape } from '@/hooks/useEscape';
import { useModalFocus } from '@/hooks/useModalFocus';
import { CheckIcon, CloseIcon, CloudIcon, CopyIcon, InfoIcon, RetryIcon } from '@/components/ui/icons';

interface TextSheetProps {
  /** One page for the page viewer, or all pages of the document. */
  pages: Page[];
  title: string;
  /** Languages currently configured for OCR. */
  ocrLanguages: string[];
  /** Set when showing the whole document, so retry re-runs every page. */
  documentId?: string;
  onClose: () => void;
}

const iconButton =
  'flex h-11 w-11 items-center justify-center rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent';

const CLOUD_RETRY_LABEL = 'Retry text extraction with cloud model';
const NO_CLOUD_STATES: ReadonlyMap<string, CloudOcrState> = new Map();

function isBusy(page: Page): boolean {
  return page.ocrStatus === 'pending' || page.ocrStatus === 'processing';
}

function Spinner() {
  return <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-gray-900 dark:text-gray-100">{value}</dd>
    </>
  );
}

function PageInfo({
  page,
  heading,
  ocrLanguages,
  onAddLanguage,
}: {
  page: Page;
  heading?: string;
  ocrLanguages: string[];
  onAddLanguage: (code: string) => void;
}) {
  const info = page.ocrInfo;
  const tesseractInfo = info?.engine === 'llm' ? undefined : info;
  const languages = tesseractInfo?.languages ?? page.ocrLang?.split('+').filter(Boolean) ?? [];
  const recognized = Boolean(info || page.ocrLang);
  const detected = info?.detectedLanguage;
  // Adding an OCR language only matters for text recognized on the device
  const missing =
    info?.engine !== 'llm' && detected && !ocrLanguages.includes(detected) ? detected : undefined;

  return (
    <div className="rounded-lg bg-gray-50 dark:bg-neutral-800/60 px-3 py-2 text-xs">
      {heading && (
        <h3 className="mb-1 font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{heading}</h3>
      )}
      {recognized ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {info?.engine === 'llm' ? (
            <>
              <InfoRow label="Method" value="Cloud model" />
              <InfoRow label="Recognized by" value={info.model} />
            </>
          ) : (
            <>
              <InfoRow label="Method" value={info?.engine === 'vision' ? 'Apple Vision' : 'Tesseract'} />
              <InfoRow
                label="OCR languages"
                value={languages.length ? languages.map(ocrLanguageName).join(', ') : '—'}
              />
            </>
          )}
          <InfoRow
            label="Detected language"
            value={info ? (detected ? ocrLanguageName(detected) : 'Undetermined') : '—'}
          />
          {info?.engine !== 'llm' && (
            <InfoRow
              label="Confidence"
              value={tesseractInfo?.confidence !== undefined ? `${Math.round(tesseractInfo.confidence)}%` : '—'}
            />
          )}
          <InfoRow
            label="Recognized"
            value={info?.recognizedAt ? new Date(info.recognizedAt).toLocaleString() : '—'}
          />
        </dl>
      ) : (
        <p className="text-gray-500 dark:text-gray-400">Text hasn&apos;t been recognized yet.</p>
      )}
      {missing && (
        <div className="mt-2 flex items-center justify-between gap-2 text-amber-700 dark:text-amber-400">
          <span>{ocrLanguageName(missing)} isn&apos;t selected for text recognition.</span>
          <button
            onClick={() => onAddLanguage(missing)}
            disabled={isBusy(page)}
            className="shrink-0 min-h-11 rounded-full border border-current px-4 font-semibold disabled:opacity-40"
          >
            Add &amp; retry
          </button>
        </div>
      )}
    </div>
  );
}

function PageText({ page, cloud }: { page: Page; cloud?: CloudOcrState }) {
  const status = page.ocrStatus;
  const text = status === 'done' ? page.ocrText?.trim() ?? '' : '';

  return (
    <>
      {cloud?.status === 'running' && (
        <div className="mb-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Spinner />
          Extracting text with cloud model…
        </div>
      )}
      {cloud?.status === 'error' && (
        <div className="mb-2 flex items-center justify-between gap-2 text-sm text-red-600 dark:text-red-400" role="alert">
          <span>Cloud text extraction failed: {cloud.message}</span>
          <button
            onClick={() => dismissCloudOcrError(page.id)}
            className="shrink-0 min-h-11 rounded-full border border-current px-4 text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}
      {(status === 'pending' || status === 'processing') && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Spinner />
          Recognizing text…
        </div>
      )}
      {status === 'error' && (
        <div className="flex items-center justify-between text-sm text-red-600 dark:text-red-400">
          <span>Text recognition failed.</span>
          <button
            onClick={() => void retryOcr(page.id)}
            className="min-h-11 rounded-full border border-current px-4 text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      )}
      {status === 'done' &&
        (text ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-800 dark:text-gray-200 select-text">
            {text}
          </pre>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            No text found on this page. If it’s upside down or sideways, rotate it in the page view and its text is read
            again.
          </p>
        ))}
    </>
  );
}

export function TextSheet({ pages, title, ocrLanguages, documentId, onClose }: TextSheetProps) {
  const [copied, setCopied] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const text = collectDocumentText(pages);
  const showPageHeadings = pages.length > 1;
  const busy = pages.some(isBusy);
  useEscape(onClose);
  // A modal layer (UX-008): focus moves to Close, what's underneath is inert, focus goes back on close
  const layerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(layerRef, closeRef);
  const { settings } = useSettings();
  const cloudAvailable = settings.llmEnabled && resolveLlmConfig(settings) !== null;
  const cloudStates = useSyncExternalStore(subscribeCloudOcr, getCloudOcrStates, () => NO_CLOUD_STATES);
  const cloudBusy = pages.some((p) => cloudStates.get(p.id)?.status === 'running');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const retry = async () => {
    for (const page of pages) dismissCloudOcrError(page.id);
    if (documentId) await retryDocumentOcr(documentId);
    else await Promise.all(pages.map((p) => retryOcr(p.id)));
  };

  const addLanguageAndRetry = async (code: string) => {
    // Read fresh settings so a quick double tap can't drop another language
    const current = (await getSettings()).ocrLanguages;
    if (!current.includes(code)) await updateSettings({ ocrLanguages: [...current, code] });
    await retry();
  };

  return (
    <div ref={layerRef} className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 select-none" onClick={onClose}>
      <div
        className="flex max-h-[75dvh] flex-col rounded-t-2xl bg-white dark:bg-neutral-900 pb-safe-offset-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Recognized text"
      >
        <div className="flex items-center justify-between gap-2 border-b border-gray-200 dark:border-neutral-800 py-2 pl-4 pr-2">
          <h2 className="truncate text-sm font-bold text-gray-900 dark:text-gray-100">{title}</h2>
          <div className="flex shrink-0 items-center gap-1">
            {pages.length > 0 && (
              <button
                onClick={() => setShowInfo((v) => !v)}
                aria-label="Text info"
                title="Text info"
                aria-pressed={showInfo}
                className={`${iconButton} ${showInfo ? 'bg-gray-100 text-blue-600 dark:bg-neutral-800 dark:text-blue-400' : ''}`}
              >
                <InfoIcon />
              </button>
            )}
            {pages.length > 0 && (
              <button
                onClick={() => void retry()}
                disabled={busy || cloudBusy}
                aria-label="Retry text recognition"
                title="Retry text recognition"
                className={iconButton}
              >
                <RetryIcon />
              </button>
            )}
            {cloudAvailable && pages.length > 0 && (
              <button
                onClick={() => void retryOcrWithLlm(pages.map((p) => p.id))}
                disabled={busy || cloudBusy}
                aria-label={CLOUD_RETRY_LABEL}
                title={CLOUD_RETRY_LABEL}
                aria-busy={cloudBusy}
                className={iconButton}
              >
                {cloudBusy ? <Spinner /> : <CloudIcon />}
              </button>
            )}
            {text && (
              <button
                onClick={handleCopy}
                aria-label="Copy text"
                title={copied ? 'Copied' : 'Copy text'}
                className={`${iconButton} ${copied ? 'text-green-600 dark:text-green-400' : ''}`}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            )}
            <span className="sr-only" aria-live="polite">
              {copied ? 'Copied' : ''}
            </span>
            <button ref={closeRef} onClick={onClose} aria-label="Close" title="Close" className={iconButton}>
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {showInfo && pages.length > 0 && (
            <div className="mb-4 space-y-2" aria-label="Text recognition info" role="region">
              {pages.map((page, index) => (
                <PageInfo
                  key={page.id}
                  page={page}
                  heading={showPageHeadings ? `Page ${index + 1}` : undefined}
                  ocrLanguages={ocrLanguages}
                  onAddLanguage={(code) => void addLanguageAndRetry(code)}
                />
              ))}
            </div>
          )}
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
              <PageText page={page} cloud={cloudStates.get(page.id)} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
