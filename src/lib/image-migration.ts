import type Dexie from 'dexie';
import { nanoid } from 'nanoid';
import type { Page, ScannedDocument } from '@/types';
import type { StoredImage } from '@/lib/images';
import { markUntracked } from '@/lib/sync-tracking';

/*
 * Before v8, images were Blobs on the records themselves (`page.originalBlob`/`processedBlob`,
 * `document.thumbnailBlob`). They move into `images` when the database opens, before anything
 * else reads it (db.on('ready')), one record per transaction. Not in the version upgrade: the
 * bytes are read and copied (see Read), which an upgrade transaction can't wait for, and a
 * failure there would keep the app from opening at all. Here a record whose image can't be
 * read just stays as it is and is tried again at the next start; one WebKit has already lost
 * (#89) is dropped.
 */

type LegacyPage = Page & { originalBlob?: Blob; processedBlob?: Blob };
type LegacyDocument = ScannedDocument & { thumbnailBlob?: Blob };

type Row = Record<string, unknown> & { id: string };

/**
 * What was read from a legacy Blob field: a copy of its bytes, or `lost` when the browser no
 * longer has them (WebKit's NotFoundError, #89). Null when there's nothing to move, or it
 * couldn't be read for another reason (tried again at the next start).
 *
 * The copy matters: storing the Blob read from IndexedDB itself in `images`, then rewriting
 * the record it came from without it, lost the new row's bytes too in WebKit (seen on the iOS
 * Simulator). A Blob made from the bytes doesn't depend on the old record.
 */
type Read = { copy: Blob; bytes: Uint8Array } | { lost: true } | null;

async function readCopy(blob: unknown): Promise<Read> {
  if (!(blob instanceof Blob)) return null;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { copy: new Blob([bytes], { type: blob.type }), bytes };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return { lost: true };
    console.warn('Could not read a stored image:', err);
    return null;
  }
}

function sameBytes(a: Read, b: Read): boolean {
  if (!a || !b || 'lost' in a || 'lost' in b || a.copy.type !== b.copy.type || a.bytes.length !== b.bytes.length) {
    return false;
  }
  for (let i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) return false;
  return true;
}

interface Move {
  from: string;
  to: string;
  read: Read;
  /** Point to the image stored for this other field instead (identical bytes). */
  sameAs?: string;
}

/**
 * Replace a record's legacy Blob fields in one transaction: each readable one becomes an
 * `images` row the record points to, a lost one is dropped (keeping it would keep the record
 * holding a Blob), and one that couldn't be read stays for the next start.
 */
async function moveFields(db: Dexie, tableName: string, id: string, moves: Move[]): Promise<void> {
  const table = db.table<Row, string>(tableName);
  const images = db.table<StoredImage, string>('images');
  try {
    await db.transaction('rw', [table, images], async (tx) => {
      // Moving an image isn't an edit: nothing to sync
      markUntracked(tx.idbtrans);
      const row = await table.get(id);
      if (!row) return;
      const next: Row = { ...row };
      const stored: Record<string, string> = {};
      let changed = false;
      for (const { from, to, read, sameAs } of moves) {
        if (!(row[from] instanceof Blob) || !read) continue;
        delete next[from];
        changed = true;
        if ('lost' in read) {
          console.warn(`Dropping the lost ${from} of ${tableName} ${id}`);
          continue;
        }
        const reuse = sameAs ? stored[sameAs] : undefined;
        const imageId = reuse ?? nanoid();
        if (!reuse) await images.add({ id: imageId, blob: read.copy, createdAt: new Date() });
        next[to] = imageId;
        stored[from] = imageId;
      }
      if (changed) await table.put(next);
    });
  } catch (err) {
    console.warn(`Could not move the images of ${tableName} ${id}`, err);
  }
}

export async function migrateLegacyImages(db: Dexie): Promise<void> {
  const pages = db.table<LegacyPage, string>('pages');
  const documents = db.table<LegacyDocument, string>('documents');

  // One record at a time: the bytes of at most two images are in memory at once
  const pageIds = await pages.filter((p) => p.originalBlob != null || p.processedBlob != null).primaryKeys();
  for (const id of pageIds) {
    const page = await pages.get(id);
    if (!page) continue;
    const processed = await readCopy(page.processedBlob);
    const original = await readCopy(page.originalBlob);
    await moveFields(db, 'pages', id, [
      { from: 'processedBlob', to: 'processedImageId', read: processed },
      // Pages captured on this device start with the same image as original and processed
      // image: keep one copy of it
      {
        from: 'originalBlob',
        to: 'originalImageId',
        read: original,
        sameAs: sameBytes(processed, original) ? 'processedBlob' : undefined,
      },
    ]);
  }

  const docIds = await documents.filter((d) => d.thumbnailBlob != null).primaryKeys();
  for (const id of docIds) {
    const doc = await documents.get(id);
    if (!doc) continue;
    await moveFields(db, 'documents', id, [{ from: 'thumbnailBlob', to: 'thumbnailId', read: await readCopy(doc.thumbnailBlob) }]);
  }
}

/** syncMeta key: images nothing pointed to at the last prune, deleted at the next if still unused. */
export const UNUSED_IMAGES_KEY = 'images:unused';

/**
 * Remove images nothing points to: replaced ones (a turned page, a new thumbnail) and any left
 * behind (deleted pages and documents normally take theirs along, see deleteImagesIfUnused).
 * A replaced image may still be on screen or being read in another open tab, so it's deleted
 * only when it was already unused at the previous start. Returns how many were deleted.
 */
export async function pruneOrphanImages(db: Dexie): Promise<number> {
  const pages = db.table<Page, string>('pages');
  const documents = db.table<ScannedDocument, string>('documents');
  const images = db.table<StoredImage, string>('images');
  const meta = db.table<{ key: string; value: unknown }, string>('syncMeta');
  // One transaction: another tab adding an image and the record pointing to it can't fall
  // between reading the references and deleting
  return db.transaction('rw', [pages, documents, images, meta], async (tx) => {
    markUntracked(tx.idbtrans);
    const used = new Set<string>();
    await pages.each((p) => {
      if (p.processedImageId) used.add(p.processedImageId);
      if (p.originalImageId) used.add(p.originalImageId);
    });
    await documents.each((d) => {
      if (d.thumbnailId) used.add(d.thumbnailId);
    });
    const unused = ((await images.toCollection().primaryKeys()) as string[]).filter((id) => !used.has(id));
    const before = (await meta.get(UNUSED_IMAGES_KEY))?.value;
    const earlier = new Set(Array.isArray(before) ? (before as string[]) : []);
    const expired = unused.filter((id) => earlier.has(id));
    if (expired.length > 0) await images.bulkDelete(expired);
    const next = unused.filter((id) => !earlier.has(id));
    if (next.length > 0) await meta.put({ key: UNUSED_IMAGES_KEY, value: next });
    else if (before !== undefined) await meta.delete(UNUSED_IMAGES_KEY);
    return expired.length;
  });
}

/** Run when the database opens (db.on('ready')); never fails the open. */
export async function prepareImages(db: Dexie): Promise<void> {
  try {
    await migrateLegacyImages(db);
    await pruneOrphanImages(db);
  } catch (err) {
    console.warn('Image store maintenance failed:', err);
  }
}
