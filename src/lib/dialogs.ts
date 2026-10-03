/**
 * In-app replacements for window.confirm / window.alert / window.prompt, rendered by <DialogHost> in the root layout.
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

export interface PromptOptions extends DialogOptions {
  /** Accessible label of the text field. Defaults to the title. */
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  maxLength?: number;
}

export interface DialogRequest extends PromptOptions {
  id: number;
  kind: 'confirm' | 'alert' | 'prompt';
  /** `value` is the entered text, for prompts. */
  resolve: (confirmed: boolean, value?: string) => void;
}

let queue: DialogRequest[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();

function setQueue(next: DialogRequest[]) {
  queue = next;
  for (const notify of subscribers) notify();
}

function open(kind: DialogRequest['kind'], options: PromptOptions): Promise<{ confirmed: boolean; value?: string }> {
  return new Promise((resolve) => {
    setQueue([
      ...queue,
      { ...options, kind, id: nextId++, resolve: (confirmed, value) => resolve({ confirmed, value }) },
    ]);
  });
}

/** Resolves to true when the user confirms, false when they cancel or dismiss. */
export async function confirmDialog(options: DialogOptions): Promise<boolean> {
  return (await open('confirm', options)).confirmed;
}

/** Resolves once the user dismisses the message. */
export async function alertDialog(options: DialogOptions): Promise<void> {
  await open('alert', options);
}

/** Asks for a line of text. Resolves to the entered text, or null when cancelled. */
export async function promptDialog(options: PromptOptions): Promise<string | null> {
  const { confirmed, value } = await open('prompt', options);
  return confirmed ? value ?? '' : null;
}

/** Answers the dialog on screen and shows the next queued one. */
export function resolveDialog(id: number, confirmed: boolean, value?: string) {
  const request = queue.find((r) => r.id === id);
  if (!request) return;
  setQueue(queue.filter((r) => r !== request));
  request.resolve(confirmed, value);
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
