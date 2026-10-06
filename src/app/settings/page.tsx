'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSettings } from '@/hooks/useSettings';
import { updateSettings } from '@/lib/settings';
import { filterOcrLanguages, getOcrLanguage } from '@/lib/ocr-languages';
import { requeueAllOcr } from '@/lib/ocr-queue';
import { confirmDialog } from '@/lib/dialogs';
import { AiProviderSettings } from '@/components/settings/AiProviderSettings';
import { AccountSettings } from '@/components/settings/AccountSettings';

/** Selected languages as removable chips, plus a searchable list of all languages. */
function OcrLanguagePicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (code: string) => void;
}) {
  const [query, setQuery] = useState('');
  const results = filterOcrLanguages(query);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Selected OCR languages">
        {selected.map((code) => {
          const label = getOcrLanguage(code)?.label ?? code;
          return (
            <button
              key={code}
              onClick={() => onToggle(code)}
              disabled={selected.length === 1}
              aria-label={`Remove ${label}`}
              className="flex items-center gap-1 rounded-full border border-blue-600 bg-blue-600 py-1.5 pl-3 pr-2 text-xs font-semibold text-white"
            >
              {label}
              {selected.length > 1 && (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              )}
            </button>
          );
        })}
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search languages"
        aria-label="Search languages"
        className="w-full rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-blue-600"
      />

      <ul
        className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-neutral-800"
        aria-label="OCR languages"
      >
        {results.map(({ code, label, native }) => {
          const isSelected = selected.includes(code);
          return (
            <li key={code} className="border-b border-gray-100 dark:border-neutral-800 last:border-b-0">
              <button
                onClick={() => onToggle(code)}
                disabled={isSelected && selected.length === 1}
                aria-pressed={isSelected}
                aria-label={label}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-neutral-800 disabled:cursor-default"
              >
                <span className="min-w-0">
                  <span className="text-gray-900 dark:text-gray-100">{label}</span>
                  {native !== label && (
                    <span className="ml-2 text-gray-500 dark:text-gray-400">{native}</span>
                  )}
                </span>
                {isSelected && (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                )}
              </button>
            </li>
          );
        })}
        {results.length === 0 && (
          <li className="px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400">No languages match “{query.trim()}”</li>
        )}
      </ul>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { settings, isLoading } = useSettings();
  const toggleLanguage = async (code: string) => {
    const current = settings.ocrLanguages;
    const next = current.includes(code)
      ? current.filter((c) => c !== code)
      : [...current, code];
    if (next.length === 0) return; // at least one language is required
    await updateSettings({ ocrLanguages: next });
  };

  const handleRescanAll = async () => {
    const confirmed = await confirmDialog({
      title: 'Re-run recognition on all pages?',
      message: `Every page is recognized again with ${settings.ocrLanguages.map((c) => getOcrLanguage(c)?.label ?? c).join(', ')}. This runs in the background and replaces the current text.`,
      confirmLabel: 'Re-run',
    });
    if (confirmed) await requeueAllOcr();
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 dark:bg-neutral-950 pb-safe-offset-6">
      <header className="sticky top-0 z-20 bg-white dark:bg-neutral-900 px-4 shadow-xs pt-safe dark:shadow-none dark:border-b dark:border-neutral-800">
        <div className="flex h-14 items-center gap-2">
          <button
            onClick={() => router.push('/')}
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-neutral-800"
            aria-label="Back to gallery"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>
          <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Settings</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 p-4">
        <AccountSettings />

        {!isLoading && (
          <section className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <h2 className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Text recognition (OCR)
            </h2>

            <div className="px-4 py-3">
              <p className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">Languages</p>
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                Each language is downloaded once (a few MB) and then works offline.
              </p>
              <OcrLanguagePicker
                selected={settings.ocrLanguages}
                onToggle={(code) => void toggleLanguage(code)}
              />
            </div>

            <div className="border-t border-gray-100 dark:border-neutral-800 px-4 py-3">
              <button
                onClick={handleRescanAll}
                className="text-sm font-semibold text-blue-600 dark:text-blue-400"
              >
                Re-run recognition on all pages
              </button>
            </div>
          </section>
        )}

        {!isLoading && (
          <section className="mt-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <label className="flex items-center justify-between gap-4 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  Use Cloud LLM
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  Used for generating summaries, text recognition and automatic titles.
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  OpenAI, Anthropic, Google or a custom endpoint with compatible API (Ollama)
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.llmEnabled}
                onChange={(e) => void updateSettings({ llmEnabled: e.target.checked })}
                className="h-5 w-5 shrink-0 accent-blue-600"
              />
            </label>

            {settings.llmEnabled && <AiProviderSettings settings={settings} />}
          </section>
        )}

        <p className="mt-6 text-center text-sm">
          <Link href="/privacy" className="inline-flex min-h-11 items-center px-3 font-medium text-gray-600 underline dark:text-gray-400">
            Privacy policy
          </Link>
        </p>
      </main>
    </div>
  );
}
