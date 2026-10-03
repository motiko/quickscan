import { db } from '@/lib/db';
import { removeSyncedFromDevice, type RemovalPlan } from './remove-local';
import { ACCOUNT_SWITCH_KEY, getMeta, LAST_USER_KEY, type AccountSwitchDecision } from './state';

/*
 * A different account signs in on a device whose documents came from (or were made under)
 * another account. Sync is paused (the engine reports `accountSwitch`, the status is
 * 'paused') until the user picks one of:
 *
 * - "Upload": merge everything on the device into the new account (what a first sync does).
 * - "Remove": delete the local copies of what's safely in the previous account (the same rules
 *   as "Remove synced documents from this device"). Anything not synced there stays, and the
 *   question stays open for it, now offering only the upload.
 *
 * The answer is kept in `sync:accountSwitch` until the merge it allows has started (which
 * wipes the old account's `sync:` state, this key included). The caller requests a sync run
 * afterwards. A device that never synced merges on its first sync without asking.
 */

async function previousAccount(userId: string): Promise<string | null> {
  const last = await getMeta<string>(LAST_USER_KEY);
  return last && last !== userId ? last : null;
}

/** "Upload N documents to <email>": allow the merge into `userId`. */
export async function chooseUploadToAccount(userId: string): Promise<void> {
  const from = await previousAccount(userId);
  if (!from) return;
  const decision: AccountSwitchDecision = { from, to: userId, choice: 'merge' };
  await db.syncMeta.put({ key: ACCOUNT_SWITCH_KEY, value: decision });
}

/**
 * "Remove them from this device": drop what's synced with the previous account. Returns the
 * removal plan (what went and what stayed), or null when there's no previous account.
 */
export async function removePreviousAccountData(userId: string): Promise<RemovalPlan | null> {
  const from = await previousAccount(userId);
  if (!from) return null;
  const plan = await removeSyncedFromDevice(from);
  const decision: AccountSwitchDecision = { from, to: userId, choice: 'remove' };
  await db.syncMeta.put({ key: ACCOUNT_SWITCH_KEY, value: decision });
  return plan;
}
