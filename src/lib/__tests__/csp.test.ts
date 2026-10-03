import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, buildCsp, buildWorkerCsp, createNonce, supabaseOrigins } from '../csp';

function directive(csp: string, name: string): string[] | undefined {
  for (const part of csp.split(';')) {
    const [key, ...values] = part.trim().split(/\s+/);
    if (key === name) return values;
  }
  return undefined;
}

describe('document CSP', () => {
  it('allows only nonced scripts, with no inline or eval', () => {
    const csp = buildCsp({ nonce: 'abc123' });
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(csp).not.toMatch(/unsafe-eval|wasm-unsafe-eval/);
  });

  it('locks down framing, plugins, base and forms', () => {
    const csp = buildCsp({ nonce: 'n' });
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
    expect(directive(csp, 'form-action')).toEqual(["'self'"]);
    expect(directive(csp, 'img-src')).toEqual(["'self'", 'blob:', 'data:']);
    expect(directive(csp, 'worker-src')).toEqual(["'self'"]);
  });

  it('adds eval and the HMR websocket only in development', () => {
    const csp = buildCsp({ nonce: 'n', dev: true });
    expect(directive(csp, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(csp, 'connect-src')).toContain('ws:');
    expect(directive(buildCsp({ nonce: 'n' }), 'connect-src')).not.toContain('ws:');
  });

  it('upgrades insecure requests only when asked (HTTPS)', () => {
    expect(buildCsp({ nonce: 'n', upgradeInsecureRequests: true })).toMatch(/; upgrade-insecure-requests$/);
    expect(buildCsp({ nonce: 'n' })).not.toMatch(/upgrade-insecure-requests/);
  });

  it('reaches the Supabase project over https and wss, LLM endpoints and local model servers', () => {
    const connect = directive(buildCsp({ supabaseUrl: 'https://abc.supabase.co' }), 'connect-src');
    expect(connect).toEqual([
      "'self'",
      'https://abc.supabase.co',
      'wss://abc.supabase.co',
      'https:',
      'http://localhost:*',
      'http://127.0.0.1:*',
    ]);
  });
});

describe('worker CSP', () => {
  it('allows WebAssembly but no eval and no nonce', () => {
    const csp = buildWorkerCsp();
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directive(csp, 'connect-src')).toContain('https:');
  });
});

describe('supabaseOrigins', () => {
  it('derives https and wss origins, dropping any path', () => {
    expect(supabaseOrigins('https://abc.supabase.co/')).toEqual(['https://abc.supabase.co', 'wss://abc.supabase.co']);
  });

  it('handles a local stack, and missing or bogus URLs', () => {
    expect(supabaseOrigins('http://127.0.0.1:54321')).toEqual(['http://127.0.0.1:54321', 'ws://127.0.0.1:54321']);
    expect(supabaseOrigins(undefined)).toEqual([]);
    expect(supabaseOrigins('not a url')).toEqual([]);
    expect(supabaseOrigins('javascript:alert(1)')).toEqual([]);
  });
});

describe('createNonce', () => {
  it('is 128 random bits, base64, different every time', () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });
});

describe('SECURITY_HEADERS', () => {
  it('grants the camera to this origin only and denies other powerful features', () => {
    const policy = SECURITY_HEADERS.find((h) => h.key === 'Permissions-Policy')!.value;
    expect(policy).toContain('camera=(self)');
    expect(policy).toContain('microphone=()');
    expect(policy).toContain('geolocation=()');
  });
});
