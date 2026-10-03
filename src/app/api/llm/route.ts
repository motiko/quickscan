import { PROXY_TARGET_HEADER, isProxiedUrl } from '@/lib/llm/client';

/**
 * Forwards chat completion requests (POST) and model listings (GET) to LLM providers that
 * don't allow browser CORS requests. Restricted to PROXIED_HOSTS so it can't be used as an
 * open proxy.
 *
 * Hardening (see docs/security/pentest-2026-10.md):
 * - `redirect: 'error'` so an allowlisted host can't bounce the request to a host that isn't
 *   on the allowlist (an internal address, say): the allowlist check is on the URL we call,
 *   and following a redirect would call a URL nobody checked. A redirect becomes a 502.
 * - A request-body cap, so the stateless proxy can't be made to buffer an unbounded body.
 *   Vision payloads are downscaled on the device and stay well under this.
 */

/** Largest request body the proxy will forward (base64 vision payloads stay well below this). */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

async function forward(request: Request, allowedPathSuffix: string): Promise<Response> {
  const target = request.headers.get(PROXY_TARGET_HEADER) ?? '';
  if (!isProxiedUrl(target) || !new URL(target).pathname.endsWith(allowedPathSuffix)) {
    return new Response('Target not allowed', { status: 400 });
  }

  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (request.method === 'POST') {
    const declared = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return new Response('Request body too large', { status: 413 });
    }
    body = await request.text();
    if (new Blob([body]).size > MAX_BODY_BYTES) {
      return new Response('Request body too large', { status: 413 });
    }
    headers['Content-Type'] = 'application/json';
  }
  const auth = request.headers.get('Authorization');
  if (auth) headers.Authorization = auth;

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      // Never follow a redirect: it would reach a URL the allowlist never checked.
      redirect: 'error',
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
