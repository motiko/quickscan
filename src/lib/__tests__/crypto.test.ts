import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  CryptoError,
  clearVaultKey,
  createPairingKeyPair,
  decodePairingPublicKey,
  decryptFile,
  decryptRecord,
  openRecord,
  encodePairingPublicKey,
  encryptFile,
  encryptRecord,
  formatRecoveryKey,
  generateRecoveryKey,
  generateVaultKey,
  isValidRecoveryKey,
  loadTransferableVaultKey,
  loadVaultKey,
  openPairedVaultKey,
  parseRecoveryKey,
  sealVaultKeyForPairing,
  storeVaultKey,
  unwrapVaultKey,
  unwrapVaultKeyWithRecoveryKey,
  wrapVaultKey,
  wrapVaultKeyWithRecoveryKey,
} from '@/lib/crypto';
import { recordAad } from '@/lib/crypto/records';

/*
 * Known-answer vectors were computed independently with node:crypto (createCipheriv
 * 'aes-256-gcm', hkdfSync 'sha256') from the byte layouts documented in src/lib/crypto.
 */

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const range = (start: number, n: number) => Uint8Array.from({ length: n }, (_, i) => start + i);

const VAULT_RAW = range(0, 32);
const importVault = (extractable = true) =>
  crypto.subtle.importKey('raw', VAULT_RAW, 'AES-GCM', extractable, ['encrypt', 'decrypt']);

/** Feed fixed bytes to the next getRandomValues calls (tests only; production code has no hook). */
function injectRandom(...chunks: Uint8Array[]) {
  const real = crypto.getRandomValues.bind(crypto);
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    const next = chunks.shift();
    if (!next) return real(arr as never) as T;
    expect(next.length).toBe((arr as unknown as Uint8Array).length);
    (arr as unknown as Uint8Array).set(next);
    return arr;
  });
}

afterEach(() => vi.restoreAllMocks());

async function expectCryptoError(p: Promise<unknown>, code: CryptoError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(CryptoError);
  expect((err as CryptoError).code).toBe(code);
}

const ctx = { userId: 'user-1', kind: 'document', id: 'doc-1' };

