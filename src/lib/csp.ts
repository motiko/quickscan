/*
 * Content-Security-Policy and the other security headers. The vault key is non-extractable
 * but usable by any script running in our origin, so XSS is the threat that matters most:
 * keep script-src tight and read SECURITY.md before adding a network destination.
 *
 * Shared by `src/proxy.ts` (per-request nonce policy for documents) and `next.config.ts`
 * (static headers, plus the policy dedicated workers get from their script's response).
 */

export interface CspOptions {
  /** Per-request nonce for Next's inline and bootstrap scripts. */
  nonce?: string;
  /** `next dev`: React needs eval for error overlays, HMR talks over a websocket. */
  dev?: boolean;
  /** NEXT_PUBLIC_SUPABASE_URL, if this build has an account backend. */
  supabaseUrl?: string;
  /** Only over HTTPS: on plain-HTTP localhost, Safari would "upgrade" every subresource and break the page. */
  upgradeInsecureRequests?: boolean;
}

/** https and wss origins of the Supabase project (REST/Auth/Storage, and Realtime). */
export function supabaseOrigins(url: string | undefined): string[] {
  if (!url) return [];
  try {
    const { protocol, host } = new URL(url);
    if (protocol !== 'https:' && protocol !== 'http:') return [];
    // http only for a local `supabase start` stack
    return protocol === 'https:' ? [`https://${host}`, `wss://${host}`] : [`http://${host}`, `ws://${host}`];
  } catch {
    return [];
  }
}

/**
 * connect-src. LLM endpoints are user-configurable (any OpenAI-/Anthropic-compatible URL,
 * called directly from the browser so prompts and keys never pass through our server), so
 * any https origin has to be reachable, plus a model server on this machine (Ollama, LM
 * Studio). See SECURITY.md for why this is acceptable.
 */
function connectSources(options: CspOptions): string[] {
  return [
    "'self'",
    ...supabaseOrigins(options.supabaseUrl),
    'https:',
    'http://localhost:*',
    'http://127.0.0.1:*',
    ...(options.dev ? ['ws:'] : []),
  ];
}

function serialize(directives: Record<string, string[]>, upgradeInsecureRequests?: boolean): string {
  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (upgradeInsecureRequests) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** Policy for documents, sent by the proxy with a fresh nonce per response. */
export function buildCsp(options: CspOptions = {}): string {
  const { nonce, dev } = options;
  const scriptSrc = [
    // 'self' only matters to browsers without 'strict-dynamic' (CSP2), which ignore the nonce
    "'self'",
    // 'strict-dynamic' lets Next's nonced bootstrap load its chunks; CSP3 browsers then
    // ignore 'self', so only nonced scripts and what they load can run.
    ...(nonce ? [`'nonce-${nonce}'`, "'strict-dynamic'"] : []),
    ...(dev ? ["'unsafe-eval'"] : []),
  ];

  return serialize(
    {
      'default-src': ["'self'"],
      'script-src': scriptSrc,
      // Both workers load from same-origin URLs: Tesseract from public/tesseract, the scanner as a Next chunk
      'worker-src': ["'self'"],
      // React renders style="" attributes into the HTML. CSS can't run script, and
      // img-src/font-src keep CSS-based exfiltration on our own origin.
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'blob:', 'data:'],
      'font-src': ["'self'"],
      'connect-src': connectSources(options),
      'manifest-src': ["'self'"],
      'frame-src': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
    options.upgradeInsecureRequests
  );
}

/**
 * Policy for dedicated workers, which take the CSP of their own script response rather
 * than the page's. Static (no nonce): workers load their code with importScripts or ES
 * imports from our origin. Tesseract and scanic compile WebAssembly, which needs
 * 'wasm-unsafe-eval'; that permits WebAssembly compilation only, not JS eval.
 */
export function buildWorkerCsp(options: Omit<CspOptions, 'nonce'> = {}): string {
  return serialize({
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'", ...(options.dev ? ["'unsafe-eval'"] : [])],
    'connect-src': connectSources(options),
    'img-src': ["'self'", 'blob:', 'data:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
  });
}

/** Random, unguessable, fresh per response. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Headers for every response. CSP is not here: documents get a nonce policy from the proxy,
 * worker scripts a static one from next.config.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    // Camera for scanning; clipboard-write and web-share keep their default ('self').
    value: [
      'camera=(self)',
      'microphone=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'serial=()',
      'hid=()',
      'bluetooth=()',
      'midi=()',
      'display-capture=()',
      'browsing-topics=()',
    ].join(', '),
  },
  // Browsers ignore HSTS over plain HTTP, so this is harmless on localhost.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];
