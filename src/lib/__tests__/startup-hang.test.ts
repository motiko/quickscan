import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Regression tests for the iOS start-up hang: when IndexedDB doesn't answer (an upgrade blocked
 * by a frozen tab), "Checking sync…" must turn into an error with Retry, and sign-out must still
 * sign out, with the vault key unusable until it can be deleted.
 */

type Listener = (event: string, session: unknown) => void;

const USER = { id: 'user-1', email: 'me@example.com' };

const auth = {
  listener: null as Listener | null,
  session: null as unknown,
  onAuthStateChange: vi.fn((cb: Listener) => {
    auth.listener = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  }),
  getSession: vi.fn(async () => ({ data: { session: auth.session } })),
  signOut: vi.fn(async (): Promise<{ error: unknown }> => {
    auth.session = null;
    auth.listener?.('SIGNED_OUT', null);
    return { error: null };
  }),
};

const vaultRows = { rows: [] as { id: string }[], hang: false };

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: async () => ({
    auth,
    from: () => ({
      select: () => ({
        limit: () => (vaultRows.hang ? new Promise(() => {}) : Promise.resolve({ data: vaultRows.rows, error: null })),
      }),
    }),
  }),
}));

const never = () => new Promise<never>(() => {});
const storage = {
  loadVaultKey: vi.fn<() => Promise<unknown>>(async () => null),
  clearVaultKey: vi.fn<() => Promise<void>>(async () => {}),
};

vi.mock('@/lib/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto')>();
  return {
    ...actual,
    loadVaultKey: () => storage.loadVaultKey(),
    clearVaultKey: () => storage.clearVaultKey(),
  };
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}

async function load() {
  vi.resetModules();
  const vault = await import('@/lib/vault-session');
  const authModule = await import('@/lib/auth');
  return { vault, auth: authModule };
}

/** Sign in and let the auth store pick up the session. */
async function signedIn(vault: typeof import('@/lib/vault-session')) {
  vault.subscribeVault(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(auth.getSession).toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', memoryStorage());
  auth.session = { user: USER };
  auth.listener = null;
  vaultRows.rows = [];
  vaultRows.hang = false;
  storage.loadVaultKey.mockImplementation(async () => null);
  storage.clearVaultKey.mockImplementation(async () => {});
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sync status check', () => {
  it('turns "checking" into a storage error with Retry when the local database never answers', async () => {
    storage.loadVaultKey.mockImplementation(never);
    const { vault } = await load();
    await signedIn(vault);
    expect(vault.getVaultStatus().status).toBe('checking');

    await vi.advanceTimersByTimeAsync(vault.LOCAL_CHECK_TIMEOUT_MS);
    const state = vault.getVaultStatus();
    expect(state.status).toBe('error');
    expect(state.status === 'error' && state.message).toMatch(/storage/);

    // Retry once storage answers again
    storage.loadVaultKey.mockImplementation(async () => null);
    await vault.refreshVault();
    expect(vault.getVaultStatus().status).toBe('no-vault');
  });

  it('turns "checking" into a network error when the server never answers', async () => {
    vaultRows.hang = true;
    const { vault } = await load();
    await signedIn(vault);
    await vi.advanceTimersByTimeAsync(vault.SERVER_CHECK_TIMEOUT_MS);
    expect(vault.getVaultStatus().status).toBe('error');
  });
});

describe('sign-out', () => {
  it('completes even if deleting the vault key never finishes, and the key stays unusable', async () => {
    const { vault, auth: authModule } = await load();
    await signedIn(vault);
    storage.clearVaultKey.mockImplementation(never);

    const done = authModule.signOut();
    // Unusable at once, before any await: no sync run can start with it
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.isVaultKeyRevoked()).toBe(true);
    await vi.advanceTimersByTimeAsync(vault.FORGET_TIMEOUT_MS);
    await expect(done).resolves.toEqual({ keyForgotten: false });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(authModule.getAuthState().status).toBe('signed-out');

    // Survives a restart (marker in localStorage), and the next start deletes the key
    const restarted = await load();
    expect(restarted.vault.isVaultKeyRevoked()).toBe(true);
    storage.clearVaultKey.mockImplementation(async () => {});
    await restarted.vault.retryPendingVaultForget();
    expect(storage.clearVaultKey).toHaveBeenCalled();
    expect(restarted.vault.isVaultKeyRevoked()).toBe(false);
  });

  it('counts as done when the server can’t be told but the local session is gone', async () => {
    const { vault, auth: authModule } = await load();
    await signedIn(vault);
    auth.signOut.mockImplementationOnce(async () => {
      auth.session = null;
      auth.listener?.('SIGNED_OUT', null);
      return { error: { message: 'Failed to fetch' } };
    });
    await expect(authModule.signOut()).resolves.toEqual({ keyForgotten: true });
    expect(vault.isVaultKeyRevoked()).toBe(false);
  });
});

describe('sync runner', () => {
  it('never uses a vault key that is being forgotten', async () => {
    const { vault } = await load();
    await signedIn(vault);
    storage.clearVaultKey.mockImplementation(never);
    void vault.forgetVault({ timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);

    const runner = await import('@/lib/sync/runner');
    const { getSyncStatus } = await import('@/lib/sync/status');
    // Even a stored key owned by this account isn't loaded
    storage.loadVaultKey.mockClear();
    storage.loadVaultKey.mockImplementation(async () => ({ key: {} }));
    await runner.syncOnce();
    expect(storage.loadVaultKey).not.toHaveBeenCalled();
    expect(getSyncStatus().state).toBe('locked');
  });
});
