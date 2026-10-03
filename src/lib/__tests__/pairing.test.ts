import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * QR pairing: the payload format, and both devices' flows against an in-memory
 * `pairing_requests` table behind a mocked Supabase client that applies the table's
 * row-level security (own rows only, expired rows hidden). The real crypto runs on both
 * simulated devices; they share one fake IndexedDB, so the tests switch "devices" by
 * clearing the stored vault key.
 */

const USER = { id: 'user-1', email: 'me@example.com' };
const ATTACKER = 'user-2';
const TTL = 5 * 60_000;

type Row = { user_id: string; id: string; sealed_key: string | null; expires_at: number };
type Call = { op: string; values?: unknown };

const server = {
  rows: [] as Row[],
  uid: USER.id,
  clock: 1_000_000,
  calls: [] as Call[],
  failNext: false,
  /** Runs right before an update applies, e.g. the request expiring meanwhile. */
  beforeUpdate: null as null | (() => void),
};
const now = () => server.clock;

class Query {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private values: Record<string, unknown> = {};
  private filters: ((r: Row) => boolean)[] = [];
  private returning = false;

  constructor(private table: string) {}

  select() {
    if (this.op !== 'select') this.returning = true;
    return this;
  }
  insert(values: Record<string, unknown>) {
    this.op = 'insert';
    this.values = values;
    return this;
  }
  update(values: Record<string, unknown>) {
    this.op = 'update';
    this.values = values;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(col: keyof Row, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this;
  }
  is(col: keyof Row, value: null) {
    this.filters.push((r) => r[col] === value);
    return this;
  }
  limit() {
    return this;
  }
  async maybeSingle() {
    const { data, error } = await this.run();
    return { data: error ? null : ((data as Row[])[0] ?? null), error };
  }
  then<T>(resolve: (v: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) {
    return this.run().then(resolve, reject);
  }

  private async run(): Promise<{ data: unknown; error: unknown }> {
    if (this.table === 'vault_keys') return { data: [{ id: 'recovery' }], error: null };
    expect(this.table).toBe('pairing_requests');
    server.calls.push({ op: this.op, values: this.values });
    if (server.failNext) {
      server.failNext = false;
      return { data: null, error: { message: 'Failed to fetch' } };
    }
    // RLS: own rows that haven't expired.
    const visible = (r: Row) => r.user_id === server.uid && r.expires_at > server.clock;
    const matching = () => server.rows.filter((r) => visible(r) && this.filters.every((f) => f(r)));
    switch (this.op) {
      case 'insert': {
        const id = this.values.id as string;
        expect(Object.keys(this.values)).toEqual(['id']);
        if (id.length < 16 || id.length > 128) return { data: null, error: { code: '23514' } };
        if (server.rows.some((r) => r.user_id === server.uid && r.id === id))
          return { data: null, error: { code: '23505' } };
        server.rows = server.rows.filter((r) => r.user_id !== server.uid || r.expires_at > server.clock); // trigger
        server.rows.push({ user_id: server.uid, id, sealed_key: null, expires_at: server.clock + TTL });
        return { data: null, error: null };
      }
      case 'select':
        return { data: matching().map((r) => ({ ...r })), error: null };
      case 'update': {
        server.beforeUpdate?.();
        const rows = matching();
        const sealed = this.values.sealed_key as string;
        expect(sealed).toMatch(/^\\x[0-9a-f]+$/);
        expect((sealed.length - 2) / 2).toBeLessThanOrEqual(4096);
        for (const r of rows) Object.assign(r, this.values);
        return { data: this.returning ? rows.map((r) => ({ id: r.id })) : null, error: null };
      }
      case 'delete': {
        const gone = new Set(matching());
        server.rows = server.rows.filter((r) => !gone.has(r));
        return { data: null, error: null };
      }
    }
  }
}

const auth = {
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  getSession: vi.fn(async () => ({ data: { session: { user: USER } } })),
};

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: async () => ({ auth, from: (table: string) => new Query(table) }),
}));

