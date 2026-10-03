'use client';

import { useEffect, useId, useState } from 'react';
import { getSettings, updateSettings } from '@/lib/settings';
import { resolveLlmConfig } from '@/lib/llm/client';
import { listProviderModels, pickModel, resolveModel, selectableModels } from '@/lib/llm/models';
import { suggestNameWithLlm } from '@/lib/llm/naming';
import { detectEndpoint, guessSchema } from '@/lib/llm/detect-endpoint';
import type { AppSettings, CustomLlmEndpoint, LlmApiSchema, LlmProvider } from '@/types';

const SAMPLE_TEXT =
  'Telekom Deutschland GmbH\nRechnung\nRechnungsdatum: 14.09.2026\nRechnungsbetrag: 39,95 EUR';

type HostedProvider = Exclude<LlmProvider, 'custom'>;

const HOSTED_PROVIDERS: {
  id: HostedProvider;
  label: string;
  keyField: 'openaiApiKey' | 'anthropicApiKey' | 'googleApiKey';
  modelField: 'openaiModel' | 'anthropicModel' | 'googleModel';
  keyPlaceholder: string;
  keyUrl: string;
}[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyField: 'openaiApiKey',
    modelField: 'openaiModel',
    keyPlaceholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyField: 'anthropicApiKey',
    modelField: 'anthropicModel',
    keyPlaceholder: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    keyField: 'googleApiKey',
    modelField: 'googleModel',
    keyPlaceholder: 'AIzaSy…',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
];

const SCHEMA_LABELS: Record<LlmApiSchema, string> = {
  'chat-completions': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
};

const inputClass =
  'w-full rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-blue-500';

/** Text input that keeps local state while typing and saves on blur. */
function DraftTextField({
  label,
  value: saved,
  onSave,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onSave: (value: string) => Promise<void>;
  type?: 'text' | 'password' | 'url';
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
      <input
        type={type}
        value={draft ?? saved}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={async () => {
          if (draft !== null && draft.trim() !== saved) await onSave(draft.trim());
          setDraft(null);
        }}
        className={inputClass}
      />
    </label>
  );
}

const OTHER_MODEL = '__other__';

/**
 * Picker for the models an endpoint lists, with "Other…" for typing a model by hand.
 * A native select rather than a datalist: datalists filter by the current value, so
 * once a model is set they only ever suggest that one.
 */
