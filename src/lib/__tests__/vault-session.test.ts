import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The vault flows against an in-memory `vault_keys` table behind a mocked Supabase client.
 * Modules are re-imported per test so the store starts fresh; the real crypto and Dexie
 * (on fake-indexeddb) run underneath.
 */

type Row = { id: string; method: string; wrapped_key: string; params: unknown; created_at?: string };
type Listener = (event: string, session: unknown) => void;

const server = {
  rows: new Map<string, Row>(),
  failNext: false,
  /** Runs right before an insert, e.g. another device creating the vault meanwhile. */
  beforeInsert: null as null | (() => void),
};

const auth = {
  listener: null as Listener | null,
  session: null as unknown,
  onAuthStateChange: vi.fn((cb: Listener) => {
    auth.listener = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  }),
  getSession: vi.fn(async () => ({ data: { session: auth.session } })),
  signOut: vi.fn(async () => {
    auth.listener?.('SIGNED_OUT', null);
    return { error: null };
  }),
};

function result<T>(data: T) {
  if (server.failNext) {
    server.failNext = false;
    return { data: null, error: { message: 'Failed to fetch' } };
  }
  return { data, error: null };
}

function from(table: string) {
  expect(table).toBe('vault_keys');
  return {
    select: () => {
      let rows = [...server.rows.values()];
      const query = {
        eq: (col: 'id', value: string) => {
          rows = rows.filter((r) => r[col] === value);
          return query;
        },
        limit: async (n: number) => result(rows.slice(0, n)),
        maybeSingle: async () => result(rows[0] ?? null),
      };
      return query;
    },
    insert: async (row: Row) => {
      if (server.failNext) return result(null);
      server.beforeInsert?.();
      if (server.rows.has(row.id)) {
        return { error: { code: '23505', message: 'duplicate key value violates unique constraint "vault_keys_pkey"' } };
      }
      server.rows.set(row.id, row);
      return { error: null };
    },
    upsert: async (row: Row, opts: { onConflict: string }) => {
      expect(opts.onConflict).toBe('user_id,id');
      server.rows.set(row.id, { ...server.rows.get(row.id), ...row });
      return { error: null };
    },
  };
}

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: async () => ({ auth, from }),
}));

const USER = { id: 'user-1', email: 'me@example.com' };

async function load() {
  vi.resetModules();
  const vault = await import('@/lib/vault-session');
  const crypto = await import('@/lib/crypto');
  const authModule = await import('@/lib/auth');
  const { db } = await import('@/lib/db');
  const events = vi.fn();
  window.addEventListener(vault.VAULT_CHANGED_EVENT, events);
  vault.subscribeVault(() => {});
  return { vault, crypto, auth: authModule, db, events };
}

async function waitForStatus(vault: typeof import('@/lib/vault-session'), status: string) {
  await vi.waitFor(() => expect(vault.getVaultStatus().status).toBe(status));
}

/** A vault created by "another device" with this recovery key. */
async function seedVault(recoveryKey: string) {
  const crypto = await import('@/lib/crypto');
  const { toBytea } = await import('@/lib/bytea');
  const vaultKey = await crypto.generateVaultKey();
  const { wrappedKey, params } = await crypto.wrapVaultKeyWithRecoveryKey(vaultKey, recoveryKey, { userId: USER.id });
  server.rows.set('recovery', { id: 'recovery', method: 'recovery', wrapped_key: toBytea(wrappedKey), params });
  return vaultKey;
}

async function sameKey(a: CryptoKey, b: CryptoKey) {
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a, new TextEncoder().encode('probe'));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b, ct);
  return new TextDecoder().decode(pt) === 'probe';
}

