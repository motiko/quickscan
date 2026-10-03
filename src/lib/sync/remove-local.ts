import { db } from '@/lib/db';
import { applyUntracked, type OutboxEntry } from '@/lib/outbox';
import type { Folder, Page, ScannedDocument, Signature } from '@/types';
import { withSyncLock } from './lock';
import { badRowsKey, cursorKey, fileKey, FILE_PREFIX, LAST_USER_KEY, mergeKey, unverifiedKey, type FileRef } from './state';

/*
 * "Remove synced documents from this device": drop the local copies of everything whose
 * latest version is on the server, so a shared or old device can be cleaned up. Local only —
 * the deletes go through `applyUntracked`, so nothing is tombstoned on the server — and the
 * pull cursor is reset, so a later sync with the account downloads everything again.
 *
 * A record counts as synced when this device has finished syncing with the account (it was
 * the last account synced and the first-sync merge is done), it has no pending outbox entry,
 * and, for pages and signatures with an image, the image is mapped to an object of that
 * account. A document goes only together with all of its pages; a folder only when no
 * remaining document is in it. Everything else stays.
 */

export interface RemovalPlan {
  /** False when this device hasn't completed a sync with the account: nothing can go. */
  synced: boolean;
  documents: string[];
  pages: string[];
  folders: string[];
  signatures: string[];
  /** File mappings to drop (removed records and signatures still waiting for their image). */
  refKeys: string[];
  keptDocuments: number;
  keptFolders: number;
  keptSignatures: number;
}

interface Snapshot {
  lastUserId: unknown;
  merging: unknown;
  outbox: OutboxEntry[];
  refs: FileRef[];
  documents: ScannedDocument[];
  pages: Page[];
  folders: Folder[];
  signatures: Signature[];
}

/** Pure: what can go, given everything on the device. */
export function planRemoval(userId: string, s: Snapshot): RemovalPlan {
  const plan: RemovalPlan = {
    synced: s.lastUserId === userId && s.merging !== true,
    documents: [],
    pages: [],
    folders: [],
    signatures: [],
    refKeys: [],
    keptDocuments: s.documents.length,
    keptFolders: s.folders.length,
    keptSignatures: s.signatures.length,
  };
  if (!plan.synced) return plan;

  const pending = new Set(s.outbox.map((e) => `${e.kind}:${e.id}`));
  const refs = new Map(s.refs.map((r) => [`${r.kind}:${r.id}`, r]));
  const hasRemoteFile = (kind: FileRef['kind'], id: string) => refs.get(`${kind}:${id}`)?.userId === userId;

  const pagesByDoc = new Map<string, Page[]>();
  for (const page of s.pages) {
    const list = pagesByDoc.get(page.documentId) ?? [];
    list.push(page);
    pagesByDoc.set(page.documentId, list);
  }
  const pageSynced = (p: Page) =>
    !pending.has(`page:${p.id}`) && (hasRemoteFile('page', p.id) || (p.processedBlob == null && p.originalBlob == null));

  const keptFolderIds = new Set<string>();
  for (const doc of s.documents) {
    const pages = pagesByDoc.get(doc.id) ?? [];
    if (!pending.has(`document:${doc.id}`) && pages.every(pageSynced)) {
      plan.documents.push(doc.id);
      for (const p of pages) {
        plan.pages.push(p.id);
        if (refs.has(`page:${p.id}`)) plan.refKeys.push(fileKey('page', p.id));
      }
    } else if (doc.folderId) {
      keptFolderIds.add(doc.folderId);
    }
  }
  for (const folder of s.folders) {
    if (!pending.has(`folder:${folder.id}`) && !keptFolderIds.has(folder.id)) plan.folders.push(folder.id);
  }
  for (const sig of s.signatures) {
    if (!pending.has(`signature:${sig.id}`) && hasRemoteFile('signature', sig.id)) {
      plan.signatures.push(sig.id);
      plan.refKeys.push(fileKey('signature', sig.id));
    }
  }
  // Signatures that never arrived (waiting for their image) come back with the next sync too
  const signatureIds = new Set(s.signatures.map((x) => x.id));
  for (const ref of s.refs) {
    if (ref.kind === 'signature' && !signatureIds.has(ref.id)) plan.refKeys.push(fileKey('signature', ref.id));
  }

  plan.keptDocuments = s.documents.length - plan.documents.length;
  plan.keptFolders = s.folders.length - plan.folders.length;
  plan.keptSignatures = s.signatures.length - plan.signatures.length;
  return plan;
}

/** Direct Dexie reads only, so it can run inside the removal transaction. */
async function snapshot(userId: string): Promise<Snapshot> {
  // One at a time: inside a transaction only direct Dexie calls may be awaited
  const lastUser = await db.syncMeta.get(LAST_USER_KEY);
  const merging = await db.syncMeta.get(mergeKey(userId));
  const outbox = await db.outbox.toArray();
  const refRows = await db.syncMeta.where('key').startsWith(FILE_PREFIX).toArray();
  const documents = await db.documents.toArray();
  const pages = await db.pages.toArray();
  const folders = await db.folders.toArray();
  const signatures = await db.signatures.toArray();
  return {
    lastUserId: lastUser?.value,
    merging: merging?.value,
    outbox,
    refs: refRows.map((r) => r.value as FileRef),
    documents,
    pages,
    folders,
    signatures,
  };
}

/** What "Remove synced documents" would do right now, for the confirmation text. */
export async function previewRemoval(userId: string): Promise<RemovalPlan> {
  return db.transaction('r', [db.syncMeta, db.outbox, db.documents, db.pages, db.folders, db.signatures], () =>
    snapshot(userId)
  ).then((s) => planRemoval(userId, s));
}

/**
 * Remove the synced records of `userId` from this device. Waits for any sync run to finish
 * first (same lock), and decides and deletes in one transaction, so a change made meanwhile
 * either counts as unsynced or isn't there yet.
 */
export async function removeSyncedFromDevice(userId: string): Promise<RemovalPlan> {
  return withSyncLock(() =>
    applyUntracked(async () => {
      const plan = planRemoval(userId, await snapshot(userId));
      if (!plan.synced) return plan;
      await db.pages.bulkDelete(plan.pages);
      await db.documents.bulkDelete(plan.documents);
      await db.folders.bulkDelete(plan.folders);
      await db.signatures.bulkDelete(plan.signatures);
      await db.syncMeta.bulkDelete(plan.refKeys);
      // Download everything again next time; rows that couldn't be read (and deletions that
      // couldn't be verified) get another look
      await db.syncMeta.bulkDelete([cursorKey(userId), badRowsKey(userId), unverifiedKey(userId)]);
      return plan;
    })
  );
}