function ModelSelect({
  value,
  models,
  automaticLabel,
  onSave,
}: {
  value: string;
  models: string[];
  /** Offers an empty choice with this label, meaning "pick one from the list at call time". */
  automaticLabel?: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [typing, setTyping] = useState(false);
  const selectId = useId();
  const listed = models.includes(value);
  // A saved model the endpoint doesn't list shows as "Other…" with its name in the text field
  const other = typing || (value !== '' && !listed);

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={selectId} className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
          Model
        </label>
        <div className="relative">
          <select
            id={selectId}
            value={other ? OTHER_MODEL : value}
            onChange={async (e) => {
              if (e.target.value === OTHER_MODEL) {
                setTyping(true);
                return;
              }
              setTyping(false);
              await onSave(e.target.value);
            }}
            className={`${inputClass} appearance-none pr-9`}
          >
            {automaticLabel ? <option value="">{automaticLabel}</option> : !value && !typing && <option value="">Pick a model</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={OTHER_MODEL}>Other…</option>
          </select>
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            fill="currentColor"
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500 dark:text-gray-400"
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      </div>
      {other && (
        <DraftTextField
          label="Model name"
          value={listed ? '' : value}
          placeholder="e.g. llama3.2"
          onSave={async (v) => {
            await onSave(v);
            if (models.includes(v)) setTyping(false);
          }}
        />
      )}
    </div>
  );
}

async function updateEndpoint(changes: Partial<CustomLlmEndpoint>) {
  const { llmCustomEndpoint } = await getSettings();
  await updateSettings({ llmCustomEndpoint: { ...llmCustomEndpoint, ...changes } });
}

type Detection =
  | { state: 'idle' }
  /** `models` is the previous list, kept in the picker while the endpoint is asked again. */
  | { state: 'detecting'; models: string[] }
  | { state: 'found'; schema: LlmApiSchema; models: string[] }
  | { state: 'failed' };

/** Detect the API schema of the saved custom endpoint and pick a model if none is set. */
async function detectAndSaveEndpoint(): Promise<Detection> {
  const { llmCustomEndpoint: endpoint } = await getSettings();
  if (!endpoint.baseUrl.trim()) return { state: 'idle' };
  const detected = await detectEndpoint(endpoint.baseUrl, endpoint.apiKey);
  if (!detected) {
    const schema = guessSchema(endpoint.baseUrl);
    if (schema !== endpoint.schema) await updateEndpoint({ schema });
    return { state: 'failed' };
  }
  // Re-read in case a model was typed while detecting
  const { llmCustomEndpoint: current } = await getSettings();
  const changes: Partial<CustomLlmEndpoint> = {};
  if (detected.baseUrl !== current.baseUrl) changes.baseUrl = detected.baseUrl;
  if (detected.schema !== current.schema) changes.schema = detected.schema;
  if (!current.model.trim() && detected.models.length > 0) changes.model = detected.models[0];
  // Only write what changed: this also runs when Settings opens, which must not touch the outbox
  if (Object.keys(changes).length > 0) await updateEndpoint(changes);
  return { state: 'found', schema: detected.schema, models: detected.models };
}

type HostedListing =
  | { state: 'loading' }
  /** `auto` is the model used when none is chosen. */
  | { state: 'found'; models: string[]; auto: string | null }
  | { state: 'failed' };

/** The selected hosted provider's models, for the picker. */
async function listHostedModels(settings: AppSettings): Promise<HostedListing> {
  const config = resolveLlmConfig(settings);
  if (!config) return { state: 'failed' };
  const listed = await listProviderModels(config);
  if (!listed) return { state: 'failed' };
  const models = selectableModels(config, listed);
  return { state: 'found', models, auto: pickModel(config, listed) };
}

function HostedProviderFields({
  provider,
  settings,
  listing,
}: {
  provider: (typeof HOSTED_PROVIDERS)[number];
  settings: AppSettings;
  listing: HostedListing | undefined;
}) {
  const models = listing?.state === 'found' ? listing.models : [];
  return (
    <>
      <DraftTextField
        label="API key"
        type="password"
        value={settings[provider.keyField]}
        placeholder={provider.keyPlaceholder}
        onSave={(v) => updateSettings({ [provider.keyField]: v })}
      />
      <a
        href={provider.keyUrl}
        target="_blank"
        rel="noreferrer"
        className="-mt-1 inline-block text-xs font-medium text-blue-600 dark:text-blue-400"
      >
        Get a {provider.label} API key
      </a>
      {models.length > 0 ? (
        <ModelSelect
          value={settings[provider.modelField]}
          models={models}
          automaticLabel={listing?.state === 'found' && listing.auto ? `Automatic (${listing.auto})` : 'Automatic'}
          onSave={(v) => updateSettings({ [provider.modelField]: v })}
        />
      ) : (
        <DraftTextField
          label="Model"
          value={settings[provider.modelField]}
          placeholder="Automatic, picked from your account"
          onSave={(v) => updateSettings({ [provider.modelField]: v })}
        />
      )}
      {listing?.state === 'failed' && (
        <p className="-mt-1 text-xs text-gray-500 dark:text-gray-400">Could not list models. Check the API key, or enter a model.</p>
      )}
    </>
  );
}

/** The models to offer in the picker: the listed ones, or the previous list while re-detecting. */
function detectedModels(detection: Detection): string[] {
  return detection.state === 'found' || detection.state === 'detecting' ? detection.models : [];
}

function CustomEndpointFields({
  endpoint,
  detection,
  onDetect,
}: {
  endpoint: CustomLlmEndpoint;
  detection: Detection;
  /** Lists the endpoint's models again; `keepModels` leaves the current list in place meanwhile. */
  onDetect: (options?: { keepModels?: boolean }) => Promise<unknown>;
}) {
  const models = detectedModels(detection);
  const refreshable = endpoint.baseUrl.trim() !== '' && detection.state !== 'detecting';

  return (
    <>
      <DraftTextField
        label="Endpoint URL"
        type="url"
        value={endpoint.baseUrl}
        placeholder="https://ollama.com/api/v1"
        onSave={async (v) => {
          // A model from the previous endpoint likely doesn't exist on the new one
          await updateEndpoint({ baseUrl: v, model: '' });
          void onDetect();
        }}
      />
      {detection.state !== 'idle' && (
        <p className="-mt-1 text-xs text-gray-500 dark:text-gray-400">
          {detection.state === 'detecting' && (detection.models.length > 0 ? 'Refreshing models…' : 'Detecting API…')}
          {detection.state === 'found' &&
            `${SCHEMA_LABELS[detection.schema]} API · ${detection.models.length} model${detection.models.length === 1 ? '' : 's'}`}
          {detection.state === 'failed' && 'Could not list models. Check the URL and API key, or enter a model.'}
          {refreshable && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => void onDetect({ keepModels: true })}
                className="font-medium text-blue-600 dark:text-blue-400"
              >
                Refresh
              </button>
            </>
          )}
        </p>
      )}
      <DraftTextField
        label="API key"
        type="password"
        value={endpoint.apiKey}
        placeholder="Not needed for local Ollama"
        onSave={async (v) => {
          await updateEndpoint({ apiKey: v });
          void onDetect({ keepModels: true });
        }}
      />
      {models.length > 0 ? (
        <ModelSelect value={endpoint.model} models={models} onSave={(v) => updateEndpoint({ model: v })} />
      ) : (
        <DraftTextField
          label="Model"
          value={endpoint.model}
          placeholder="Optional, picked from the endpoint"
          onSave={(v) => updateEndpoint({ model: v })}
        />
      )}
    </>
  );
}

