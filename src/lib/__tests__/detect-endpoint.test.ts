import { describe, it, expect, vi } from 'vitest';
import { candidateBaseUrls, detectEndpoint, guessSchema } from '@/lib/naming/detect-endpoint';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** A fake server answering model listings at the given URLs. */
function server(routes: Record<string, (headers: Record<string, string>) => Response>) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const route = routes[url];
    return route ? route((init.headers ?? {}) as Record<string, string>) : json({ error: 'not found' }, 404);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('candidateBaseUrls', () => {
  it('tries the URL, then with /v1, then the origin with /v1', () => {
    expect(candidateBaseUrls('https://ollama.com/api/v1/')).toEqual(['https://ollama.com/api/v1', 'https://ollama.com/v1']);
    expect(candidateBaseUrls('https://llm.example')).toEqual(['https://llm.example', 'https://llm.example/v1']);
    expect(candidateBaseUrls('not a url')).toEqual([]);
  });
});

describe('guessSchema', () => {
  it('guesses from the URL', () => {
    expect(guessSchema('https://api.minimax.io/anthropic/v1')).toBe('anthropic-messages');
    expect(guessSchema('https://openrouter.ai/api/v1')).toBe('chat-completions');
  });
});

describe('detectEndpoint', () => {
  it('detects an OpenAI-compatible endpoint and lists its models', async () => {
    const fetchMock = server({
      'https://openrouter.ai/api/v1/models': (h) =>
        h.Authorization === 'Bearer sk-or' ? json({ data: [{ id: 'a/model' }, { id: 'b/model' }] }) : json({}, 401),
    });
    expect(await detectEndpoint('https://openrouter.ai/api/v1', 'sk-or', fetchMock)).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      schema: 'chat-completions',
      models: ['a/model', 'b/model'],
    });
  });

  it('detects an Anthropic endpoint and fixes a missing /v1', async () => {
    const fetchMock = server({
      'https://api.anthropic.com/v1/models': (h) =>
        h['x-api-key'] === 'sk-ant'
          ? json({ data: [{ id: 'claude-opus-5-5', type: 'model' }], has_more: false })
          : json({ type: 'error' }, 401),
    });
    expect(await detectEndpoint('https://api.anthropic.com', 'sk-ant', fetchMock)).toEqual({
      baseUrl: 'https://api.anthropic.com/v1',
      schema: 'anthropic-messages',
      models: ['claude-opus-5-5'],
    });
  });

  it('lists Ollama Cloud models through the proxy', async () => {
    const fetchMock = server({
      '/api/llm': (h) =>
        h['X-LLM-Target'] === 'https://ollama.com/v1/models'
          ? json({ object: 'list', data: [{ id: 'gpt-oss:120b', object: 'model' }] })
          : json({}, 404),
    });
    expect(await detectEndpoint('https://ollama.com/api/v1', '', fetchMock)).toEqual({
      baseUrl: 'https://ollama.com/v1',
      schema: 'chat-completions',
      models: ['gpt-oss:120b'],
    });
  });

  it('returns null when nothing lists models', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await detectEndpoint('http://localhost:11434/v1', '', fetchMock)).toBeNull();
    expect(await detectEndpoint('', '', fetchMock)).toBeNull();
  });
});
