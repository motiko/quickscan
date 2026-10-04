import { describe, expect, it, vi } from 'vitest';

// Like Capacitor's registerPlugin: a proxy that turns every property, `then` included, into a
// native call. The native side has no "then" method, so that call never answers.
const calls: string[] = [];
vi.mock('@capacitor/core', () => ({
  registerPlugin: () =>
    new Proxy(
      {},
      {
        get: (_, prop) => (...args: unknown[]) => {
          calls.push(String(prop));
          if (prop === 'isSupported') return Promise.resolve({ supported: true });
          if (prop === 'getPrf') return Promise.resolve({ credentialId: 'abc', first: btoa('\x01\x02') });
          return new Promise(() => void args);
        },
      }
    ),
}));

const { getNativePrf, isNativePasskeySupported } = await import('@/lib/native-passkey');

describe('native passkey plugin', () => {
  it('answers without calling a native "then"', async () => {
    await expect(isNativePasskeySupported()).resolves.toBe(true);
    await expect(getNativePrf([{ id: 'abc', salt: 'c2FsdA==' }])).resolves.toEqual({
      credentialId: 'abc',
      first: new Uint8Array([1, 2]),
    });
    expect(calls).not.toContain('then');
  });
});