function ProviderOption({
  label,
  detail,
  selected,
  onSelect,
  children,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border ${
        selected ? 'border-blue-600 dark:border-blue-500' : 'border-gray-200 dark:border-neutral-800'
      }`}
    >
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
        <input type="radio" name="llm-provider" checked={selected} onChange={onSelect} className="h-4 w-4 accent-blue-600" />
        <span className="flex-1 text-sm font-medium text-gray-900 dark:text-gray-100">{label}</span>
        {detail && (
          <span className="max-w-[45%] truncate rounded border border-gray-200 dark:border-neutral-700 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 dark:text-gray-400">
            {detail}
          </span>
        )}
      </label>
      {selected && <div className="space-y-3 border-t border-gray-100 dark:border-neutral-800 px-3 py-3">{children}</div>}
    </div>
  );
}

export function AiProviderSettings({ settings }: { settings: AppSettings }) {
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [detection, setDetection] = useState<Detection>({ state: 'idle' });
  const [hostedListing, setHostedListing] = useState<HostedListing | undefined>();

  const select = (changes: Partial<AppSettings>) => {
    setTestResult(null);
    void updateSettings(changes);
  };

  const detect = async ({ keepModels = false }: { keepModels?: boolean } = {}) => {
    setTestResult(null);
    setDetection((previous) => ({ state: 'detecting', models: keepModels ? detectedModels(previous) : [] }));
    const result = await detectAndSaveEndpoint();
    setDetection(result);
    return result;
  };

  // List the hosted provider's models once it has a key, so the model is picked from a list.
  const hostedProvider = HOSTED_PROVIDERS.find((p) => p.id === settings.llmProvider);
  const hostedKey = hostedProvider ? settings[hostedProvider.keyField].trim() : '';
  useEffect(() => {
    if (!hostedProvider || !hostedKey) return;
    let cancelled = false;
    void listHostedModels(settings).then((result) => {
      if (!cancelled) setHostedListing(result);
    });
    return () => {
      cancelled = true;
      // Keys and lists are per provider: never show one provider's models under another
      setHostedListing(undefined);
    };
    // The list depends on the provider and its key, not on the rest of the settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostedProvider?.id, hostedKey]);

  // List the saved endpoint's models when Settings opens, so the picker isn't only there
  // right after the URL was typed. Until the list arrives the model shows in a text field.
  const customSelected = settings.llmProvider === 'custom';
  const savedBaseUrl = settings.llmCustomEndpoint.baseUrl.trim();
  useEffect(() => {
    if (!customSelected || !savedBaseUrl) return;
    let cancelled = false;
    void detectAndSaveEndpoint().then((result) => {
      if (!cancelled) setDetection(result);
    });
    return () => {
      cancelled = true;
    };
    // Re-run only when the custom option is picked; URL and key edits trigger `detect` themselves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customSelected]);

  const handleTestConnection = async () => {
    // Let a focused field save its value first
    (document.activeElement as HTMLElement | null)?.blur();
    setIsTesting(true);
    setTestResult(null);
    try {
      await new Promise((r) => setTimeout(r, 50));
      let current = await getSettings();
      if (current.llmProvider === 'custom' && current.llmCustomEndpoint.baseUrl.trim() && !current.llmCustomEndpoint.model.trim()) {
        await detect();
        current = await getSettings();
      }
      const config = resolveLlmConfig(current);
      if (!config) {
        throw new Error(current.llmProvider === 'custom' ? 'Enter the endpoint URL first.' : 'Fill in the API key first.');
      }
      const model = await resolveModel(config);
      const title = await suggestNameWithLlm(SAMPLE_TEXT, { ...config, model });
      setTestResult({ ok: true, message: `Works with ${model}! Sample title: “${title}”` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestResult({
        ok: false,
        message:
          message === 'Failed to fetch' || message.includes('NetworkError') || message.includes('Load failed')
            ? 'Could not reach the server. Check the URL, and for local Ollama allow this site via OLLAMA_ORIGINS.'
            : message,
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-gray-100 dark:border-neutral-800 px-4 py-3">
      <div className="space-y-2" role="radiogroup" aria-label="AI provider">
        {HOSTED_PROVIDERS.map((provider) => (
          <ProviderOption
            key={provider.id}
            label={provider.label}
            detail={settings[provider.modelField] || 'auto'}
            selected={settings.llmProvider === provider.id}
            onSelect={() => select({ llmProvider: provider.id })}
          >
            <HostedProviderFields provider={provider} settings={settings} listing={hostedListing} />
          </ProviderOption>
        ))}
        <ProviderOption
          label="Custom endpoint"
          detail={settings.llmCustomEndpoint.model}
          selected={settings.llmProvider === 'custom'}
          onSelect={() => select({ llmProvider: 'custom' })}
        >
          <CustomEndpointFields endpoint={settings.llmCustomEndpoint} detection={detection} onDetect={detect} />
        </ProviderOption>
      </div>

      <button
        onClick={handleTestConnection}
        disabled={isTesting}
        className="rounded-full bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {isTesting ? 'Testing…' : 'Test connection'}
      </button>
      {testResult && (
        <p
          role="status"
          className={`text-xs ${testResult.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
        >
          {testResult.message}
        </p>
      )}
    </div>
  );
}
