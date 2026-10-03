'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { sortFolders } from '@/lib/folders';
import { getAllTags } from '@/lib/tags';
import type { Folder } from '@/types';

const NO_FOLDERS: Folder[] = [];
const NO_TAGS: string[] = [];

/** All folders, sorted by name. */
export function useFolders() {
  const folders = useLiveQuery(async () => sortFolders(await db.folders.toArray()), []);
  return { folders: folders ?? NO_FOLDERS, isLoading: folders === undefined };
}

/** Every tag in use, sorted. */
export function useAllTags(): string[] {
  return useLiveQuery(getAllTags, []) ?? NO_TAGS;
}
