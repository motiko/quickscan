/*
 * End-to-end-encrypted cloud sync. Dexie stays the source of truth; Supabase holds an
 * encrypted replica. See engine.ts for one run, runner.ts for when runs happen, status.ts for
 * what the UI shows.
 */
export { requestSync, startSyncScheduler, syncOnce, VAULT_CHANGED_EVENT } from './runner';
export { getSyncStatus, subscribeSyncStatus, type SyncState, type SyncStatus } from './status';
