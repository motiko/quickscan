'use client';

import { useSyncExternalStore } from 'react';
import { getAuthState, subscribeAuth, type AuthState } from '@/lib/auth';

const SERVER_STATE: AuthState = { status: 'loading' };

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthState, () => SERVER_STATE);
}
