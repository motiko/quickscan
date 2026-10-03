'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { alertDialog, confirmDialog } from '@/lib/dialogs';
import { previewRemoval, removeSyncedFromDevice, type RemovalPlan } from '@/lib/sync/remove-local';
import { withTimeout } from '@/lib/timeout';

const PREVIEW_TIMEOUT_MS = 3_000;

const linkButtonClass = 'min-h-11 text-sm font-semibold text-blue-600 dark:text-blue-400 disabled:opacity-50';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function removableCount(plan: RemovalPlan): number {
  return plan.documents.length + plan.folders.length + plan.signatures.length;
}

function removableText(plan: RemovalPlan): string {
  const parts = [
    plan.documents.length > 0 && plural(plan.documents.length, 'document'),
    plan.folders.length > 0 && plural(plan.folders.length, 'folder'),
    plan.signatures.length > 0 && plural(plan.signatures.length, 'signature'),
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : String(parts[0]);
}

function keptText(plan: RemovalPlan): string {
  const kept = plan.keptDocuments + plan.keptFolders + plan.keptSignatures;
  if (kept === 0) return '';
  const what = [
    plan.keptDocuments > 0 && plural(plan.keptDocuments, 'document'),
    plan.keptFolders > 0 && plural(plan.keptFolders, 'folder'),
    plan.keptSignatures > 0 && plural(plan.keptSignatures, 'signature'),
  ]
    .filter(Boolean)
    .join(', ');
  return `${what} with changes that haven’t synced yet will stay on this device.`;
}

const ORIGINALS_NOTE = 'Original photos from before cropping are never synced, so they are removed for good.';

/** After a removal: say what stayed and why, if anything did. */
async function reportKept(plan: RemovalPlan): Promise<void> {
  const kept = keptText(plan);
  if (!kept) return;
  await alertDialog({
    title: 'Some items stayed on this device',
    message: `${kept.replace(/ will stay /, ' stayed ')} Let them sync, then remove them again.`,
  });
}

/**
 * Part of signing out: offer to remove what's synced as well. Returns a function that does the
 * removal (call it after signing out, so no sync runs in between), or null to keep everything.
 */
export async function askRemoveOnSignOut(userId: string): Promise<(() => Promise<void>) | null> {
  // Never let a slow or blocked database hold up the sign-out itself
  const plan = await withTimeout(previewRemoval(userId), PREVIEW_TIMEOUT_MS, 'Previewing removal').catch(() => null);
  if (!plan?.synced || removableCount(plan) === 0) return null;
  const remove = await confirmDialog({
    title: 'Also remove synced documents from this device?',
    message: [
      `${removableText(plan)} ${removableCount(plan) === 1 ? 'is' : 'are'} safely in your account and can be removed from this device. Signing in again downloads them.`,
      keptText(plan),
      ORIGINALS_NOTE,
    ]
      .filter(Boolean)
      .join(' '),
    confirmLabel: 'Remove from device',
    cancelLabel: 'Keep on device',
    destructive: true,
  });
  if (!remove) return null;
  return async () => reportKept(await removeSyncedFromDevice(userId));
}

/**
 * "Remove synced documents from this device", for cleaning up a shared or old device. Turns
 * sync off on this device first (`beforeRemove`), so the documents don't download right back.
 */
export function RemoveSyncedDocuments({ beforeRemove }: { beforeRemove?: () => Promise<void> }) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  if (auth.status !== 'signed-in') return null;
  const userId = auth.user.id;

  const run = async () => {
    setBusy(true);
    try {
      const plan = await previewRemoval(userId);
      if (!plan.synced || removableCount(plan) === 0) {
        await alertDialog({
          title: 'Nothing to remove yet',
          message: plan.synced
            ? 'Nothing on this device has finished syncing. Documents can be removed once they’re safely in your account.'
            : 'This device hasn’t finished syncing with your account yet. Try again after it has synced.',
        });
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Remove synced documents from this device?',
        message: [
          `${removableText(plan)} will be removed from this device only; they stay in your account and on your other devices.`,
          keptText(plan),
          'Sync turns off on this device until you unlock it again, which downloads them again.',
          ORIGINALS_NOTE,
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: 'Remove from device',
        destructive: true,
      });
      if (!confirmed) return;
      await beforeRemove?.();
      await reportKept(await removeSyncedFromDevice(userId));
    } catch (err) {
      console.warn('Removing synced documents failed', err);
      await alertDialog({ title: 'Couldn’t remove documents', message: 'Nothing was removed. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 pb-3">
      <button onClick={() => void run()} disabled={busy} className={linkButtonClass}>
        Remove synced documents from this device
      </button>
    </div>
  );
}
