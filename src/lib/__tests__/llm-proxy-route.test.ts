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