beforeEach(async () => {
  vi.stubGlobal('window', new EventTarget());
  server.rows.clear();
  server.failNext = false;
  server.beforeInsert = null;
  auth.session = { user: USER };
  auth.listener = null;
  vi.clearAllMocks();
  const { db } = await import('@/lib/db');
  await db.syncMeta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('vault status', () => {
  it('is no-vault for a signed-in account without a vault_keys row', async () => {
    const { vault } = await load();
    await waitForStatus(vault, 'no-vault');
  });

  it('is locked when the account has a vault but this device has no key', async () => {
    await seedVault((await import('@/lib/crypto')).generateRecoveryKey());
    const { vault } = await load();
    await waitForStatus(vault, 'locked');
  });

  it('is signed-out without a session', async () => {
    auth.session = null;
    const { vault } = await load();
    await waitForStatus(vault, 'signed-out');
  });

  it('reports a network error and recovers on refresh', async () => {
    server.failNext = true;
    const { vault } = await load();
    await waitForStatus(vault, 'error');
    await vault.refreshVault();
    expect(vault.getVaultStatus().status).toBe('no-vault');
  });

  it('drops a stored key that belongs to another account', async () => {
    const crypto = await import('@/lib/crypto');
    const { db } = await import('@/lib/db');
    await db.syncMeta.put({ key: 'vaultOwner', value: 'someone-else' });
    await crypto.storeVaultKey(await crypto.generateVaultKey());
    const { vault } = await load();
    await waitForStatus(vault, 'no-vault');
    expect(await crypto.loadVaultKey()).toBeNull();
  });
});

describe('createVault', () => {
  it('stores the wrapped key on the server and the vault key on this device', async () => {
    const { vault, crypto, events } = await load();
    await waitForStatus(vault, 'no-vault');
    const recoveryKey = crypto.generateRecoveryKey();

    expect(await vault.createVault(recoveryKey)).toBe('created');
    expect(vault.getVaultStatus().status).toBe('unlocked');
    expect(events).toHaveBeenCalledTimes(1);

    const row = server.rows.get('recovery')!;
    expect(row.method).toBe('recovery');
    expect(row.wrapped_key).toMatch(/^\\x[0-9a-f]{122}$/); // 61 bytes as bytea hex
    expect(JSON.stringify(row)).not.toContain(recoveryKey);

    // The server row opens with the recovery key to the key stored here.
    const { fromBytea } = await import('@/lib/bytea');
    const unwrapped = await crypto.unwrapVaultKeyWithRecoveryKey(
      { wrappedKey: fromBytea(row.wrapped_key), params: row.params },
      recoveryKey,
      { userId: USER.id }
    );
    const stored = await crypto.loadVaultKey();
    expect(stored!.key.extractable).toBe(false);
    expect(await sameKey(unwrapped, stored!.key)).toBe(true);
  });

  it("doesn't overwrite a vault another device created meanwhile, and switches to locked", async () => {
    const { vault, crypto, events } = await load();
    await waitForStatus(vault, 'no-vault');
    // Another device wins the race between our check and our insert.
    await seedVault(crypto.generateRecoveryKey());
    const theirs = server.rows.get('recovery')!;
    server.rows.clear();
    server.beforeInsert = () => server.rows.set('recovery', theirs);

    expect(await vault.createVault(crypto.generateRecoveryKey())).toBe('exists');
    expect(vault.getVaultStatus().status).toBe('locked');
    expect(server.rows.get('recovery')).toBe(theirs);
    expect(await crypto.loadVaultKey()).toBeNull();
    expect(events).not.toHaveBeenCalled();
  });

  it('keeps the device without a key when the server is unreachable', async () => {
    const { vault, crypto } = await load();
    await waitForStatus(vault, 'no-vault');
    server.failNext = true;
    await expect(vault.createVault(crypto.generateRecoveryKey())).rejects.toMatchObject({ code: 'network' });
    expect(await crypto.loadVaultKey()).toBeNull();
    expect(vault.getVaultStatus().status).toBe('no-vault');
  });
});

describe('unlockVault', () => {
  it('unlocks with the right recovery key, in any formatting', async () => {
    const crypto = await import('@/lib/crypto');
    const recoveryKey = crypto.generateRecoveryKey();
    const original = await seedVault(recoveryKey);
    const loaded = await load();
    await waitForStatus(loaded.vault, 'locked');

    await loaded.vault.unlockVault(` ${recoveryKey.toLowerCase().replace(/-/g, ' ')} `);
    expect(loaded.vault.getVaultStatus().status).toBe('unlocked');
    expect(loaded.events).toHaveBeenCalledTimes(1);
    const stored = await loaded.crypto.loadVaultKey();
    expect(await sameKey(original, stored!.key)).toBe(true);
  });

  it('rejects a valid but wrong key as wrong-recovery-key', async () => {
    const crypto = await import('@/lib/crypto');
    await seedVault(crypto.generateRecoveryKey());
    const { vault, events } = await load();
    await waitForStatus(vault, 'locked');

    await expect(vault.unlockVault(crypto.generateRecoveryKey())).rejects.toMatchObject({ code: 'wrong-recovery-key' });
    expect(vault.getVaultStatus().status).toBe('locked');
    expect(await crypto.loadVaultKey()).toBeNull();
    expect(events).not.toHaveBeenCalled();
  });

  it('rejects a typo as invalid-recovery-key without asking the server', async () => {
    const crypto = await import('@/lib/crypto');
    const recoveryKey = crypto.generateRecoveryKey();
    await seedVault(recoveryKey);
    const { vault } = await load();
    await waitForStatus(vault, 'locked');

    const first = recoveryKey[0] === 'A' ? 'B' : 'A';
    const typo = first + recoveryKey.slice(1);
    server.failNext = true; // would surface as 'network' if the server were asked
    await expect(vault.unlockVault(typo)).rejects.toMatchObject({ code: 'invalid-recovery-key' });
    server.failNext = false;
  });

  it('moves to no-vault when the row is gone', async () => {
    const crypto = await import('@/lib/crypto');
    await seedVault(crypto.generateRecoveryKey());
    const { vault } = await load();
    await waitForStatus(vault, 'locked');
    server.rows.clear();
    await expect(vault.unlockVault(crypto.generateRecoveryKey())).rejects.toMatchObject({ code: 'no-vault' });
    expect(vault.getVaultStatus().status).toBe('no-vault');
  });
});

describe('replaceRecoveryKey', () => {
  it('re-wraps the vault key so only the new recovery key opens the row', async () => {
    const { vault, crypto } = await load();
    await waitForStatus(vault, 'no-vault');
    const oldKey = crypto.generateRecoveryKey();
    await vault.createVault(oldKey);

    const newKey = crypto.generateRecoveryKey();
    await vault.replaceRecoveryKey(newKey);
    expect(server.rows.size).toBe(1);
    const row = server.rows.get('recovery')!;
    expect(row.method).toBe('recovery');

    const { fromBytea } = await import('@/lib/bytea');
    const wrapped = { wrappedKey: fromBytea(row.wrapped_key), params: row.params };
    await expect(crypto.unwrapVaultKeyWithRecoveryKey(wrapped, oldKey, { userId: USER.id })).rejects.toMatchObject({
      code: 'auth-failed',
    });
    const unwrapped = await crypto.unwrapVaultKeyWithRecoveryKey(wrapped, newKey, { userId: USER.id });
    expect(await sameKey(unwrapped, (await crypto.loadVaultKey())!.key)).toBe(true);
  });

  it('needs an unlocked device', async () => {
    const { vault, crypto } = await load();
    await waitForStatus(vault, 'no-vault');
    await expect(vault.replaceRecoveryKey(crypto.generateRecoveryKey())).rejects.toMatchObject({ code: 'locked' });
  });
});

describe('sign-out', () => {
  it('forgets the vault key on this device and keeps the server row', async () => {
    const { vault, crypto, auth: authModule, events } = await load();
    await waitForStatus(vault, 'no-vault');
    await vault.createVault(crypto.generateRecoveryKey());
    events.mockClear();

    await authModule.signOut();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(await crypto.loadVaultKey()).toBeNull();
    expect(events).toHaveBeenCalledTimes(1);
    await waitForStatus(vault, 'signed-out');
    expect(server.rows.has('recovery')).toBe(true);
  });
});

describe('checkRecoveryKeyInput', () => {
  it('tells incomplete input from typos', async () => {
    const { vault, crypto } = await load();
    const key = crypto.generateRecoveryKey();
    expect(vault.checkRecoveryKeyInput('')).toBe('empty');
    expect(vault.checkRecoveryKeyInput(key.slice(0, 10))).toBe('incomplete');
    expect(vault.checkRecoveryKeyInput(key)).toBe('valid');
    expect(vault.checkRecoveryKeyInput(key.toLowerCase().replace(/-/g, ''))).toBe('valid');
    expect(vault.checkRecoveryKeyInput('K7QU')).toBe('typo'); // U isn't in the alphabet
    expect(vault.checkRecoveryKeyInput(key + 'X')).toBe('typo');
    const last = key.at(-1) === '0' ? '1' : '0';
    expect(vault.checkRecoveryKeyInput(key.slice(0, -1) + last)).toBe('typo');
  });
});
