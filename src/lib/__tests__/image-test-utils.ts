import { nanoid } from 'nanoid';
import { db } from '@/lib/db';
import { getImage } from '@/lib/images';

/*
 * Images live in `images` rows that pages and documents point to by id (lib/images.ts). The
 * rows are written directly here, so a test can pick the id; nothing should point to a row
 * before it exists, as the open (db.on('ready')) prunes rows nothing points to.
 */

export async function addImage(content: string | Blob, id = nanoid()): Promise<string> {
  const blob = typeof content === 'string' ? new Blob([content]) : content;
  await db.images.put({ id, blob, createdAt: new Date() });
  return id;
}

/** The text of an image, or undefined when there's no id or no row. */
export async function imageText(id: string | undefined): Promise<string | undefined> {
  return (await getImage(id))?.text();
}
