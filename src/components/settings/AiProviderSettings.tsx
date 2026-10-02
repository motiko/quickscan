'use client';

import { useId, useState } from 'react';
import { getSettings, updateSettings } from '@/lib/settings';
import { resolveLlmConfig } from '@/lib/llm/client';
import { resolveModel } from '@/lib/llm/models';
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
  suggestions,
}: {
  label: string;
  value: string;
  onSave: (value: string) => Promise<void>;
  type?: 'text' | 'password' | 'url';
  placeholder?: string;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const listId = useId();

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
      <input
        type={type}
        value={draft ?? saved}
        placeholder={placeholder}
        list={suggestions ? listId : undefined}
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
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </label>
  );
}

async function updateEndpoint(changes: Partial<CustomLlmEndpoint>) {
  const { llmCustomEndpoint } = await getSettings();
  await updateSettings({ llmCustomEndpoint: { ...llmCustomEndpoint, ...changes } });
}

type Detection =
  | { state: 'idle' }
  | { state: 'detecting' }
  | { state: 'found'; schema: LlmApiSchema; models: string[] }
  | { state: 'failed' };

/** Detect the API schema of the saved custom endpoint and pick a model if none is set. */
async function detectAndSaveEndpoint(): Promise<Detection> {
  const { llmCustomEndpoint: endpoint } = await getSettings();
  if (!endpoint.baseUrl.trim()) return { state: 'idle' };
  const detected = await detectEndpoint(endpoint.baseUrl, endpoint.apiKey);
  if (!detected) {
    await updateEndpoint({ schema: guessSchema(endpoint.baseUrl) });
    return { state: 'failed' };
  }
  // Re-read in case a model was typed while detecting
  const { llmCustomEndpoint: current } = await getSettings();
  await updateEndpoint({
    baseUrl: detected.baseUrl,
    schema: detected.schema,
    ...(!current.model.trim() && detected.models.length > 0 ? { model: detected.models[0] } : {}),
  });
  return { state: 'found', schema: detected.schema, models: detected.models };
}

function HostedProviderFields({ provider, settings }: { provider: (typeof HOSTED_PROVIDERS)[number]; settings: AppSettings }) {
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
      <DraftTextField
        label="Model"
        value={settings[provider.modelField]}
        placeholder="Automatic, picked from your account"
        onSave={(v) => updateSettings({ [provider.modelField]: v })}
      />
    </>
  );
}

function CustomEndpointFields({
  endpoint,
  detection,
  onDetect,
}: {
  endpoint: CustomLlmEndpoint;
  detection: Detection;
  onDetect: () => Promise<unknown>;
}) {
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
          {detection.state === 'detecting' && 'Detecting API…'}
          {detection.state === 'found' &&
            `${SCHEMA_LABELS[detection.schema]} API · ${detection.models.length} model${detection.models.length === 1 ? '' : 's'}`}
          {detection.state === 'failed' && 'Could not list models. Check the URL and API key, or enter a model.'}
        </p>
      )}
      <DraftTextField
        label="API key"
        type="password"
        value={endpoint.apiKey}
        placeholder="Not needed for local Ollama"
        onSave={async (v) => {
          await updateEndpoint({ apiKey: v });
          void onDetect();
        }}
      />
      <DraftTextField
        label="Model"
        value={endpoint.model}
        placeholder="Optional, picked from the endpoint"
        suggestions={detection.state === 'found' ? detection.models : undefined}
        onSave={(v) => updateEndpoint({ model: v })}
      />
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

  const select = (changes: Partial<AppSettings>) => {
    setTestResult(null);
    void updateSettings(changes);
  };

  const detect = async () => {
    setTestResult(null);
    setDetection({ state: 'detecting' });
    const result = await detectAndSaveEndpoint();
    setDetection(result);
    return result;
  };

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
            <HostedProviderFields provider={provider} settings={settings} />
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
