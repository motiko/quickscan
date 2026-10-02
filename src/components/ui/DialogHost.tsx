'use client';

import { useSyncExternalStore } from 'react';
import { getActiveDialog, resolveDialog, subscribeDialogs, type DialogRequest } from '@/lib/dialogs';
import { useEscape } from '@/hooks/useEscape';

function Dialog({ request }: { request: DialogRequest }) {
  const { id, kind, title, message, destructive } = request;
  const close = (confirmed: boolean) => resolveDialog(id, confirmed);
  useEscape(() => close(false));

  const titleId = `dialog-title-${id}`;
  const messageId = `dialog-message-${id}`;
  const button = 'flex-1 rounded-xl py-3 text-sm font-semibold transition-colors active:scale-98';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-4 pb-safe-offset-4 backdrop-blur-[2px] sm:items-center"
      onClick={() => close(false)}
    >
      <div
        role={kind === 'confirm' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-neutral-900 p-5 shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-base font-bold text-gray-900 dark:text-gray-100">
          {title}
        </h2>
        {message && (
          <p id={messageId} className="mt-1.5 text-sm text-gray-600 dark:text-gray-300">
            {message}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          {kind === 'confirm' && (
            <button
              onClick={() => close(false)}
              // Destructive actions start on Cancel so Enter can't delete by accident
              autoFocus={destructive}
              className={`${button} bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-700`}
            >
              {request.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            onClick={() => close(true)}
            autoFocus={!destructive}
            className={`${button} text-white ${
              destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Renders confirmDialog() / alertDialog() requests. Mounted once in the root layout. */
export function DialogHost() {
  const request = useSyncExternalStore(subscribeDialogs, getActiveDialog, () => null);
  return request ? <Dialog key={request.id} request={request} /> : null;
}
