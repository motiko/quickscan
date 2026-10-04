import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Passkey add/unlock/remove with a fake WebAuthn authenticator (PRF = HMAC-SHA256 of a
 * per-credential secret over the salt, like CTAP2 hmac-secret) and an in-memory
 * `vault_keys` table behind a mocked Supabase client. The real crypto and Dexie (on
 * fake-indexeddb) run underneath.
 */

type Row = { id: string; method: string; wrapped_key: string; params: Record<string, unknown>; label?: string; created_at?: string };

const RP_ID = 'quickscan.test';
const USER = { id: '6f1c1d2e-0000-4000-8000-000000000001', email: 'me@example.com' };

// --- Fake Supabase ------------------------------------------------------------------------

const server = { rows: new Map<string, Row>(), failNext: false };

function result<T>(data: T) {
  if (server.failNext) {
    server.failNext = false;
    return { data: null, error: { message: 'Failed to fetch' } };
  }
  return { data, error: null };
}

function filtered(filters: [string, unknown][]) {
  return [...server.rows.values()].filter((r) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v));
}

function from(table: string) {
  expect(table).toBe('vault_keys');
  return {
    select: () => {
      const filters: [string, unknown][] = [];
      const query = {
        eq: (col: string, value: unknown) => (filters.push([col, value]), query),
        limit: async (n: number) => result(filtered(filters).slice(0, n)),
        maybeSingle: async () => result(filtered(filters)[0] ?? null),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result(filtered(filters))).then(resolve),
      };
      return query;
    },
    insert: async (row: Row) => {
      if (server.rows.has(row.id)) return { error: { code: '23505', message: 'duplicate key' } };
      expect(row.method === 'recovery').toBe(row.id === 'recovery');
      server.rows.set(row.id, { ...row, created_at: row.created_at ?? new Date().toISOString() });
      return { error: null };
    },
    update: (patch: Partial<Row>) => {
      const filters: [string, unknown][] = [];
      const query = {
        eq: (col: string, value: unknown) => (filters.push([col, value]), query),
        then: (resolve: (v: unknown) => unknown) => {
          for (const r of filtered(filters)) server.rows.set(r.id, { ...r, ...patch });
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return query;
    },
    delete: () => {
      const filters: [string, unknown][] = [];
      const query = {
        eq: (col: string, value: unknown) => (filters.push([col, value]), query),
        then: (resolve: (v: unknown) => unknown) => {
          for (const r of filtered(filters)) server.rows.delete(r.id);
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

const auth = {
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  getSession: vi.fn(async () => ({ data: { session: { user: USER } } })),
};

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: async () => ({ auth, from }),
}));

// --- Fake authenticator -------------------------------------------------------------------

interface FakeCredential {
  rawId: Uint8Array<ArrayBuffer>;
  secret: CryptoKey;
}

const authenticator = {
  credentials: [] as FakeCredential[],
  /** Whether the "platform" knows PRF at all. */
  prf: true,
  /** Whether PRF results come back at create (Chrome) or only on get (iOS/Safari). */
  prfAtCreate: true,
  /** Throw this DOMException name from the next call. */
  failNext: null as string | null,
  /** Answer `get` with this credential regardless of allowCredentials. */
  forceCredential: null as FakeCredential | null,
  /** Which credential `get` picks among the allowed ones (index). */
  pick: 0,
  calls: [] as { kind: 'create' | 'get'; options: CredentialCreationOptions | CredentialRequestOptions }[],
};

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** What a browser hands the authenticator for a PRF salt (WebAuthn: SHA-256("WebAuthn PRF" || 0x00 || salt)). */
async function webauthnSalt(salt: BufferSource): Promise<ArrayBuffer> {
  const bytes = ArrayBuffer.isView(salt) ? new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength) : new Uint8Array(salt);
  const label = new TextEncoder().encode('WebAuthn PRF');
  const input = new Uint8Array(label.length + 1 + bytes.length);
  input.set(label);
  input.set(bytes, label.length + 1);
  return crypto.subtle.digest('SHA-256', input);
}

/** Browser PRF: hmac-secret over the hashed salt. */
async function prfOf(cred: FakeCredential, salt: BufferSource): Promise<ArrayBuffer> {
  return crypto.subtle.sign('HMAC', cred.secret, await webauthnSalt(salt));
}

// --- Fake native app (lib/native-passkey.ts) ----------------------------------------------

const native = {
  on: false,
  /** Whether iOS's PRF API hashes the salt like a browser, or hands it to the authenticator raw. */
  hashesSalt: true,
  failNext: null as string | null,
  calls: [] as { id: string; salt: string }[][],
};

vi.mock('@/lib/native-passkey', () => ({
  NATIVE_PASSKEY_RP_ID: 'quickscan.test',
  isNativeApp: () => native.on,
  isNativePasskeySupported: async () => true,
  getNativePrf: async (credentials: { id: string; salt: string }[]) => {
    native.calls.push(credentials);
    if (native.failNext) {
      const code = native.failNext;
      native.failNext = null;
      throw Object.assign(new Error(code), { code });
    }
    const allowed = credentials.map((c) => c.id);
    const cred = authenticator.credentials.filter((c) => allowed.includes(b64url(c.rawId)))[authenticator.pick];
    if (!cred) throw Object.assign(new Error('failed'), { code: 'failed' });
    const salt = Uint8Array.from(atob(credentials.find((c) => c.id === b64url(cred.rawId))!.salt), (ch) => ch.charCodeAt(0));
    const output = native.hashesSalt ? await prfOf(cred, salt) : await crypto.subtle.sign('HMAC', cred.secret, salt);
    return { credentialId: b64url(cred.rawId), first: new Uint8Array(output) };
  },
}));

function domError(name: string) {
  return Object.assign(new Error(name), { name });
}

function assertion(cred: FakeCredential, prf: AuthenticationExtensionsPRFOutputs | undefined) {
  return {
    rawId: cred.rawId.buffer,
    id: b64url(cred.rawId),
    type: 'public-key',
    getClientExtensionResults: () => (prf ? { prf } : {}),
  };
}

const credentialsApi = {
  create: vi.fn(async (options: CredentialCreationOptions) => {
    authenticator.calls.push({ kind: 'create', options });
    if (authenticator.failNext) {
      const name = authenticator.failNext;
      authenticator.failNext = null;
      throw domError(name);
    }
    const pk = options.publicKey!;
    expect(pk.rp.id).toBe(RP_ID);
    expect(pk.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const excluded = (pk.excludeCredentials ?? []).map((c) => b64url(new Uint8Array(c.id as ArrayBuffer)));
    if (authenticator.credentials.some((c) => excluded.includes(b64url(c.rawId)))) throw domError('InvalidStateError');
    const cred: FakeCredential = {
      rawId: crypto.getRandomValues(new Uint8Array(16)),
      secret: await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    };
    authenticator.credentials.push(cred);
    const salt = pk.extensions?.prf?.eval?.first;
    let prf: AuthenticationExtensionsPRFOutputs | undefined;
    if (authenticator.prf) {
      prf = { enabled: true };
      if (authenticator.prfAtCreate && salt) prf.results = { first: await prfOf(cred, salt) };
    }
    return assertion(cred, prf);
  }),
  get: vi.fn(async (options: CredentialRequestOptions) => {
    authenticator.calls.push({ kind: 'get', options });
    if (authenticator.failNext) {
      const name = authenticator.failNext;
      authenticator.failNext = null;
      throw domError(name);
    }
    const pk = options.publicKey!;
    expect(pk.rpId).toBe(RP_ID);
    expect(pk.userVerification).toBe('required');
    const allowed = (pk.allowCredentials ?? []).map((c) => b64url(new Uint8Array(c.id as ArrayBuffer)));
    const cred =
      authenticator.forceCredential ??
      authenticator.credentials.filter((c) => allowed.includes(b64url(c.rawId)))[authenticator.pick];
    if (!cred) throw domError('NotAllowedError');
    const id = b64url(cred.rawId);
    const salt = pk.extensions?.prf?.evalByCredential?.[id]?.first ?? pk.extensions?.prf?.eval?.first;
    const prf = authenticator.prf && salt ? { results: { first: await prfOf(cred, salt) } } : undefined;
    return assertion(cred, prf);
  }),
};

// --- Harness ------------------------------------------------------------------------------

async function load() {
  vi.resetModules();
  const vault = await import('@/lib/vault-session');
  const passkeys = await import('@/lib/passkeys');
  const crypto = await import('@/lib/crypto');
  vault.subscribeVault(() => {});
  return { vault, passkeys, crypto };
}

async function waitForStatus(vault: typeof import('@/lib/vault-session'), status: string) {
  await vi.waitFor(() => expect(vault.getVaultStatus().status).toBe(status));
}

/** First device: turn sync on (unlocked), returning the vault key's probe ciphertext. */
async function unlockedDevice() {
  const loaded = await load();
  await waitForStatus(loaded.vault, 'no-vault');
  await loaded.vault.createVault(loaded.crypto.generateRecoveryKey());
  return loaded;
}

/** A second device: same account, no local key. */
async function newDevice() {
  const crypto = await import('@/lib/crypto');
  const { db } = await import('@/lib/db');
  await crypto.clearVaultKey();
  await db.syncMeta.clear();
  const loaded = await load();
  await waitForStatus(loaded.vault, 'locked');
  return loaded;
}

async function probe() {
  const crypto = await import('@/lib/crypto');
  const stored = await crypto.loadVaultKey();
  const iv = new Uint8Array(12);
  return new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, stored!.key, new TextEncoder().encode('probe'))
  );
}

const passkeyRows = () => [...server.rows.values()].filter((r) => r.method === 'passkey');

beforeEach(async () => {
  const win = new EventTarget();
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { hostname: RP_ID });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { credentials: credentialsApi, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 });
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  server.rows.clear();
  server.failNext = false;
  Object.assign(authenticator, { credentials: [], prf: true, prfAtCreate: true, failNext: null, forceCredential: null, pick: 0, calls: [] });
  Object.assign(native, { on: false, hashesSalt: true, failNext: null, calls: [] });
  vi.clearAllMocks();
  const crypto = await import('@/lib/crypto');
  const { db } = await import('@/lib/db');
  await crypto.clearVaultKey();
  await db.syncMeta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('addPasskey', () => {
  it('stores the vault key wrapped by the PRF output when results come back at create', async () => {
    const { passkeys } = await unlockedDevice();
    const added = await passkeys.addPasskey();

    expect(authenticator.calls.map((c) => c.kind)).toEqual(['create']);
    const create = authenticator.calls[0].options as CredentialCreationOptions;
    expect(new TextDecoder().decode(create.publicKey!.user.id as ArrayBuffer)).toBe(USER.id);
    expect(create.publicKey!.user.name).toBe(USER.email);
    expect((create.publicKey!.extensions!.prf!.eval!.first as Uint8Array).length).toBe(32);

    const rows = passkeyRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(added.id);
    expect(row.id).toBe(b64url(authenticator.credentials[0].rawId));
    expect(row.label).toBe('iPhone passkey');
    expect(row.wrapped_key).toMatch(/^\\x[0-9a-f]{122}$/);
    expect(row.params).toMatchObject({
      v: 1,
      method: 'passkey',
      kdf: 'HKDF-SHA256',
      alg: 'AES-256-GCM',
      credentialId: row.id,
      rpId: RP_ID,
    });
    expect(typeof row.params.salt).toBe('string');
    expect(typeof row.params.prfSalt).toBe('string');
  });

  it('runs a follow-up get with the same salt when PRF is enabled but has no results at create (iOS)', async () => {
    authenticator.prfAtCreate = false;
    const { passkeys } = await unlockedDevice();
    await passkeys.addPasskey();

    expect(authenticator.calls.map((c) => c.kind)).toEqual(['create', 'get']);
    const createSalt = (authenticator.calls[0].options as CredentialCreationOptions).publicKey!.extensions!.prf!.eval!.first;
    const get = (authenticator.calls[1].options as CredentialRequestOptions).publicKey!;
    expect(get.allowCredentials).toHaveLength(1);
    expect(b64url(new Uint8Array(get.allowCredentials![0].id as ArrayBuffer))).toBe(b64url(authenticator.credentials[0].rawId));
    expect(new Uint8Array(get.extensions!.prf!.eval!.first as ArrayBuffer)).toEqual(new Uint8Array(createSalt as ArrayBuffer));
    expect(passkeyRows()).toHaveLength(1);

    // …and that row really unlocks a new device
    const device = await newDevice();
    await device.passkeys.unlockWithPasskey();
    expect(device.vault.getVaultStatus().status).toBe('unlocked');
  });

  it('asks for a fresh tap when the follow-up get is refused, then finishes', async () => {
    authenticator.prfAtCreate = false;
    const { passkeys } = await unlockedDevice();
    credentialsApi.get.mockImplementationOnce(async () => {
      throw domError('NotAllowedError');
    });
    const err = await passkeys.addPasskey().catch((e) => e);
    expect(err).toMatchObject({ code: 'needs-confirmation' });
    expect(passkeyRows()).toHaveLength(0);
    await passkeys.finishPasskey(err.pending);
    expect(passkeyRows()).toHaveLength(1);
  });

  it('saves nothing when the platform has no PRF', async () => {
    authenticator.prf = false;
    const { passkeys } = await unlockedDevice();
    await expect(passkeys.addPasskey()).rejects.toMatchObject({ code: 'unsupported' });
    expect(passkeyRows()).toHaveLength(0);
  });

  it('saves nothing when PRF is enabled but the follow-up get has no results', async () => {
    authenticator.prfAtCreate = false;
    const { passkeys } = await unlockedDevice();
    credentialsApi.get.mockImplementationOnce(async () => assertion(authenticator.credentials[0], undefined));
    await expect(passkeys.addPasskey()).rejects.toMatchObject({ code: 'unsupported' });
    expect(passkeyRows()).toHaveLength(0);
  });

  it('turns a cancelled prompt into a friendly error', async () => {
    const { passkeys } = await unlockedDevice();
    authenticator.failNext = 'NotAllowedError';
    const err = await passkeys.addPasskey().catch((e) => e);
    expect(err).toMatchObject({ name: 'PasskeyError', code: 'cancelled' });
    expect(err.message).toMatch(/cancelled/);
    expect(passkeyRows()).toHaveLength(0);
  });

  it('refuses a second passkey in the same password manager (excludeCredentials)', async () => {
    const { passkeys } = await unlockedDevice();
    const first = await passkeys.addPasskey();
    await expect(passkeys.addPasskey({ excludeIds: [first.id] })).rejects.toMatchObject({ code: 'already-added' });
  });

  it('needs an unlocked device', async () => {
    const { passkeys, vault } = await load();
    await waitForStatus(vault, 'no-vault');
    await expect(passkeys.addPasskey()).rejects.toMatchObject({ code: 'locked' });
    expect(credentialsApi.create).not.toHaveBeenCalled();
  });
});

describe('unlockWithPasskey', () => {
  it('unlocks a new device with the right credential', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const expected = await probe();

    const device = await newDevice();
    const events = vi.fn();
    window.addEventListener(device.vault.VAULT_CHANGED_EVENT, events);
    await device.passkeys.unlockWithPasskey(await device.passkeys.listPasskeys());

    expect(device.vault.getVaultStatus().status).toBe('unlocked');
    expect(events).toHaveBeenCalledTimes(1);
    expect(await probe()).toEqual(expected);
    const { db } = await import('@/lib/db');
    expect((await db.syncMeta.get('vaultOwner'))?.value).toBe(USER.id);
  });

  it('selects among several passkeys with evalByCredential, each with its own salt', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey({ label: 'One' });
    await first.passkeys.addPasskey({ label: 'Two' });
    const rows = passkeyRows();
    expect(rows[0].params.prfSalt).not.toBe(rows[1].params.prfSalt);

    const device = await newDevice();
    authenticator.pick = 1; // the second passkey answers
    authenticator.calls = [];
    await device.passkeys.unlockWithPasskey();

    const get = (authenticator.calls[0].options as CredentialRequestOptions).publicKey!;
    expect(get.allowCredentials).toHaveLength(2);
    const evalBy = get.extensions!.prf!.evalByCredential!;
    expect(Object.keys(evalBy).sort()).toEqual(rows.map((r) => r.id).sort());
    for (const r of rows) expect(b64url(new Uint8Array(evalBy[r.id].first as ArrayBuffer))).toBe(b64url(Uint8Array.from(atob(r.params.prfSalt as string), (c) => c.charCodeAt(0))));
    expect(device.vault.getVaultStatus().status).toBe('unlocked');
  });

  it('rejects a credential that is not one of the rows', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const device = await newDevice();
    authenticator.forceCredential = {
      rawId: crypto.getRandomValues(new Uint8Array(16)),
      secret: await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    };
    await expect(device.passkeys.unlockWithPasskey()).rejects.toMatchObject({ code: 'unknown-passkey' });
    expect(device.vault.getVaultStatus().status).toBe('locked');
  });

  it('turns a cancelled prompt into a friendly error', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const device = await newDevice();
    authenticator.failNext = 'NotAllowedError';
    await expect(device.passkeys.unlockWithPasskey()).rejects.toMatchObject({ code: 'cancelled' });
    expect(device.vault.getVaultStatus().status).toBe('locked');
  });

  it('does not unlock with a passkey whose row was removed meanwhile', async () => {
    const first = await unlockedDevice();
    const added = await first.passkeys.addPasskey();
    const device = await newDevice();
    const listed = await device.passkeys.listPasskeys();
    server.rows.delete(added.id); // removed on another device after this one loaded the list
    await expect(device.passkeys.unlockWithPasskey(listed)).rejects.toMatchObject({ code: 'unknown-passkey' });
    expect(device.vault.getVaultStatus().status).toBe('locked');
  });

  it('only offers passkeys bound to this hostname', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const device = await newDevice();
    vi.stubGlobal('location', { hostname: 'quickscan-preview.example' });
    await expect(device.passkeys.unlockWithPasskey()).rejects.toMatchObject({ code: 'no-passkeys' });
    expect(credentialsApi.get).not.toHaveBeenCalled();
  });

  it('reports a wrong PRF output as wrong-passkey', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const device = await newDevice();
    // Same credential id, different secret: the PRF output doesn't open the wrapped key.
    authenticator.credentials[0].secret = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    await expect(device.passkeys.unlockWithPasskey()).rejects.toMatchObject({ code: 'wrong-passkey' });
  });
});

