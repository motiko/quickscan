import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@capacitor/core', () => ({ CapacitorHttp: { request: (...args: unknown[]) => request(...args) } }));
vi.mock('@/lib/native-passkey', () => ({ isNativeApp: vi.fn(() => true) }));

const { nativeFetch } = await import('@/lib/platform/native/http');
const { llmFetch } = await import('@/lib/llm/transport');
const { viaLlmProxy } = await import('@/lib/llm/client');
const { isNativeApp } = await import('@/lib/native-passkey');

beforeEach(() => {
  request.mockReset();
  vi.mocked(isNativeApp).mockReturnValue(true);
});

describe('nativeFetch', () => {
  it('sends the request natively and answers like fetch', async () => {
    request.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: '{"ok":true}' });

    const response = await nativeFetch('http://192.168.1.20:11434/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
      body: '{"model":"m"}',
    });

    expect(request).toHaveBeenCalledWith({
      url: 'http://192.168.1.20:11434/v1/chat/completions',
      method: 'POST',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
      data: '{"model":"m"}',
      responseType: 'text',
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('passes error statuses through, with their body', async () => {
    request.mockResolvedValue({ status: 401, headers: {}, data: 'bad key' });

    const response = await nativeFetch('https://ollama.com/v1/models');

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('bad key');
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'GET', data: undefined });
  });

  it('turns an unreachable server into the TypeError fetch gives', async () => {
    request.mockRejectedValue(new Error('Could not connect to the server.'));

    await expect(nativeFetch('http://10.0.0.9/v1/models')).rejects.toThrow(/^Failed to fetch: Could not connect/);
  });

  it('stops waiting when the signal aborts, with its reason', async () => {
    request.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();

    const pending = nativeFetch('https://api.example.com/v1/models', { signal: controller.signal });
    controller.abort(new DOMException('timed out', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('refuses before sending when already aborted', async () => {
    await expect(nativeFetch('https://x.test', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('LLM transport', () => {
  it('uses native HTTP in the app and the browser fetch on the web', async () => {
    request.mockResolvedValue({ status: 200, headers: {}, data: '{}' });
    await llmFetch('https://api.openai.com/v1/models');
    expect(request).toHaveBeenCalledTimes(1);

    vi.mocked(isNativeApp).mockReturnValue(false);
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await llmFetch('https://api.openai.com/v1/models');
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    browserFetch.mockRestore();
  });

  it('goes through /api/llm only on the web', () => {
    expect(viaLlmProxy('https://ollama.com/v1/chat/completions', 'chat-completions')).toBe(false);
    vi.mocked(isNativeApp).mockReturnValue(false);
    expect(viaLlmProxy('https://ollama.com/v1/chat/completions', 'chat-completions')).toBe(true);
    expect(viaLlmProxy('https://api.openai.com/v1/chat/completions', 'chat-completions')).toBe(false);
  });
});

describe('isCleartextOverInternet', async () => {
  const { isCleartextOverInternet } = await import('@/lib/llm/client');

  it('flags plain http:// to public hosts only', () => {
    for (const url of ['http://api.example.com/v1', 'http://203.0.113.5:11434', 'http://[2001:db8::1]/v1']) {
      expect(isCleartextOverInternet(url), url).toBe(true);
    }
    for (const url of [
      'https://api.example.com/v1',
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080',
      'http://192.168.1.20:11434/v1',
      'http://10.0.0.5',
      'http://172.20.1.1',
      'http://100.101.102.103:11434',
      'http://ollama.local:11434',
      'http://homeserver:11434',
      'http://[::1]:11434',
      'http://[fd12:3456::1]/v1',
      'not a url',
    ]) {
      expect(isCleartextOverInternet(url), url).toBe(false);
    }
  });
});
