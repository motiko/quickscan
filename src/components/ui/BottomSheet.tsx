'use client';

import type { ReactNode } from 'react';
import { useEscape } from '@/hooks/useEscape';
import { CloseIcon } from './icons';

interface BottomSheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export const sheetIconButton =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-40';

/** Bottom sheet with a title bar; closes on backdrop tap, the close button and Escape. */
export function BottomSheet({ title, onClose, children }: BottomSheetProps) {
  useEscape(onClose);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="mx-auto flex max-h-[80dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white dark:bg-neutral-900 pb-safe-offset-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between gap-2 border-b border-gray-200 dark:border-neutral-800 py-1 pl-4 pr-1">
          <h2 className="truncate text-sm font-bold text-gray-900 dark:text-gray-100">{title}</h2>
          <button onClick={onClose} aria-label="Close" title="Close" className={sheetIconButton}>
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
