import { describe, it, expect, vi } from 'vitest';
import { callLlm, LlmRefusalError, type LlmConfig, type LlmContentPart, type LlmRequest } from '@/lib/llm/client';
import { bytesToBase64, fitWithin } from '@/lib/llm/image';

const chat: LlmConfig = { schema: 'chat-completions', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk', model: 'm' };
const anthropic: LlmConfig = { schema: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model: 'm' };
const gemini: LlmConfig = { schema: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: 'g' };

const parts: LlmContentPart[] = [
  { type: 'text', text: 'Transcribe this page.' },
  { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' },
];

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { system: 'sys', content: parts, maxTokens: 4096, timeoutMs: 1000, ...overrides };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const chatReply = (content: string) => json({ choices: [{ message: { content } }] });

async function sentBody(config: LlmConfig, req: LlmRequest, response: Response) {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  const text = await callLlm(req, config, { fetchImpl });
  return { text, url: fetchImpl.mock.calls[0][0], init: fetchImpl.mock.calls[0][1], body: JSON.parse(fetchImpl.mock.calls[0][1].body) };
}

describe('callLlm request shapes', () => {
  it('sends text and image parts to Chat Completions endpoints', async () => {
    const { text, body } = await sentBody(chat, request(), chatReply('Hello'));
    expect(text).toBe('Hello');
    expect(body).toMatchObject({ model: 'm', temperature: 0.2, max_tokens: 4096 });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this page.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        ],
      },
    ]);
  });

  it('keeps string content as a plain string', async () => {
    const { body } = await sentBody(chat, request({ content: 'plain', temperature: 0 }), chatReply('x'));
    expect(body.messages[1]).toEqual({ role: 'user', content: 'plain' });
    expect(body.temperature).toBe(0);
  });

  it('uses max_completion_tokens and no temperature for OpenAI itself', async () => {
    const { body } = await sentBody({ ...chat, openaiNative: true }, request({ temperature: 0.5 }), chatReply('x'));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('sends base64 image blocks to Anthropic Messages endpoints', async () => {
    const { text, url, body } = await sentBody(
      anthropic,
      request(),
      json({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Page text' }] })
    );
    expect(text).toBe('Page text');
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(body).toMatchObject({ model: 'm', max_tokens: 4096, system: 'sys' });
    expect(body.temperature).toBeUndefined();
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this page.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        ],
      },
    ]);
  });

  it('sends inline data parts to Gemini and drops thought parts', async () => {
    const { text, body } = await sentBody(
      gemini,
      request({ temperature: 0 }),
      json({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: 'Summary' }] } }] })
    );
    expect(text).toBe('Summary');
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Transcribe this page.' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] },
    ]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 4096, temperature: 0 });
  });
});

describe('callLlm behavior', () => {
  it('routes chat completions to allowlisted hosts through the proxy', async () => {
    const { url, init } = await sentBody({ ...chat, baseUrl: 'https://ollama.com/v1' }, request(), chatReply('x'));
    expect(url).toBe('/api/llm');
    expect(init.method).toBe('POST');
    expect(init.headers['X-LLM-Target']).toBe('https://ollama.com/v1/chat/completions');
  });

  it('does not proxy other schemas', async () => {
    const { url } = await sentBody(
      { ...anthropic, baseUrl: 'https://ollama.com/v1' },
      request(),
      json({ content: [{ type: 'text', text: 'x' }] })
    );
    expect(url).toBe('https://ollama.com/v1/messages');
  });

  it('throws a refusal error when Anthropic declines', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ stop_reason: 'refusal', content: [] }));
    await expect(callLlm(request(), anthropic, { fetchImpl })).rejects.toBeInstanceOf(LlmRefusalError);
  });

  it('includes status and detail in HTTP errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 429 }));
    await expect(callLlm(request(), chat, { fetchImpl })).rejects.toThrow('LLM request failed (429): quota exceeded');
  });

  const hanging = () =>
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          if (init.signal!.aborted) reject(new DOMException('Aborted', 'AbortError'));
          init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })
    ) as unknown as typeof fetch;

  it('aborts after the timeout', async () => {
    await expect(callLlm(request({ timeoutMs: 10 }), chat, { fetchImpl: hanging() })).rejects.toThrow('Aborted');
  });

  it('aborts when the caller signal fires, including before the call', async () => {
    const controller = new AbortController();
    const pending = callLlm(request({ timeoutMs: 60000 }), chat, { fetchImpl: hanging(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('Aborted');

    await expect(
      callLlm(request({ timeoutMs: 60000 }), chat, { fetchImpl: hanging(), signal: AbortSignal.abort() })
    ).rejects.toThrow('Aborted');
  });
});

describe('fitWithin', () => {
  it('scales the longer edge down to the limit, keeping the aspect ratio', () => {
    expect(fitWithin(3000, 4000, 1568)).toEqual({ width: 1176, height: 1568 });
    expect(fitWithin(4000, 3000, 1568)).toEqual({ width: 1568, height: 1176 });
  });

  it('never upscales and keeps at least one pixel', () => {
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});

describe('bytesToBase64', () => {
  it('encodes large buffers without a data: prefix', () => {
    const bytes = new Uint8Array(100000).map((_, i) => i % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
