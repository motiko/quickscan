import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET, POST } from '@/app/api/llm/route';

function proxyRequest(target: string) {
  return new Request('http://localhost/api/llm', {
    method: 'POST',
    headers: { 'X-LLM-Target': target, Authorization: 'Bearer key', 'Content-Type': 'application/json' },
    body: '{"model":"m"}',
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('/api/llm proxy', () => {
  it('rejects targets outside the allowlist', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const target of [
      'https://evil.example/v1/chat/completions',
      'http://ollama.com/v1/chat/completions',
      'https://ollama.com/api/delete',
      '',
    ]) {
      expect((await POST(proxyRequest(target))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards body, auth and upstream status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":1}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(proxyRequest('https://ollama.com/v1/chat/completions'));

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"ok":1}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ollama.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer key');
    expect(init.body).toBe('{"model":"m"}');
  });

  it('never follows redirects (an allowlisted host cannot bounce the request elsewhere)', async () => {
    // fetch with redirect:'error' rejects on a 3xx; the proxy must surface that as a 502,
    // never transparently follow it to a host the allowlist never checked.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      throw new TypeError('unexpected redirect');
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(proxyRequest('https://ollama.com/v1/chat/completions'));
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized request body before forwarding it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    // Declared Content-Length over the cap is refused without reading the body. (A real
    // Request normalises Content-Length to the real body size, so use an explicit stub.)
    const headerMap = new Map([
      ['x-llm-target', 'https://ollama.com/v1/chat/completions'],
      ['content-length', String(64 * 1024 * 1024)],
    ]);
    const declared = {
      method: 'POST',
      headers: { get: (k: string) => headerMap.get(k.toLowerCase()) ?? null },
      text: () => Promise.reject(new Error('body must not be read when Content-Length is too large')),
    } as unknown as Request;
    expect((await POST(declared)).status).toBe(413);

    // An actually-oversized body is refused after reading, even if Content-Length lies.
    const big = new Request('http://localhost/api/llm', {
      method: 'POST',
      headers: { 'X-LLM-Target': 'https://ollama.com/v1/chat/completions' },
      body: 'x'.repeat(13 * 1024 * 1024),
    });
    expect((await POST(big)).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards model listings but no other GET targets', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[]}'));
    vi.stubGlobal('fetch', fetchMock);
    const get = (target: string) =>
      GET(new Request('http://localhost/api/llm', { headers: { 'X-LLM-Target': target, Authorization: 'Bearer key' } }));

    expect((await get('https://ollama.com/v1/chat/completions')).status).toBe(400);
    expect((await get('https://evil.example/v1/models')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    expect((await get('https://ollama.com/v1/models')).status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ollama.com/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer key');
    expect(init.body).toBeUndefined();
  });
});
