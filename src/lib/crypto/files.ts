import { openEnvelope, sealEnvelope } from './aead';
import { encodeContext, toBytes, type Bytes } from './encoding';

/*
 * Files (page images, signature PNGs) in Supabase Storage:
 *
 *   0x01 || iv (12) || AES-256-GCM(vaultKey, iv, aad, fileBytes) || tag (16)
 *   aad = encodeContext('quickscan/file', [userId, fileId])
 *
 * `fileId` is the storage object's id. It must be fresh for every upload (a new random id
 * each time the file changes) and be stored inside the owning record's encrypted payload.
 * The record is authenticated and names the file; the file is bound to that name; so the
 * server can neither swap files between records nor roll one back to an older version.
 *
 * The MIME type isn't in the ciphertext: keep it in the owning record and pass it back to
 * `decryptFile`. A file is encrypted in one piece (WebCrypto has no streaming AES-GCM), so
 * it must fit in memory twice; fine for page images of a few MB.
 */

export interface FileContext {
  userId: string;
  fileId: string;
}

export function fileAad({ userId, fileId }: FileContext): Bytes {
  return encodeContext('quickscan/file', [userId, fileId]);
}

export async function encryptFile(key: CryptoKey, ctx: FileContext, file: Blob): Promise<Blob> {
  const data = new Uint8Array(await file.arrayBuffer());
  const sealed = await sealEnvelope(key, fileAad(ctx), data);
  return new Blob([sealed], { type: 'application/octet-stream' });
}

/** Throws `CryptoError` on a wrong key, tampering, a mismatched context or a truncated file. */
export async function decryptFile(
  key: CryptoKey,
  ctx: FileContext,
  data: Blob | ArrayBuffer | Uint8Array,
  options: { type?: string } = {}
): Promise<Blob> {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : toBytes(data);
  const plain = await openEnvelope(key, fileAad(ctx), bytes);
  return new Blob([plain], { type: options.type ?? '' });
}