describe('known-answer vectors', () => {
  it('encodes the record AAD as versioned, length-prefixed fields', () => {
    expect(hex(recordAad(ctx))).toBe(
      '01' +
        '00000010' + hex(new TextEncoder().encode('quickscan/record')) +
        '00000006' + hex(new TextEncoder().encode('user-1')) +
        '00000008' + hex(new TextEncoder().encode('document')) +
        '00000005' + hex(new TextEncoder().encode('doc-1'))
    );
    // Moving bytes between fields changes the encoding
    expect(hex(recordAad({ userId: 'user-1d', kind: 'ocument', id: 'doc-1' }))).not.toBe(hex(recordAad(ctx)));
  });

  it('encrypts a record to a fixed payload', async () => {
    injectRandom(range(0xa0, 12));
    const payload = await encryptRecord(await importVault(), ctx, {
      name: 'Grüße ✓',
      createdAt: new Date(1700000000000),
      tags: ['a'],
    });
    expect(hex(payload)).toBe(
      '01a0a1a2a3a4a5a6a7a8a9aaab9d3a124c28ae20854022f510bbb95fbb504ec583b09b600fee6b47f21acf3475f04c3cdd8b4632493abe3ef93e4ab3c9772b767852e02a4e3c72292ac517f6928ee7a70e12f899f10697141d7f32535112ee4f733bf4ed'
    );
  });

  it('encrypts a file to fixed bytes', async () => {
    injectRandom(range(0xb0, 12));
    const enc = await encryptFile(await importVault(), { userId: 'user-1', fileId: 'file-1' }, new Blob(['hello file']));
    expect(hex(new Uint8Array(await enc.arrayBuffer()))).toBe(
      '01b0b1b2b3b4b5b6b7b8b9babbf13036c783eddd362b9d25cdaac0e652d0dc834147c4a1d430ce'
    );
  });

  it('wraps the vault key with HKDF + AES-GCM to a fixed row', async () => {
    injectRandom(range(0x20, 32), range(0x40, 12));
    const { wrappedKey, params } = await wrapVaultKey(await importVault(), range(1, 16), {
      userId: 'user-1',
      method: 'recovery',
    });
    expect(hex(wrappedKey)).toBe(
      '01404142434445464748494a4b238c4f9d0708c19a1be8fff2e7c8181a7426944f5a8d3a8b3c45ca8b25effa1f61e0037bb1b01e4f3f1ff72ec18df8d8'
    );
    expect(params).toEqual({
      v: 1,
      method: 'recovery',
      kdf: 'HKDF-SHA256',
      salt: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
      alg: 'AES-256-GCM',
    });
    const key = await unwrapVaultKey({ wrappedKey, params }, range(1, 16), { userId: 'user-1' });
    expect(hex(new Uint8Array(await crypto.subtle.exportKey('raw', key)))).toBe(hex(VAULT_RAW));
  });

  it('formats fixed recovery key bytes', () => {
    // First 26 characters: plain Crockford base32 of the bytes; last 2: check symbols
    expect(formatRecoveryKey(range(0, 16))).toBe('000G-40R4-0M30-E209-185G-R38E-1W15');
    expect(formatRecoveryKey(new Uint8Array(16).fill(0xff))).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZWZF');
    expect(formatRecoveryKey(new Uint8Array(16))).toBe('0000-0000-0000-0000-0000-0000-0000');
    expect(hex(parseRecoveryKey('000G-40R4-0M30-E209-185G-R38E-1W15'))).toBe(hex(range(0, 16)));
  });
});

