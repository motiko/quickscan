import { isNativeApp } from '@/lib/native-passkey';

/**
 * fetch for LLM requests. Inside the app, native HTTP (`platform/native/http.ts`): no CORS, so
 * every endpoint a user enters works, including the ones the web needs /api/llm for
 * (`viaLlmProxy` is false there). On the web, the browser's fetch.
 */
export const llmFetch: typeof fetch = async (input, init) => {
  if (!isNativeApp()) return fetch(input, init);
  const { nativeFetch } = await import('@/lib/platform/native/http');
  return nativeFetch(input, init);
};
