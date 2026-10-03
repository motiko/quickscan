'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { alertDialog, confirmDialog } from '@/lib/dialogs';
import { requestSync } from '@/lib/sync';
import { chooseUploadToAccount, removePreviousAccountData } from '@/lib/sync/account-switch';
import { previewRemoval } from '@/lib/sync/remove-local';

const primaryButtonClass =
  'min-h-11 shrink-0 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const secondaryButtonClass =
  'min-h-11 shrink-0 rounded-lg border border-gray-300 dark:border-neutral-700 px-4 text-sm font-semibold text-gray-900 dark:text-gray-100 disabled:opacity-50';
const hintClass = 'text-xs text-gray-500 dark:text-gray-400';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function itemsText(counts: { documents: number; folders: number; signatures: number }): string {
  const parts = [
    counts.documents > 0 && plural(counts.documents, 'document'),
    counts.folders > 0 && plural(counts.folders, 'folder'),
    counts.signatures > 0 && plural(counts.signatures, 'signature'),
  ].filter((p): p is string => Boolean(p));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? 'nothing');
}

/**
 * Shown while sync is paused because another account's documents are on this device: upload
 * them to this account, or remove what's already safe in the other account. Nothing happens
 * until a button is pressed, and removing asks again.
 */
export function AccountSwitchPrompt({ email }: { email: string }) {
  const auth = useAuth();
  const status = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const pending = status.state === 'paused' ? status.accountSwitch : undefined;
  if (!pending || auth.status !== 'signed-in') return null;
  const userId = auth.user.id;
  const items = itemsText(pending);

  const upload = async () => {
    setBusy(true);
    try {
      await chooseUploadToAccount(userId);
      void requestSync();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const plan = await previewRemoval(pending.previousUserId);
      const removable = plan.synced ? plan.documents.length + plan.folders.length + plan.signatures.length : 0;
      if (removable === 0) {
        await alertDialog({
          title: 'Nothing can be removed',
          message:
            'None of these documents finished syncing with the other account, so removing them would lose them. Sign in to that account to sync them, or upload them to this one.',
        });
        return;
      }
      const kept = plan.keptDocuments + plan.keptFolders + plan.keptSignatures;
      const confirmed = await confirmDialog({
        title: 'Remove the other account’s documents from this device?',
        message: [
          `${itemsText({ documents: plan.documents.length, folders: plan.folders.length, signatures: plan.signatures.length })} ${removable === 1 ? 'is' : 'are'} safely in the other account and will be removed from this device only.`,
          kept > 0 &&
            `${itemsText({ documents: plan.keptDocuments, folders: plan.keptFolders, signatures: plan.keptSignatures })} with changes that haven’t synced stay here.`,
          'Original photos from before cropping are never synced, so they are removed for good.',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: 'Remove from device',
        destructive: true,
      });
      if (!confirmed) return;
      await removePreviousAccountData(userId);
      void requestSync();
    } catch (err) {
      console.warn('Removing the other account’s documents failed', err);
      await alertDialog({ title: 'Couldn’t remove documents', message: 'Nothing was removed. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 p-3" role="status" data-testid="account-switch-prompt">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {pending.removed ? `Upload what’s left to ${email}?` : `Upload ${items} from this device to ${email}?`}
      </p>
      <p className={`mt-1 ${hintClass}`}>
        {pending.removed
          ? `${items} on this device never finished syncing with the account you used before, so they stayed. Sign in to that account to sync them, or upload them to this one.`
          : `They were synced with, or made while signed in to, another account. Sync is paused until you choose; nothing has been uploaded.`}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => void upload()} disabled={busy} className={primaryButtonClass}>
          Upload to {email}
        </button>
        {!pending.removed && (
          <button onClick={() => void remove()} disabled={busy} className={secondaryButtonClass}>
            Remove from this device
          </button>
        )}
      </div>
    </div>
  );
}
