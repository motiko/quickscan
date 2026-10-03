/** Folder and tag actions that ask the user through in-app dialogs. Shared by the gallery and the document page. */
import { alertDialog, confirmDialog, promptDialog } from '@/lib/dialogs';
import {
  createFolder,
  deleteFolder,
  FolderNameError,
  MAX_FOLDER_NAME_LENGTH,
  renameFolder,
} from '@/lib/folders';
import { deleteTag, MAX_TAG_LENGTH, normalizeTag, renameTag } from '@/lib/tags';
import type { Folder } from '@/types';

/** Asks again until the name is accepted or the user cancels. */
async function askFolderName(
  options: { title: string; confirmLabel: string; defaultValue?: string },
  save: (name: string) => Promise<string | void>
): Promise<string | null> {
  let defaultValue = options.defaultValue;
  for (;;) {
    const name = await promptDialog({
      ...options,
      defaultValue,
      label: 'Folder name',
      placeholder: 'e.g. Receipts',
      maxLength: MAX_FOLDER_NAME_LENGTH,
    });
    if (name === null) return null;
    try {
      return (await save(name)) ?? '';
    } catch (err) {
      if (!(err instanceof FolderNameError)) throw err;
      await alertDialog({ title: 'Choose another name', message: err.message });
      defaultValue = name;
    }
  }
}

/** Resolves to the new folder's id, or null when cancelled. */
export function promptCreateFolder(): Promise<string | null> {
  return askFolderName({ title: 'New folder', confirmLabel: 'Create' }, createFolder);
}

export async function promptRenameFolder(folder: Folder): Promise<void> {
  await askFolderName(
    { title: 'Rename folder', confirmLabel: 'Rename', defaultValue: folder.name },
    (name) => renameFolder(folder.id, name)
  );
}

/** Resolves to true when the folder was deleted. */
export async function confirmDeleteFolder(folder: Folder, documentCount: number): Promise<boolean> {
  const confirmed = await confirmDialog({
    title: `Delete “${folder.name}”?`,
    message:
      documentCount === 0
        ? 'The folder is empty.'
        : `Its ${documentCount === 1 ? 'document isn’t' : `${documentCount} documents aren’t`} deleted — ${
            documentCount === 1 ? 'it moves' : 'they move'
          } to Unfiled.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (confirmed) await deleteFolder(folder.id);
  return confirmed;
}

/** Resolves to the new tag name, or null when cancelled or unchanged. */
export async function promptRenameTag(tag: string): Promise<string | null> {
  const name = await promptDialog({
    title: 'Rename tag',
    message: 'The tag is renamed on every document.',
    label: 'Tag name',
    confirmLabel: 'Rename',
    defaultValue: tag,
    maxLength: MAX_TAG_LENGTH,
  });
  if (name === null || !normalizeTag(name) || normalizeTag(name) === tag) return null;
  await renameTag(tag, name);
  return normalizeTag(name);
}

/** Resolves to true when the tag was deleted. */
export async function confirmDeleteTag(tag: string, documentCount: number): Promise<boolean> {
  const confirmed = await confirmDialog({
    title: `Delete tag “${tag}”?`,
    message: `It’s removed from ${documentCount === 1 ? '1 document' : `${documentCount} documents`}. The documents are kept.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (confirmed) await deleteTag(tag);
  return confirmed;
}
