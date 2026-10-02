/**
 * In-app replacements for window.confirm / window.alert, rendered by <DialogHost> in the root layout.
 * Requests queue up, so a second dialog waits until the first is answered.
 */

export interface DialogOptions {
  title: string;
  message?: string;
  /** Label of the primary button. Defaults to "OK". */
  confirmLabel?: string;
  /** Label of the dismiss button (confirm dialogs only). Defaults to "Cancel". */
  cancelLabel?: string;
  /** Styles the primary button as destructive (deleting, discarding). */
  destructive?: boolean;
}

export interface DialogRequest extends DialogOptions {
  id: number;
  kind: 'confirm' | 'alert';
  resolve: (confirmed: boolean) => void;
}

let queue: DialogRequest[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();

function setQueue(next: DialogRequest[]) {
  queue = next;
  for (const notify of subscribers) notify();
}

function open(kind: DialogRequest['kind'], options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    setQueue([...queue, { ...options, kind, id: nextId++, resolve }]);
  });
}

/** Resolves to true when the user confirms, false when they cancel or dismiss. */
export function confirmDialog(options: DialogOptions): Promise<boolean> {
  return open('confirm', options);
}

/** Resolves once the user dismisses the message. */
export async function alertDialog(options: DialogOptions): Promise<void> {
  await open('alert', options);
}

/** Answers the dialog on screen and shows the next queued one. */
export function resolveDialog(id: number, confirmed: boolean) {
  const request = queue.find((r) => r.id === id);
  if (!request) return;
  setQueue(queue.filter((r) => r !== request));
  request.resolve(confirmed);
}

/** For useSyncExternalStore. */
export function subscribeDialogs(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** The dialog to show, if any. */
export function getActiveDialog(): DialogRequest | null {
  return queue[0] ?? null;
}
