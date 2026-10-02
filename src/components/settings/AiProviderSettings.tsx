'use client';

import { useState } from 'react';
import { nanoid } from 'nanoid';
import { CUSTOM_ENDPOINT_PRESETS, getSettings, updateSettings } from '@/lib/settings';
import { resolveLlmConfig, suggestNameWithLlm } from '@/lib/naming/llm';
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

async function updateEndpoint(id: string, changes: Partial<CustomLlmEndpoint>) {
  const { llmCustomEndpoints } = await getSettings();
  await updateSettings({
    llmCustomEndpoints: llmCustomEndpoints.map((e) => (e.id === id ? { ...e, ...changes } : e)),
  });
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
        placeholder="Model ID"
        onSave={(v) => updateSettings({ [provider.modelField]: v })}
      />
    </>
  );
}

function CustomEndpointFields({ endpoint, settings }: { endpoint: CustomLlmEndpoint; settings: AppSettings }) {
  const handleDelete = async () => {
    if (!window.confirm(`Remove the endpoint “${endpoint.name}”?`)) return;
    const remaining = settings.llmCustomEndpoints.filter((e) => e.id !== endpoint.id);
    await updateSettings({
      llmCustomEndpoints: remaining,
      ...(remaining.length > 0
        ? { llmCustomEndpointId: remaining[0].id }
        : { llmProvider: 'openai', llmCustomEndpointId: '' }),
    });
  };

  return (
    <>
      <DraftTextField label="Name" value={endpoint.name} onSave={(v) => updateEndpoint(endpoint.id, { name: v || 'Custom endpoint' })} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">API schema</span>
        <select
          value={endpoint.schema}
          onChange={(e) => void updateEndpoint(endpoint.id, { schema: e.target.value as LlmApiSchema })}
          className={inputClass}
        >
          {Object.entries(SCHEMA_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <DraftTextField
        label="Endpoint URL"
        type="url"
        value={endpoint.baseUrl}
        placeholder="http://localhost:11434/v1"
        onSave={(v) => updateEndpoint(endpoint.id, { baseUrl: v })}
      />
      <DraftTextField
        label="API key"
        type="password"
        value={endpoint.apiKey}
        placeholder="Not needed for local Ollama"
        onSave={(v) => updateEndpoint(endpoint.id, { apiKey: v })}
      />
      <DraftTextField
        label="Model"
        value={endpoint.model}
        placeholder="Model ID from your provider"
        onSave={(v) => updateEndpoint(endpoint.id, { model: v })}
      />
      <button onClick={handleDelete} className="text-xs font-semibold text-red-600 dark:text-red-400">
        Remove endpoint
      </button>
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

  const select = (changes: Partial<AppSettings>) => {
    setTestResult(null);
    void updateSettings(changes);
  };

  const addEndpoint = async (preset?: (typeof CUSTOM_ENDPOINT_PRESETS)[number]) => {
    const endpoint: CustomLlmEndpoint = {
      id: nanoid(),
      name: preset?.name ?? 'Custom endpoint',
      schema: preset?.schema ?? 'chat-completions',
      baseUrl: preset?.baseUrl ?? '',
      apiKey: '',
      model: '',
    };
    const { llmCustomEndpoints } = await getSettings();
    setTestResult(null);
    await updateSettings({
      llmCustomEndpoints: [...llmCustomEndpoints, endpoint],
      llmProvider: 'custom',
      llmCustomEndpointId: endpoint.id,
    });
  };

  const handleTestConnection = async () => {
    // Let a focused field save its value first
    (document.activeElement as HTMLElement | null)?.blur();
    setIsTesting(true);
    setTestResult(null);
    try {
      await new Promise((r) => setTimeout(r, 50));
      const config = resolveLlmConfig(await getSettings());
      if (!config) throw new Error('Fill in the API key and model first.');
      const title = await suggestNameWithLlm(SAMPLE_TEXT, config);
      setTestResult({ ok: true, message: `Works! Sample title: “${title}”` });
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
            detail={settings[provider.modelField]}
            selected={settings.llmProvider === provider.id}
            onSelect={() => select({ llmProvider: provider.id })}
          >
            <HostedProviderFields provider={provider} settings={settings} />
          </ProviderOption>
        ))}
        {settings.llmCustomEndpoints.map((endpoint) => (
          <ProviderOption
            key={endpoint.id}
            label={endpoint.name}
            detail={endpoint.model || SCHEMA_LABELS[endpoint.schema]}
            selected={settings.llmProvider === 'custom' && settings.llmCustomEndpointId === endpoint.id}
            onSelect={() => select({ llmProvider: 'custom', llmCustomEndpointId: endpoint.id })}
          >
            <CustomEndpointFields endpoint={endpoint} settings={settings} />
          </ProviderOption>
        ))}
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">Add a custom endpoint</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Add a custom endpoint">
          {[...CUSTOM_ENDPOINT_PRESETS, undefined].map((preset) => (
            <button
              key={preset?.name ?? 'other'}
              onClick={() => void addEndpoint(preset)}
              className="rounded-full border border-gray-300 dark:border-neutral-700 px-3 py-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
            >
              + {preset?.name ?? 'Other'}
            </button>
          ))}
        </div>
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

      <p className="text-xs text-gray-500 dark:text-gray-400">
        The recognized text of each scan is sent to the selected provider to generate a name. API keys are stored
        only on this device.
      </p>
    </div>
  );
}
