import { describe, it, expect, vi, afterEach } from 'vitest';
import { POST } from '@/app/api/llm/route';

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
});
