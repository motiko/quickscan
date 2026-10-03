import type { Session } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from './supabase';

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthState =
  | { status: 'disabled' } // no Supabase project configured for this build
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: AuthUser };

let state: AuthState = isSupabaseConfigured() ? { status: 'loading' } : { status: 'disabled' };
let started = false;
const subscribers = new Set<() => void>();

function setState(next: AuthState) {
  state = next;
  for (const notify of subscribers) notify();
}

function fromSession(session: Session | null): AuthState {
  if (!session) return { status: 'signed-out' };
  return { status: 'signed-in', user: { id: session.user.id, email: session.user.email ?? '' } };
}

/** Restore the stored session and follow sign-in, sign-out and token refreshes. */
async function start() {
  if (started || state.status === 'disabled') return;
  started = true;
  try {
    const supabase = await getSupabase();
    supabase.auth.onAuthStateChange((_event, session) => setState(fromSession(session)));
    const { data } = await supabase.auth.getSession();
    setState(fromSession(data.session));
  } catch {
    // Offline or unreachable: act signed out rather than spinning forever.
    setState({ status: 'signed-out' });
  }
}

/** For useSyncExternalStore; the first subscriber starts the session listener. */
export function subscribeAuth(listener: () => void): () => void {
  subscribers.add(listener);
  void start();
  return () => subscribers.delete(listener);
}

export function getAuthState(): AuthState {
  return state;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Supabase sends 6-digit codes by default; projects can raise the length up to 10. */
export function normalizeCode(code: string): string | null {
  const digits = code.replace(/\s/g, '');
  return /^\d{6,10}$/.test(digits) ? digits : null;
}

/** Turn Supabase auth errors into something a person can act on. */
export function describeAuthError(error: { message?: string; status?: number; code?: string }): string {
  const message = error.message ?? '';
  if (error.code === 'signup_disabled' || /signups not allowed/i.test(message)) {
    return 'This email has no account yet. Ask the owner of this QuickScan to invite you.';
  }
  if (error.code === 'otp_expired' || /expired|invalid/i.test(message)) {
    return 'That code is wrong or has expired. Request a new one.';
  }
  if (error.status === 429 || error.code === 'over_email_send_rate_limit' || /rate limit/i.test(message)) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  return message || 'Something went wrong. Check your connection and try again.';
}

export class AuthError extends Error {}

/** Email a one-time sign-in code. */
export async function sendSignInCode(email: string): Promise<void> {
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signInWithOtp({ email: normalizeEmail(email) });
  if (error) throw new AuthError(describeAuthError(error));
}

/** Exchange the emailed code for a session; the state listener picks up the sign-in. */
export async function verifySignInCode(email: string, code: string): Promise<void> {
  const token = normalizeCode(code);
  if (!token) throw new AuthError('Enter the code from the email.');
  const supabase = await getSupabase();
  const { error } = await supabase.auth.verifyOtp({ email: normalizeEmail(email), token, type: 'email' });
  if (error) throw new AuthError(describeAuthError(error));
}

/**
 * Sign out on this device only; documents stay on the device. The sync vault key is
 * forgotten first, so an account signing in next can't use it.
 */
export async function signOut(): Promise<void> {
  const { forgetVault } = await import('./vault-session');
  await forgetVault();
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw new AuthError(describeAuthError(error));
}