describe('unlockWithPasskey in the native app', () => {
  it('asks iOS instead of the web view, with the salt as the website passes it', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const expected = await probe();

    const device = await newDevice();
    native.on = true;
    await device.passkeys.unlockWithPasskey();

    expect(credentialsApi.get).not.toHaveBeenCalled();
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0][0].salt).toBe(passkeyRows()[0].params.prfSalt);
    expect(device.passkeys.nativePrfSaltMode).toBe('as-on-web');
    expect(device.vault.getVaultStatus().status).toBe('unlocked');
    expect(await probe()).toEqual(expected);
  });

  it('asks once more with the pre-hashed salt when iOS takes the salt raw', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const device = await newDevice();
    native.on = true;
    native.hashesSalt = false;
    await device.passkeys.unlockWithPasskey();

    expect(native.calls).toHaveLength(2);
    const salt = Uint8Array.from(atob(passkeyRows()[0].params.prfSalt as string), (c) => c.charCodeAt(0));
    expect(native.calls[1][0].salt).toBe(btoa(String.fromCharCode(...new Uint8Array(await webauthnSalt(salt)))));
    expect(device.passkeys.nativePrfSaltMode).toBe('pre-hashed');
    expect(device.vault.getVaultStatus().status).toBe('unlocked');
  });

  it('reports wrong-passkey when neither salt opens the key', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const device = await newDevice();
    native.on = true;
    authenticator.credentials[0].secret = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    await expect(device.passkeys.unlockWithPasskey()).rejects.toMatchObject({ code: 'wrong-passkey' });
    expect(native.calls).toHaveLength(2);
    expect(device.vault.getVaultStatus().status).toBe('locked');
  });

  it('turns plugin errors into friendly codes', async () => {
    const first = await unlockedDevice();
    await first.passkeys.addPasskey();
    const device = await newDevice();
    native.on = true;
    native.failNext = 'cancelled';
    await expect(device.passkeys.unlockWithPasskey()).rejects.toMatchObject({ code: 'cancelled' });
    native.failNext = 'not-associated';
    await expect(device.passkeys.unlockWithPasskey()).rejects.toMatchObject({ code: 'site' });
  });

  it("can't add a passkey yet", async () => {
    const first = await unlockedDevice();
    native.on = true;
    await expect(first.passkeys.addPasskey()).rejects.toMatchObject({ code: 'add-on-web' });
    expect(credentialsApi.create).not.toHaveBeenCalled();
  });
});

