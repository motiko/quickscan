/*
 * fetch() over the app's native HTTP stack (Capacitor's CapacitorHttp plugin, called directly;
 * the global fetch stays the WebView's). Native requests aren't subject to CORS or the page's
 * CSP, so the app can reach any LLM endpoint a user enters: providers without CORS (Ollama
 * Cloud, which needs /api/llm on the web), self-hosted servers and gateways, plain-HTTP servers
 * on the local network. Only the subset of fetch the LLM client uses: a string URL, method,
 * headers, a string body and an AbortSignal; the body is read as text.
 */

type CapacitorHttpModule = typeof import('@capacitor/core');

let core: Promise<CapacitorHttpModule> | null = null;

function capacitor(): Promise<CapacitorHttpModule> {
  core ??= import('@capacitor/core');
  return core;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export async function nativeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const { signal } = init;
  if (signal?.aborted) throw abortError(signal);
  if (init.body != null && typeof init.body !== 'string') throw new TypeError('nativeFetch only sends string bodies');

  const { CapacitorHttp } = await capacitor();
  // It may have aborted while the plugin was loading
  if (signal?.aborted) throw abortError(signal);
  const request = CapacitorHttp.request({
    url: urlOf(input),
    method: init.method ?? 'GET',
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    // Sent as is on both platforms when it's a string, also for application/json
    data: init.body ?? undefined,
    responseType: 'text',
  });

  // The native request can't be cancelled; an abort (or timeout) stops waiting for it
  const response = await new Promise<Awaited<typeof request>>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal!));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.then(resolve, (err: unknown) => {
      // The same error fetch gives for an unreachable server, so callers handle both alike
      reject(new TypeError(`Failed to fetch: ${err instanceof Error ? err.message : String(err)}`));
    }).finally(() => signal?.removeEventListener('abort', onAbort));
  });

  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');
  // Response only takes 200–599; anything else means no real HTTP answer
  if (response.status < 200 || response.status > 599) throw new TypeError(`Failed to fetch: status ${response.status}`);
  return new Response([204, 205, 304].includes(response.status) ? null : body, {
    status: response.status,
    headers: response.headers,
  });
}
