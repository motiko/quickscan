'use client';

import { useSyncExternalStore } from 'react';
import { getVaultStatus, subscribeVault, type VaultState } from '@/lib/vault-session';

const SERVER_STATE: VaultState = { status: 'checking' };

/** Whether this device holds the sync vault key; see lib/vault-session.ts. */
export function useVault(): VaultState {
  return useSyncExternalStore(subscribeVault, getVaultStatus, () => SERVER_STATE);
}