describe('records', () => {
  it('round-trips nested objects, unicode, Dates and bytes', async () => {
    const key = await generateVaultKey();
    const value = {
      name: 'Rechnung — 東京 🧾',
      createdAt: new Date('2026-01-02T03:04:05.678Z'),
      nested: { list: [1, 'two', null, true, { deep: new Date(0) }], empty: {} },
      bytes: Uint8Array.of(0, 1, 254, 255),
      $weird: { $date: 'not a date' },
      proto: JSON.parse('{"__proto__": {"polluted": true}}'),
      skipped: undefined,
    };
    const back = await decryptRecord<Record<string, unknown>>(key, ctx, await encryptRecord(key, ctx, value));
    const expected: Record<string, unknown> = { ...value };
    delete expected.skipped;
    expect(back).toEqual(expected);
    expect(back.createdAt).toBeInstanceOf(Date);
    expect(back.bytes).toBeInstanceOf(Uint8Array);
    expect(Object.getPrototypeOf(back.proto)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('round-trips top-level primitives and arrays', async () => {
    const key = await generateVaultKey();
    for (const value of ['text', 42, null, false, [new Date(5)]]) {
      expect(await decryptRecord(key, ctx, await encryptRecord(key, ctx, value))).toEqual(value);
    }
  });

  it('refuses values that would not survive', async () => {
    const key = await generateVaultKey();
    for (const value of [{ b: new Blob(['x']) }, new Map(), NaN, { d: new Date('nope') }, BigInt(1), () => 1]) {
      await expect(encryptRecord(key, ctx, value)).rejects.toThrow(TypeError);
    }
  });

  it('fails with the wrong key', async () => {
    const payload = await encryptRecord(await generateVaultKey(), ctx, { a: 1 });
    await expectCryptoError(decryptRecord(await generateVaultKey(), ctx, payload), 'auth-failed');
  });

  it('fails on any flipped bit', async () => {
    const key = await generateVaultKey();
    const payload = await encryptRecord(key, ctx, { a: 'b' });
    for (const i of [1, 12, 13, payload.length - 1]) {
      const bad = payload.slice();
      bad[i] ^= 0x01;
      await expectCryptoError(decryptRecord(key, ctx, bad), 'auth-failed');
    }
    const badVersion = payload.slice();
    badVersion[0] = 0x03;
    await expectCryptoError(decryptRecord(key, ctx, badVersion), 'unsupported-version');
  });

  it('v2 authenticates the clock, device id and deletion flag', async () => {
    const key = await generateVaultKey();
    const version = { updatedAt: 1_791_028_800_123, deviceId: 'device-1', deleted: false };
    const payload = await encryptRecord(key, ctx, { a: 1 }, version);
    expect(payload[0]).toBe(0x02);
    const row = { deviceId: 'device-1', deleted: false };
    expect(await openRecord(key, ctx, payload, row)).toEqual({ value: { a: 1 }, format: 2, updatedAt: version.updatedAt });
    await expectCryptoError(decryptRecord(key, ctx, payload, { ...row, deviceId: 'device-2' }), 'auth-failed');
    await expectCryptoError(decryptRecord(key, ctx, payload, { ...row, deleted: true }), 'auth-failed');
    // Re-dating the payload (its clock header) breaks it
    const redated = payload.slice();
    redated[8] ^= 0x01;
    await expectCryptoError(decryptRecord(key, ctx, redated, row), 'auth-failed');
    // A v2 payload can't be checked without its row, nor presented as v1
    await expectCryptoError(decryptRecord(key, ctx, payload), 'malformed');
    const asV1 = payload.slice();
    asV1[0] = 0x01;
    await expectCryptoError(decryptRecord(key, ctx, asV1, row), 'auth-failed');
    // v1 payloads still decrypt, with or without the row
    const v1 = await encryptRecord(key, ctx, { old: true });
    expect(await openRecord(key, ctx, v1, row)).toEqual({ value: { old: true }, format: 1 });
  });

  it('fails when the ciphertext is presented as another record', async () => {
    const key = await generateVaultKey();
    const payload = await encryptRecord(key, ctx, { a: 1 });
    for (const other of [
      { ...ctx, id: 'doc-2' },
      { ...ctx, kind: 'page' },
      { ...ctx, userId: 'user-2' },
    ]) {
      await expectCryptoError(decryptRecord(key, other, payload), 'auth-failed');
    }
  });

  it('fails on truncated input', async () => {
    const key = await generateVaultKey();
    const payload = await encryptRecord(key, ctx, { a: 1 });
    await expectCryptoError(decryptRecord(key, ctx, payload.slice(0, payload.length - 1)), 'auth-failed');
    await expectCryptoError(decryptRecord(key, ctx, payload.slice(0, 20)), 'malformed');
    await expectCryptoError(decryptRecord(key, ctx, new Uint8Array(0)), 'malformed');
  });

  it('uses a unique IV for every encryption', async () => {
    const key = await generateVaultKey();
    const ivs = new Set<string>();
    for (let i = 0; i < 1000; i++) ivs.add(hex((await encryptRecord(key, ctx, { i })).slice(1, 13)));
    expect(ivs.size).toBe(1000);
  });
});

describe('files', () => {
  const fctx = { userId: 'user-1', fileId: 'file-1' };

  it('round-trips an empty file', async () => {
    const key = await generateVaultKey();
    const enc = await encryptFile(key, fctx, new Blob([]));
    expect(enc.size).toBe(1 + 12 + 16);
    const back = await decryptFile(key, fctx, enc, { type: 'image/png' });
    expect(back.size).toBe(0);
    expect(back.type).toBe('image/png');
  });

  it('round-trips a ~5 MB file', async () => {
    const key = await generateVaultKey();
    const data = new Uint8Array(5 * 1024 * 1024 + 3);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
    const enc = await encryptFile(key, fctx, new Blob([data], { type: 'image/jpeg' }));
    expect(enc.size).toBe(data.length + 29);
    const back = new Uint8Array(await (await decryptFile(key, fctx, new Uint8Array(await enc.arrayBuffer()))).arrayBuffer());
    expect(back.length).toBe(data.length);
    expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
  });

  it('fails with the wrong key, a flipped bit, another file id or user, or truncation', async () => {
    const key = await generateVaultKey();
    const enc = new Uint8Array(await (await encryptFile(key, fctx, new Blob(['image bytes']))).arrayBuffer());
    await expectCryptoError(decryptFile(await generateVaultKey(), fctx, enc), 'auth-failed');
    const flipped = enc.slice();
    flipped[20] ^= 0x80;
    await expectCryptoError(decryptFile(key, fctx, flipped), 'auth-failed');
    await expectCryptoError(decryptFile(key, { ...fctx, fileId: 'file-2' }, enc), 'auth-failed');
    await expectCryptoError(decryptFile(key, { ...fctx, userId: 'user-2' }, enc), 'auth-failed');
    await expectCryptoError(decryptFile(key, fctx, enc.slice(0, -4)), 'auth-failed');
    await expectCryptoError(decryptFile(key, fctx, enc.slice(0, 10)), 'malformed');
  });

  it('does not decrypt a record payload as a file', async () => {
    const key = await generateVaultKey();
    const payload = await encryptRecord(key, { userId: 'user-1', kind: 'file', id: 'file-1' }, 'x');
    await expectCryptoError(decryptFile(key, fctx, payload), 'auth-failed');
  });
});

describe('recovery key', () => {
  it('generates keys that parse back', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(parseRecoveryKey(key)).toHaveLength(16);
    expect(generateRecoveryKey()).not.toBe(key);
  });

  it('accepts lowercase, missing or extra dashes and spaces, and O/I/L look-alikes', () => {
    const canonical = formatRecoveryKey(range(0, 16));
    const bytes = hex(range(0, 16));
    for (const input of [
      canonical.toLowerCase(),
      canonical.replace(/-/g, ''),
      ` ${canonical.replace(/-/g, ' - ')}  `,
      canonical.replace(/-/g, '--'),
      canonical.replace(/0/g, 'o').replace(/1/g, 'l'),
      canonical.replace(/1/g, 'I'),
    ]) {
      expect(hex(parseRecoveryKey(input))).toBe(bytes);
    }
  });

  it('detects every single-character typo', () => {
    const key = formatRecoveryKey(range(7, 16)).replace(/-/g, '');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (let i = 0; i < key.length; i++) {
      for (const ch of alphabet) {
        if (ch === key[i]) continue;
        expect(isValidRecoveryKey(key.slice(0, i) + ch + key.slice(i + 1))).toBe(false);
      }
    }
  });

  it('detects every swap of adjacent characters', () => {
    const key = formatRecoveryKey(range(100, 16)).replace(/-/g, '');
    for (let i = 0; i + 1 < key.length; i++) {
      if (key[i] === key[i + 1]) continue;
      expect(isValidRecoveryKey(key.slice(0, i) + key[i + 1] + key[i] + key.slice(i + 2))).toBe(false);
    }
  });

  it('rejects wrong lengths and characters with a typed error', () => {
    const key = formatRecoveryKey(range(0, 16));
    for (const bad of [key.slice(0, -1), `${key}0`, key.replace(/G/, 'U'), key.replace(/G/, '!'), '']) {
      expect(() => parseRecoveryKey(bad)).toThrow(CryptoError);
    }
  });

  it('wraps and unwraps the vault key; a typo fails before decryption, a wrong key after', async () => {
    const vault = await generateVaultKey();
    const recovery = generateRecoveryKey();
    const row = await wrapVaultKeyWithRecoveryKey(vault, recovery, { userId: 'u' });
    const back = await unwrapVaultKeyWithRecoveryKey(row, recovery.toLowerCase(), { userId: 'u' });
    expect(hex(new Uint8Array(await crypto.subtle.exportKey('raw', back)))).toBe(
      hex(new Uint8Array(await crypto.subtle.exportKey('raw', vault)))
    );

    const chars = recovery.split('');
    chars[0] = chars[0] === 'A' ? 'B' : 'A';
    const decrypt = vi.spyOn(crypto.subtle, 'unwrapKey');
    await expectCryptoError(unwrapVaultKeyWithRecoveryKey(row, chars.join(''), { userId: 'u' }), 'invalid-recovery-key');
    expect(decrypt).not.toHaveBeenCalled();

    await expectCryptoError(unwrapVaultKeyWithRecoveryKey(row, generateRecoveryKey(), { userId: 'u' }), 'auth-failed');
  });
});

describe('generic wrap', () => {
  it('round-trips with a 32-byte passkey PRF secret', async () => {
    const vault = await generateVaultKey();
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const row = await wrapVaultKey(vault, prf, { userId: 'u', method: 'passkey' });
    expect(row.wrappedKey).toHaveLength(61);
    expect(row.params.method).toBe('passkey');
    const back = await unwrapVaultKey(row, prf, { userId: 'u' });
    const payload = await encryptRecord(vault, ctx, 'secret');
    expect(await decryptRecord(back, ctx, payload)).toBe('secret');
  });

  it('fails for a wrong secret, another user, tampered params or a flipped bit', async () => {
    const vault = await generateVaultKey();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const row = await wrapVaultKey(vault, secret, { userId: 'u', method: 'passkey' });
    await expectCryptoError(unwrapVaultKey(row, crypto.getRandomValues(new Uint8Array(32)), { userId: 'u' }), 'auth-failed');
    await expectCryptoError(unwrapVaultKey(row, secret, { userId: 'other' }), 'auth-failed');
    await expectCryptoError(unwrapVaultKey({ ...row, params: { ...row.params, method: 'recovery' } }, secret, { userId: 'u' }), 'auth-failed');
    await expectCryptoError(unwrapVaultKey({ ...row, params: { ...row.params, kdf: 'PBKDF2' } }, secret, { userId: 'u' }), 'malformed');
    await expectCryptoError(unwrapVaultKey({ ...row, params: { ...row.params, v: 2 } }, secret, { userId: 'u' }), 'unsupported-version');
    const flipped = row.wrappedKey.slice();
    flipped[30] ^= 1;
    await expectCryptoError(unwrapVaultKey({ ...row, wrappedKey: flipped }, secret, { userId: 'u' }), 'auth-failed');
    await expectCryptoError(unwrapVaultKey({ ...row, wrappedKey: row.wrappedKey.slice(0, 20) }, secret, { userId: 'u' }), 'malformed');
  });

  it('refuses short secrets and non-extractable keys', async () => {
    const vault = await generateVaultKey();
    await expect(wrapVaultKey(vault, new Uint8Array(8), { userId: 'u', method: 'recovery' })).rejects.toThrow(RangeError);
    await expect(wrapVaultKey(await importVault(false), new Uint8Array(16), { userId: 'u', method: 'recovery' })).rejects.toThrow();
  });
});

describe('pairing', () => {
  it('seals the vault key to a new device and opens it there', async () => {
    const vault = await generateVaultKey();
    const pair = await createPairingKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    const qr = encodePairingPublicKey(pair.publicKey);
    expect(qr).toMatch(/^[A-Za-z0-9_-]{87}$/);

    const sealed = await sealVaultKeyForPairing(vault, decodePairingPublicKey(qr), 'req-1');
    expect(sealed).toHaveLength(126);
    const opened = await openPairedVaultKey(pair, sealed, 'req-1');
    expect(await decryptRecord(opened, ctx, await encryptRecord(vault, ctx, { ok: true }))).toEqual({ ok: true });
  });

  it('fails with the wrong key pair, request id, tampering or truncation', async () => {
    const vault = await generateVaultKey();
    const pair = await createPairingKeyPair();
    const sealed = await sealVaultKeyForPairing(vault, pair.publicKey, 'req-1');
    await expectCryptoError(openPairedVaultKey(await createPairingKeyPair(), sealed, 'req-1'), 'auth-failed');
    await expectCryptoError(openPairedVaultKey(pair, sealed, 'req-2'), 'auth-failed');
    const flipped = sealed.slice();
    flipped[sealed.length - 5] ^= 1;
    await expectCryptoError(openPairedVaultKey(pair, flipped, 'req-1'), 'auth-failed');
    const badPoint = sealed.slice();
    badPoint[10] ^= 1; // the ephemeral public key is no longer on the curve
    await expect(openPairedVaultKey(pair, badPoint, 'req-1')).rejects.toBeInstanceOf(CryptoError);
    await expectCryptoError(openPairedVaultKey(pair, sealed.slice(0, 70), 'req-1'), 'malformed');
    await expectCryptoError(openPairedVaultKey(pair, sealed.slice(0, -1), 'req-1'), 'auth-failed');
  });

  it('rejects malformed public keys', async () => {
    const vault = await generateVaultKey();
    expect(() => decodePairingPublicKey('abc')).toThrow(CryptoError);
    await expectCryptoError(sealVaultKeyForPairing(vault, new Uint8Array(65).fill(4), 'r'), 'malformed');
  });
});

describe('vault key on the device', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('stores a non-extractable key that still decrypts, and nothing raw', async () => {
    const transient = await generateVaultKey();
    const payload = await encryptRecord(transient, ctx, { hello: 'world' });
    const stored = await storeVaultKey(transient, { keyVersion: 3 });
    expect(stored.key.extractable).toBe(false);

    const loaded = await loadVaultKey();
    expect(loaded?.keyVersion).toBe(3);
    expect(loaded!.key.extractable).toBe(false);
    expect(loaded!.key.usages.sort()).toEqual(['decrypt', 'encrypt']);
    await expect(crypto.subtle.exportKey('raw', loaded!.key)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('jwk', loaded!.key)).rejects.toThrow();
    expect(await decryptRecord(loaded!.key, ctx, payload)).toEqual({ hello: 'world' });

    // No raw key bytes anywhere in the stored row
    const raw = hex(new Uint8Array(await crypto.subtle.exportKey('raw', transient)));
    const row = (await db.syncMeta.get('vaultKey'))!.value as Record<string, unknown>;
    for (const v of Object.values(row)) {
      if (v instanceof Uint8Array) expect(hex(v)).not.toContain(raw);
      if (v instanceof CryptoKey) expect(v.extractable).toBe(false);
    }
  });

  it('refuses to store a non-extractable key (it could never be re-wrapped)', async () => {
    await expect(storeVaultKey(await importVault(false))).rejects.toThrow(TypeError);
  });

  it('gives a transient extractable copy for pairing from the stored key', async () => {
    const transient = await generateVaultKey();
    await storeVaultKey(transient);
    const copy = await loadTransferableVaultKey();
    expect(copy!.extractable).toBe(true);

    const pair = await createPairingKeyPair();
    const opened = await openPairedVaultKey(pair, await sealVaultKeyForPairing(copy!, pair.publicKey, 'r'), 'r');
    const { key } = (await loadVaultKey())!;
    expect(await decryptRecord(opened, ctx, await encryptRecord(key, ctx, 'x'))).toBe('x');
  });

  it('clears the key', async () => {
    await storeVaultKey(await generateVaultKey());
    await clearVaultKey();
    expect(await loadVaultKey()).toBeNull();
    expect(await loadTransferableVaultKey()).toBeNull();
  });

  it('is not recorded in the sync outbox', async () => {
    await storeVaultKey(await generateVaultKey());
    expect(await db.outbox.count()).toBe(0);
  });
});
