/**
 * Calls the real custom endpoint through the client and the /api/llm proxy, as the app does.
 * Needs CUSTOM_LLM_KEY (see .env.example); run with `npm run test:live`.
 */

import { describe, it, expect } from 'vitest';
import { GET, POST } from '@/app/api/llm/route';
import { PROXY_PATH, callLlm, type LlmConfig } from '@/lib/llm/client';
import { detectEndpoint } from '@/lib/llm/detect-endpoint';

const apiKey = process.env.CUSTOM_LLM_KEY ?? '';
const baseUrl = process.env.CUSTOM_LLM_BASE_URL || 'https://ollama.com/v1';
const model = process.env.CUSTOM_LLM_MODEL || 'gemma4:31b';

/** Global fetch, except that proxied requests go to the route handlers instead of a server. */
const fetchViaRoute: typeof fetch = async (input, init) => {
  if (input !== PROXY_PATH) return fetch(input, init);
  const request = new Request(`http://localhost${PROXY_PATH}`, init);
  return request.method === 'POST' ? POST(request) : GET(request);
};

describe.skipIf(!apiKey)('custom LLM endpoint (live)', () => {
  it('detects the endpoint and lists the configured model', async () => {
    const detected = await detectEndpoint(baseUrl, apiKey, fetchViaRoute);

    expect(detected?.schema).toBe('chat-completions');
    expect(detected?.models).toContain(model);
  });

  it('answers a text prompt', async () => {
    const config: LlmConfig = { schema: 'chat-completions', baseUrl, apiKey, model };
    const reply = await callLlm(
      {
        system: 'You are a test fixture. Follow the instruction exactly.',
        content: 'Reply with the single word PONG and nothing else.',
        maxTokens: 64,
        timeoutMs: 90_000,
        temperature: 0,
      },
      config,
      { fetchImpl: fetchViaRoute }
    );

    expect(reply.toUpperCase()).toContain('PONG');
  });
});
