import { describe, it, expect, vi } from 'vitest';
import { cleanLlmTitle, chatCompletionsUrl, suggestNameWithLlm } from '@/lib/naming/llm';

const config = { baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-test', model: 'some/model' };

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