describe('managing passkeys', () => {
  it('lists, renames and removes passkey rows without touching the recovery row', async () => {
    const { passkeys } = await unlockedDevice();
    const added = await passkeys.addPasskey();
    expect(await passkeys.listPasskeys()).toMatchObject([{ id: added.id, label: 'iPhone passkey', rpId: RP_ID }]);

    await passkeys.renamePasskey(added.id, '  Work phone  ');
    expect((await passkeys.listPasskeys())[0].label).toBe('Work phone');

    await passkeys.removePasskey(added);
    expect(await passkeys.listPasskeys()).toEqual([]);
    expect(server.rows.has('recovery')).toBe(true);
    await passkeys.removePasskey({ id: 'recovery', rpId: RP_ID });
    expect(server.rows.has('recovery')).toBe(true);
  });
});

describe('support and labels', () => {
  it('reads getClientCapabilities when available', async () => {
    const { passkeys } = await load();
    expect(await passkeys.getPasskeySupport()).toBe('unknown');
    const PKC = Object.assign(function PublicKeyCredential() {}, {
      getClientCapabilities: async () => ({ 'extension:prf': false }),
    });
    vi.stubGlobal('PublicKeyCredential', PKC);
    expect(await passkeys.getPasskeySupport()).toBe('unsupported');
    PKC.getClientCapabilities = async () => ({ 'extension:prf': true });
    expect(await passkeys.getPasskeySupport()).toBe('supported');
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(await passkeys.getPasskeySupport()).toBe('unsupported');
  });

  it('derives a label from the user agent', async () => {
    const { defaultPasskeyLabel } = await import('@/lib/passkeys');
    expect(defaultPasskeyLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone passkey');
    expect(defaultPasskeyLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('iPad passkey');
    expect(defaultPasskeyLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac passkey');
    expect(defaultPasskeyLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBe('Android passkey');
    expect(defaultPasskeyLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows passkey');
    expect(defaultPasskeyLabel('curl/8')).toBe('Passkey');
  });
});
