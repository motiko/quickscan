import type { SupabaseClient } from '@supabase/supabase-js';

/*
 * Supabase is optional: without these build-time vars the app stays fully local and
 * hides everything account-related. The anon key is public by design; access is
 * enforced by row-level security on the Supabase side, never by keeping it secret.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let clientPromise: Promise<SupabaseClient> | null = null;

/** Lazily loaded so the local-only app doesn't pay for supabase-js in its bundle. */
export function getSupabase(): Promise<SupabaseClient> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return Promise.reject(new Error('Supabase is not configured'));
  }
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Sign-in uses emailed codes, not links: an iOS home-screen PWA doesn't share
        // storage with Safari, so a link would sign in the browser instead of the app.
        detectSessionInUrl: false,
      },
    }),
  );
  return clientPromise;
}
