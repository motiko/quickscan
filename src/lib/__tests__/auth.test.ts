import { describe, it, expect, vi, beforeEach } from 'vitest';

type Listener = (event: string, session: unknown) => void;
type AuthCall = (params?: unknown) => Promise<{ error: unknown }>;

const auth = {
  listener: null as Listener | null,
  onAuthStateChange: vi.fn((cb: Listener) => {
    auth.listener = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  }),
  getSession: vi.fn(async () => ({ data: { session: null } })),
  signInWithOtp: vi.fn<AuthCall>(async () => ({ error: null })),
  verifyOtp: vi.fn<AuthCall>(async () => ({ error: null })),
  signOut: vi.fn<AuthCall>(async () => ({ error: null })),
};

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: async () => ({ auth }),
}));

import {
  AuthError,
  describeAuthError,
  getAuthState,
  normalizeCode,
  normalizeEmail,
  sendSignInCode,
  signOut,
  subscribeAuth,
  verifySignInCode,
} from '@/lib/auth';

const session = { user: { id: 'user-1', email: 'me@example.com' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auth state', () => {
  it('starts loading, restores the stored session and follows auth events', async () => {
    expect(getAuthState()).toEqual({ status: 'loading' });
    auth.getSession.mockResolvedValueOnce({ data: { session } } as never);

    const notify = vi.fn();
    const unsubscribe = subscribeAuth(notify);
    await vi.waitFor(() => expect(getAuthState().status).toBe('signed-in'));
    expect(getAuthState()).toEqual({ status: 'signed-in', user: { id: 'user-1', email: 'me@example.com' } });
    expect(notify).toHaveBeenCalled();

    auth.listener!('SIGNED_OUT', null);
    expect(getAuthState()).toEqual({ status: 'signed-out' });

    // The session listener is registered once, however many components subscribe.
    subscribeAuth(vi.fn())();
    unsubscribe();
    expect(auth.onAuthStateChange).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeEmail / normalizeCode', () => {
  it('trims and lower-cases emails', () => {
    expect(normalizeEmail('  Me@Example.COM ')).toBe('me@example.com');
  });

  it('accepts 6–10 digit codes, ignoring spaces', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('1234567890')).toBe('1234567890');
    expect(normalizeCode('12345')).toBeNull();
    expect(normalizeCode('12a456')).toBeNull();
  });
});

describe('describeAuthError', () => {
  it('explains disabled sign-ups as an invitation problem', () => {
    expect(describeAuthError({ code: 'signup_disabled', message: 'Signups not allowed for otp' })).toMatch(/invite/);
  });

  it('explains expired codes and rate limits', () => {
    expect(describeAuthError({ code: 'otp_expired', message: 'Token has expired or is invalid' })).toMatch(/expired/);
    expect(describeAuthError({ status: 429, message: 'email rate limit exceeded' })).toMatch(/Too many/);
  });

  it('falls back to the server message', () => {
    expect(describeAuthError({ message: 'Database error' })).toBe('Database error');
  });
});

describe('sign-in actions', () => {
  it('sends a code to the normalized email', async () => {
    await sendSignInCode(' Me@Example.com ');
    expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: 'me@example.com' });
  });

  it('verifies the code as an email OTP', async () => {
    await verifySignInCode('me@example.com', '123 456');
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: 'me@example.com', token: '123456', type: 'email' });
  });

  it('rejects malformed codes without calling Supabase', async () => {
    await expect(verifySignInCode('me@example.com', 'abc')).rejects.toBeInstanceOf(AuthError);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('turns Supabase errors into AuthErrors with readable messages', async () => {
    auth.verifyOtp.mockResolvedValueOnce({ error: { code: 'otp_expired', message: 'Token has expired' } });
    await expect(verifySignInCode('me@example.com', '123456')).rejects.toThrow(/expired/);
  });

  it('signs out on this device only', async () => {
    await signOut();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
