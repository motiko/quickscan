import { PROXY_TARGET_HEADER, isProxiedUrl } from '@/lib/naming/llm';

/**
 * Forwards chat completion requests to LLM providers that don't allow browser CORS
 * requests. Restricted to PROXIED_HOSTS so it can't be used as an open proxy.
 */
export async function POST(request: Request): Promise<Response> {
  const target = request.headers.get(PROXY_TARGET_HEADER) ?? '';
  if (!isProxiedUrl(target) || !new URL(target).pathname.endsWith('/chat/completions')) {
    return new Response('Target not allowed', { status: 400 });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers.Authorization = auth;

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: await request.text(),
      signal: request.signal,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (err) {
    return new Response(`Upstream request failed: ${(err as Error).message}`, { status: 502 });
  }
}