async function load() {
  vi.resetModules();
  const pairing = await import('@/lib/pairing-session');
  const code = await import('@/lib/pairing-code');
  const vault = await import('@/lib/vault-session');
  const crypto = await import('@/lib/crypto');
  const { db } = await import('@/lib/db');
  const events = vi.fn();
  window.addEventListener(vault.VAULT_CHANGED_EVENT, events);
  vault.subscribeVault(() => {});
  await vi.waitFor(() => expect(vault.getVaultStatus().status).toBe('locked'));
  return { pairing, code, vault, crypto, db, events };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** The unlocked device: put an existing vault key on "this" device. */
async function becomeUnlockedDevice({ crypto }: Loaded, vaultKey: CryptoKey) {
  await crypto.storeVaultKey(vaultKey);
}

/** Switch back to the new device, which has no key. */
async function becomeNewDevice({ crypto, db }: Loaded) {
  await crypto.clearVaultKey();
  await db.syncMeta.delete('vaultOwner');
}

async function sameKey(a: CryptoKey, b: CryptoKey) {
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a, new TextEncoder().encode('probe'));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b, ct);
  return new TextDecoder().decode(pt) === 'probe';
}

const updates = () => server.calls.filter((c) => c.op === 'update');

beforeEach(async () => {
  vi.stubGlobal('window', new EventTarget());
  server.rows = [];
  server.uid = USER.id;
  server.clock = 1_000_000;
  server.calls = [];
  server.failNext = false;
  server.beforeUpdate = null;
  const { db } = await import('@/lib/db');
  await db.syncMeta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

describe('pairing code', () => {
  async function sample() {
    const crypto = await import('@/lib/crypto');
    const code = await import('@/lib/pairing-code');
    const { publicKey } = await crypto.createPairingKeyPair();
    const requestId = code.createPairingRequestId();
    return { code, requestId, publicKey, text: code.formatPairingCode({ requestId, publicKey }) };
  }

  it('round-trips qs1:<id>:<key>', async () => {
    const { code, requestId, publicKey, text } = await sample();
    expect(text).toMatch(/^qs1:[A-Za-z0-9_-]{24}:[A-Za-z0-9_-]{87}$/);
    expect(text.length).toBe(116);
    const parsed = code.parsePairingCode(text);
    expect(parsed.requestId).toBe(requestId);
    expect([...parsed.publicKey]).toEqual([...publicKey]);
  });

  it('creates random, URL-safe request ids', async () => {
    const { createPairingRequestId, isValidPairingRequestId } = await import('@/lib/pairing-code');
    const ids = new Set(Array.from({ length: 50 }, createPairingRequestId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isValidPairingRequestId(id)).toBe(true);
  });

  it('rejects every malformed variant', async () => {
    const { code, requestId, text } = await sample();
    const key = text.split(':')[2];
    const compressed = 'Ag' + key.slice(2); // first byte 0x02 instead of 0x04
    const lastChar = key.at(-1)!;
    // 65 bytes leave 4 unused bits in the last char; set one -> same bytes, non-canonical text.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const nonCanonical = key.slice(0, -1) + alphabet[alphabet.indexOf(lastChar) | 1];
    const invalid = [
      '',
      'qs1',
      'qs1:',
      `qs1:${requestId}`,
      `qs1:${requestId}:`,
      `qs1:${requestId}:${key}:extra`,
      `QS1:${requestId}:${key}`,
      `qs0:${requestId}:${key}`,
      `xx1:${requestId}:${key}`,
      `https://example.com/${requestId}`,
      ` ${text}`,
      `${text}\n`,
      `qs1:${requestId.slice(0, 21)}:${key}`, // id too short
      `qs1:${'a'.repeat(65)}:${key}`, // id too long
      `qs1:${requestId.slice(0, -1)}+:${key}`, // not URL-safe
      `qs1:${requestId.slice(0, -1)}/:${key}`,
      `qs1:${requestId.slice(0, -1)}.:${key}`,
      `qs1:${requestId.slice(0, -1)} :${key}`,
      `qs1:${requestId}:${key.slice(0, 86)}`, // key too short
      `qs1:${requestId}:${key}A`, // key too long
      `qs1:${requestId}:${key.slice(0, 86)}=`, // padding
      `qs1:${requestId}:${compressed}`,
      `qs1:${requestId}:${'A'.repeat(87)}`,
      'qs1:' + 'x'.repeat(300),
    ];
    if (nonCanonical !== key) invalid.push(`qs1:${requestId}:${nonCanonical}`);
    for (const bad of invalid) {
      expect(() => code.parsePairingCode(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: 'invalid-code' }),
      );
    }
    expect(() => code.parsePairingCode(`qs2:${requestId}:${key}`)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' }),
    );
  });

  it('gives both screens the same short fingerprint', async () => {
    const { code, text } = await sample();
    const fp = await code.pairingFingerprint(code.parsePairingCode(text));
    expect(fp).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
    expect(await code.pairingFingerprint(code.parsePairingCode(text))).toBe(fp);
    const other = await sample();
    expect(await code.pairingFingerprint(code.parsePairingCode(other.text))).not.toBe(fp);
  });
});

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

describe('pairing flow', () => {
  it('moves the vault key from the unlocked device to the new one', async () => {
    const loaded = await load();
    const { pairing, crypto, vault, db, events } = loaded;
    const original = await crypto.generateVaultKey();

    // New device: request + QR code.
    const request = await pairing.PairingRequest.create({ now });
    expect(server.rows).toHaveLength(1);
    expect(server.rows[0]).toMatchObject({ user_id: USER.id, id: request.requestId, sealed_key: null });
    expect(await request.poll()).toBe('waiting');

    // Unlocked device scans it.
    await becomeUnlockedDevice(loaded, original);
    const { fingerprint } = await pairing.sendVaultKeyToDevice(request.code);
    expect(fingerprint).toBe(request.fingerprint);
    expect(server.rows[0].sealed_key).toMatch(/^\\x01[0-9a-f]{250}$/); // 126 bytes
    await becomeNewDevice(loaded);

    // New device picks it up.
    server.clock += 2_000;
    expect(await request.poll()).toBe('paired');
    expect(request.getStatus()).toBe('paired');
    const stored = await crypto.loadVaultKey();
    expect(stored!.key.extractable).toBe(false);
    expect(await sameKey(original, stored!.key)).toBe(true);
    expect((await db.syncMeta.get('vaultOwner'))?.value).toBe(USER.id);
    expect(server.rows).toHaveLength(0);
    expect(vault.getVaultStatus().status).toBe('unlocked');
    expect(events).toHaveBeenCalledTimes(1);
    expect(await request.poll()).toBe('paired');
  });

  it('expires after five minutes and never answers late', async () => {
    const loaded = await load();
    const request = await loaded.pairing.PairingRequest.create({ now });
    expect(request.expiresAt).toBeGreaterThan(server.clock + TTL - 5_000);
    expect(request.expiresAt).toBeLessThanOrEqual(server.clock + TTL);

    server.clock = request.expiresAt;
    expect(await request.poll()).toBe('expired');
    expect(await request.poll()).toBe('expired');

    // The unlocked device can't answer an expired request either (RLS hides it).
    server.clock += 5_000;
    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    await expect(loaded.pairing.sendVaultKeyToDevice(request.code)).rejects.toMatchObject({ code: 'not-found' });
    expect(updates()).toHaveLength(0);
  });

  it('counts a request the server no longer shows as expired', async () => {
    const { pairing } = await load();
    const request = await pairing.PairingRequest.create({ now });
    server.rows[0].expires_at = server.clock; // server clock ahead of ours
    expect(await request.poll()).toBe('expired');
  });

  it('deletes the row on cancel and then ignores answers', async () => {
    const loaded = await load();
    const request = await loaded.pairing.PairingRequest.create({ now });
    await request.cancel();
    expect(server.rows).toHaveLength(0);
    expect(request.getStatus()).toBe('cancelled');
    expect(await request.poll()).toBe('cancelled');

    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    await expect(loaded.pairing.sendVaultKeyToDevice(request.code)).rejects.toMatchObject({ code: 'not-found' });
  });

  it("refuses an attacker's QR code: their request isn't in this account", async () => {
    const loaded = await load();
    // The attacker, signed in to their own account, shows a code.
    server.uid = ATTACKER;
    const attacker = await loaded.pairing.PairingRequest.create({ now });
    server.uid = USER.id;

    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    await expect(loaded.pairing.sendVaultKeyToDevice(attacker.code)).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining("This code isn't valid for your account or has expired"),
    });
    expect(updates()).toHaveLength(0);
    expect(server.rows[0]).toMatchObject({ user_id: ATTACKER, sealed_key: null });
  });

  it('reports a zero-row update as not-found (expired between check and send)', async () => {
    const loaded = await load();
    const request = await loaded.pairing.PairingRequest.create({ now });
    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    server.beforeUpdate = () => {
      server.clock += TTL;
    };
    await expect(loaded.pairing.sendVaultKeyToDevice(request.code)).rejects.toMatchObject({ code: 'not-found' });
    expect(updates()).toHaveLength(1);
    expect(server.rows[0].sealed_key).toBeNull();
  });

  it("doesn't overwrite a request another device already answered", async () => {
    const loaded = await load();
    const request = await loaded.pairing.PairingRequest.create({ now });
    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    await loaded.pairing.sendVaultKeyToDevice(request.code);
    const first = server.rows[0].sealed_key;
    await expect(loaded.pairing.sendVaultKeyToDevice(request.code)).rejects.toMatchObject({ code: 'not-found' });
    expect(server.rows[0].sealed_key).toBe(first);
  });

  it('refuses a code whose request id this account never created', async () => {
    const loaded = await load();
    const request = await loaded.pairing.PairingRequest.create({ now });
    const otherId = loaded.code.createPairingRequestId();
    const forged = request.code.replace(request.requestId, otherId);
    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    await expect(loaded.pairing.sendVaultKeyToDevice(forged)).rejects.toMatchObject({ code: 'not-found' });
    expect(updates()).toHaveLength(0);
  });

  it('rejects a key sealed for another request id and keeps the device locked', async () => {
    const loaded = await load();
    const a = await loaded.pairing.PairingRequest.create({ now });
    const b = await loaded.pairing.PairingRequest.create({ now });
    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    await loaded.pairing.sendVaultKeyToDevice(a.code);
    await becomeNewDevice(loaded);

    // A tampered server moves a's answer onto b: sealed for another request (and key pair).
    const rowA = server.rows.find((r) => r.id === a.requestId)!;
    const rowB = server.rows.find((r) => r.id === b.requestId)!;
    rowB.sealed_key = rowA.sealed_key;
    await expect(b.poll()).rejects.toMatchObject({ code: 'bad-key' });
    expect(server.rows.some((r) => r.id === b.requestId)).toBe(false);
    expect(await loaded.crypto.loadVaultKey()).toBeNull();
    expect(loaded.vault.getVaultStatus().status).toBe('locked');
    expect(loaded.events).not.toHaveBeenCalled();
  });

  it('rejects a public key that is not a P-256 point, before sending anything', async () => {
    const loaded = await load();
    const request = await loaded.pairing.PairingRequest.create({ now });
    const notOnCurve = new Uint8Array(65);
    notOnCurve[0] = 0x04;
    notOnCurve[1] = 1;
    const bad = loaded.code.formatPairingCode({ requestId: request.requestId, publicKey: notOnCurve });
    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    await expect(loaded.pairing.sendVaultKeyToDevice(bad)).rejects.toMatchObject({ code: 'invalid-code' });
    expect(updates()).toHaveLength(0);
    expect(server.rows[0].sealed_key).toBeNull();
  });

  it('rejects text that is not a pairing code without asking the server', async () => {
    const loaded = await load();
    await becomeUnlockedDevice(loaded, await loaded.crypto.generateVaultKey());
    await expect(loaded.pairing.sendVaultKeyToDevice('https://example.com')).rejects.toMatchObject({
      code: 'invalid-code',
    });
    expect(server.calls).toHaveLength(0);
  });

  it('needs an unlocked device to send', async () => {
    const loaded = await load();
    const request = await loaded.pairing.PairingRequest.create({ now });
    await expect(loaded.pairing.sendVaultKeyToDevice(request.code)).rejects.toMatchObject({ code: 'locked' });
    expect(updates()).toHaveLength(0);
  });

  it('survives a failed check and keeps waiting', async () => {
    const loaded = await load();
    const request = await loaded.pairing.PairingRequest.create({ now });
    server.failNext = true;
    await expect(request.poll()).rejects.toMatchObject({ code: 'network' });
    expect(request.getStatus()).toBe('waiting');
    expect(await request.poll()).toBe('waiting');
  });

  it('reports a failed insert as a network error', async () => {
    const { pairing } = await load();
    server.failNext = true;
    await expect(pairing.PairingRequest.create({ now })).rejects.toMatchObject({ code: 'network' });
  });
});

describe('QR round trip', () => {
  it('jsQR (the iOS fallback) reads what uqr draws', async () => {
    const { encode } = await import('uqr');
    const { default: jsQR } = await import('jsqr');
    const crypto = await import('@/lib/crypto');
    const code = await import('@/lib/pairing-code');
    const { publicKey } = await crypto.createPairingKeyPair();
    const text = code.formatPairingCode({ requestId: code.createPairingRequestId(), publicKey });

    // Same settings as drawQrCode in lib/qr.ts, rasterized at 4 px per module.
    const qr = encode(text, { ecc: 'M', border: 4 });
    const scale = 4;
    const side = qr.size * scale;
    const rgba = new Uint8ClampedArray(side * side * 4).fill(255);
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (!dark) return;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const i = ((y * scale + dy) * side + x * scale + dx) * 4;
            rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
          }
        }
      }),
    );
    expect(jsQR(rgba, side, side, { inversionAttempts: 'dontInvert' })?.data).toBe(text);
    expect(qr.version).toBeLessThanOrEqual(7);
  });
});
