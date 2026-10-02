'use client';

import { useRouter } from 'next/navigation';
import { useSettings } from '@/hooks/useSettings';
import { OCR_LANGUAGES, updateSettings } from '@/lib/settings';
import { requeueAllOcr } from '@/lib/ocr-queue';
import { AiProviderSettings } from '@/components/settings/AiProviderSettings';

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
    if (window.confirm('Re-run text recognition on all pages with the current languages?')) {
      await requeueAllOcr();
    }
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
        {!isLoading && (
          <section className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <h2 className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Text recognition (OCR)
            </h2>

            <label className="flex items-center justify-between px-4 py-3">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Recognize text in scans
              </span>
              <input
                type="checkbox"
                checked={settings.ocrEnabled}
                onChange={(e) => void updateSettings({ ocrEnabled: e.target.checked })}
                className="h-5 w-5 accent-blue-600"
              />
            </label>

            <div className="border-t border-gray-100 dark:border-neutral-800 px-4 py-3">
              <p className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">Languages</p>
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                Each language is downloaded once (a few MB) and then works offline.
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="OCR languages">
                {OCR_LANGUAGES.map(({ code, label }) => {
                  const selected = settings.ocrLanguages.includes(code);
                  return (
                    <button
                      key={code}
                      onClick={() => void toggleLanguage(code)}
                      disabled={!settings.ocrEnabled}
                      aria-pressed={selected}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                        selected
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-gray-300 dark:border-neutral-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-gray-100 dark:border-neutral-800 px-4 py-3">
              <button
                onClick={handleRescanAll}
                disabled={!settings.ocrEnabled}
                className="text-sm font-semibold text-blue-600 dark:text-blue-400 disabled:opacity-50"
              >
                Re-run recognition on all pages
              </button>
            </div>
          </section>
        )}

        {!isLoading && (
          <section className="mt-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <h2 className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Document naming
            </h2>

            <label className="flex items-center justify-between gap-4 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  Name new scans automatically
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  Uses the recognized text, e.g. “Rechnung – Telekom – 2026-09-14”. Names you set are never changed.
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.autoName}
                onChange={(e) => void updateSettings({ autoName: e.target.checked })}
                className="h-5 w-5 shrink-0 accent-blue-600"
              />
            </label>

            <label className="flex items-center justify-between gap-4 border-t border-gray-100 dark:border-neutral-800 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  Use an AI model
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  OpenAI, Anthropic, Google or your own endpoint (OpenRouter, Ollama, …). Falls back to on-device naming if it fails.
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
      </main>
    </div>
  );
}
