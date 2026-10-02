import { PROXY_TARGET_HEADER, isProxiedUrl } from '@/lib/llm/client';

/**
 * Forwards chat completion requests (POST) and model listings (GET) to LLM providers that
 * don't allow browser CORS requests. Restricted to PROXIED_HOSTS so it can't be used as an
 * open proxy.
 */
async function forward(request: Request, allowedPathSuffix: string): Promise<Response> {
  const target = request.headers.get(PROXY_TARGET_HEADER) ?? '';
  if (!isProxiedUrl(target) || !new URL(target).pathname.endsWith(allowedPathSuffix)) {
    return new Response('Target not allowed', { status: 400 });
  }

  const headers: Record<string, string> = {};
  if (request.method === 'POST') headers['Content-Type'] = 'application/json';
  const auth = request.headers.get('Authorization');
  if (auth) headers.Authorization = auth;

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.text() : undefined,
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

export function POST(request: Request): Promise<Response> {
  return forward(request, '/chat/completions');
}

export function GET(request: Request): Promise<Response> {
  return forward(request, '/models');
}
