import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callLlm, type LlmConfig } from '@/lib/llm/client';
import { clearModelCache, pickModel, resolveModel } from '@/lib/llm/models';

const gemini: LlmConfig = { schema: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: '' };
const openai: LlmConfig = { schema: 'chat-completions', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', model: '', openaiNative: true };
const anthropic: LlmConfig = { schema: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model: '' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => clearModelCache());

describe('pickModel', () => {
  it('prefers the Gemini Flash alias, else the newest stable Flash', () => {
    expect(pickModel(gemini, ['models/gemini-3.8-flash', 'models/gemini-flash-latest'])).toBe('gemini-flash-latest');
    expect(
      pickModel(gemini, [
        'models/gemini-2.5-flash',
        'models/gemini-3.8-flash',
        'models/gemini-3.8-flash-lite',
        'models/gemini-3.8-flash-image',
        'models/gemini-embedding-001',
        'models/gemini-3.8-pro',
      ])
    ).toBe('gemini-3.8-flash');
  });

  it('prefers the newest OpenAI mini chat model', () => {
    expect(
      pickModel(openai, ['gpt-4o-mini', 'gpt-5-mini', 'gpt-5.2-mini', 'gpt-5.2-mini-2026-01-01', 'gpt-5.2-realtime-mini', 'gpt-5.2', 'dall-e-3'])
    ).toBe('gpt-5.2-mini');
    expect(pickModel(openai, ['gpt-5', 'gpt-5.2', 'whisper-1'])).toBe('gpt-5.2');
  });

  it('takes the first listed model elsewhere and null for an empty list', () => {
    expect(pickModel(anthropic, ['claude-new', 'claude-old'])).toBe('claude-new');
    expect(pickModel(anthropic, [])).toBeNull();
  });
});

describe('resolveModel', () => {
  it('keeps a configured model without listing', async () => {
    const fetchImpl = vi.fn();
    await expect(resolveModel({ ...gemini, model: ' gemini-x ' }, fetchImpl)).resolves.toBe('gemini-x');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists Gemini models once per key and only keeps generateContent models', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        models: [
          { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-9-flash', supportedGenerationMethods: ['embedContent'] },
        ],
      })
    );
    await expect(resolveModel(gemini, fetchImpl)).resolves.toBe('gemini-3.8-flash');
    await expect(resolveModel(gemini, fetchImpl)).resolves.toBe('gemini-3.8-flash');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'k' });
  });

  it('fails clearly and retries after a failed listing', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'bad key' }, 401));
    await expect(resolveModel(anthropic, fetchImpl)).rejects.toThrow('Enter a model ID');
    fetchImpl.mockResolvedValueOnce(json({ data: [{ id: 'claude-new', type: 'model' }], has_more: false }));
    await expect(resolveModel(anthropic, fetchImpl)).resolves.toBe('claude-new');
  });
});

describe('callLlm without a model', () => {
  it('sends the request with the picked model', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/models')
        ? json({ object: 'list', data: [{ id: 'gpt-5-mini', object: 'model' }] })
        : json({ choices: [{ message: { content: 'ok' } }] })
    );
    const reply = await callLlm({ system: 's', content: 'c', maxTokens: 10, timeoutMs: 1000 }, openai, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toBe('ok');
    const body = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('gpt-5-mini');
  });
});
