import { describe, it, expect, vi } from 'vitest';
import {
  cleanLlmTitle,
  chatCompletionsUrl,
  resolveLlmConfig,
  suggestNameWithLlm,
  type LlmConfig,
} from '@/lib/naming/llm';
import { migrateLegacyLlmSettings } from '@/lib/llm-settings-migration';
import { DEFAULT_SETTINGS } from '@/lib/settings';

const config: LlmConfig = { schema: 'chat-completions', baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-test', model: 'some/model' };

function reply(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe('chatCompletionsUrl', () => {
  it('appends the endpoint without doubling slashes', () => {
    expect(chatCompletionsUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions');
    expect(chatCompletionsUrl(' https://x.ai/v1// ')).toBe('https://x.ai/v1/chat/completions');
  });
});

describe('cleanLlmTitle', () => {
  it('strips quotes, markdown, labels and reasoning blocks', () => {
    expect(cleanLlmTitle('"Rechnung – Telekom – 2026-09-14"')).toBe('Rechnung – Telekom – 2026-09-14');
    expect(cleanLlmTitle('**Title:** Invoice ACME.pdf\nExplanation: ...')).toBe('Invoice ACME');
    expect(cleanLlmTitle('<think>The doc is an invoice…</think>\nInvoice – ACME')).toBe('Invoice – ACME');
  });

  it('replaces filename-illegal characters and caps length', () => {
    expect(cleanLlmTitle('Invoice 2026/09: ACME?')).toBe('Invoice 2026-09- ACME-');
    expect(cleanLlmTitle('word '.repeat(40)).length).toBeLessThanOrEqual(80);
  });
});

describe('suggestNameWithLlm', () => {
  it('sends an OpenAI-compatible request and returns the cleaned title', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply("'Receipt – ACME'"));
    const title = await suggestNameWithLlm('x'.repeat(10000), config, { fetchImpl });

    expect(title).toBe('Receipt – ACME');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('some/model');
    expect(body.messages[1].content).toHaveLength(4000);
  });

  it('routes CORS-less providers like Ollama Cloud through the same-origin proxy', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('Title'));
    await suggestNameWithLlm('text', { ...config, baseUrl: 'https://ollama.com/v1' }, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/llm');
    expect(init.headers['X-LLM-Target']).toBe('https://ollama.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
  });

  it('only proxies chat completions requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('Title'));
    await suggestNameWithLlm(
      'text',
      { ...config, schema: 'anthropic-messages', baseUrl: 'https://ollama.com/v1' },
      { fetchImpl },
    ).catch(() => {});
    expect(fetchImpl.mock.calls[0][0]).toBe('https://ollama.com/v1/messages');
  });

  it('omits the Authorization header without an API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('Title'));
    await suggestNameWithLlm('text', { ...config, apiKey: '' }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('throws on HTTP errors and empty replies', async () => {
    await expect(
      suggestNameWithLlm('t', config, { fetchImpl: vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })) })
    ).rejects.toThrow('401');
    await expect(
      suggestNameWithLlm('t', config, { fetchImpl: vi.fn().mockResolvedValue(reply('   ')) })
    ).rejects.toThrow('empty');
  });

  it('aborts after the timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })
    );
    await expect(
      suggestNameWithLlm('t', config, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10 })
    ).rejects.toThrow('Aborted');
  });
});

describe('provider schemas', () => {
  it('uses max_completion_tokens and no temperature for OpenAI itself', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('Invoice'));
    await suggestNameWithLlm('text', { ...config, baseUrl: 'https://api.openai.com/v1', openaiNative: true }, { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBeGreaterThan(100);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('sends an Anthropic Messages request with browser-access headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Rechnung – Telekom' }] }))
    );
    const title = await suggestNameWithLlm(
      'text',
      { schema: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant', model: 'claude-opus-5-5' },
      { fetchImpl }
    );

    expect(title).toBe('Rechnung – Telekom');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.system).toContain('You name scanned documents');
    expect(body.messages).toEqual([{ role: 'user', content: 'text' }]);
  });

  it('treats an Anthropic refusal as a failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }))
    );
    await expect(
      suggestNameWithLlm('t', { schema: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model: 'm' }, { fetchImpl })
    ).rejects.toThrow('declined');
  });

  it('sends a Gemini generateContent request and skips thought parts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Invoice – ACME' }] } }],
        })
      )
    );
    const title = await suggestNameWithLlm(
      'text',
      { schema: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIza', model: 'models/gemini-2.5-flash' },
      { fetchImpl }
    );

    expect(title).toBe('Invoice – ACME');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(init.headers['x-goog-api-key']).toBe('AIza');
    expect(JSON.parse(init.body).contents[0].parts[0].text).toBe('text');
  });
});

describe('resolveLlmConfig', () => {
  it('requires an API key for hosted providers', () => {
    expect(resolveLlmConfig({ ...DEFAULT_SETTINGS, llmProvider: 'anthropic' })).toBeNull();
    expect(resolveLlmConfig({ ...DEFAULT_SETTINGS, llmProvider: 'anthropic', anthropicApiKey: 'sk-ant' })).toMatchObject({
      schema: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-opus-5-5',
    });
  });

  it('resolves the selected custom endpoint, which may have no key', () => {
    const endpoint = { id: 'e1', name: 'Ollama', schema: 'anthropic-messages' as const, baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'gemma' };
    const settings = { ...DEFAULT_SETTINGS, llmProvider: 'custom' as const, llmCustomEndpoints: [endpoint] };
    expect(resolveLlmConfig({ ...settings, llmCustomEndpointId: 'missing' })).toBeNull();
    expect(resolveLlmConfig({ ...settings, llmCustomEndpointId: 'e1' })).toMatchObject({ schema: 'anthropic-messages', model: 'gemma' });
  });
});

describe('migrateLegacyLlmSettings', () => {
  it('turns the old endpoint into a selected custom endpoint', () => {
    const migrated = migrateLegacyLlmSettings({
      llmEnabled: true,
      llmBaseUrl: 'https://openrouter.ai/api/v1',
      llmApiKey: 'sk-or',
      llmModel: 'x/y',
    })!;
    expect(migrated.llmProvider).toBe('custom');
    expect(migrated.llmCustomEndpoints).toEqual([
      expect.objectContaining({ name: 'openrouter.ai', schema: 'chat-completions', apiKey: 'sk-or', model: 'x/y' }),
    ]);
    expect(migrated.llmCustomEndpointId).toBe(migrated.llmCustomEndpoints![0].id);
  });

  it('does nothing without legacy keys and drops an empty endpoint', () => {
    expect(migrateLegacyLlmSettings({ autoName: true })).toBeNull();
    expect(migrateLegacyLlmSettings({ llmBaseUrl: '', llmModel: '' })).toEqual({});
  });
});
