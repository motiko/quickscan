import type { DocumentSummary, Folder, Page, ScannedDocument, Signature } from '@/types';
import type { SyncKind } from '@/lib/outbox';

/*
 * What each kind of record looks like inside its encrypted payload (`encryptRecord` value).
 * Only synced fields go in; local-only ones (thumbnail, original image, OCR status, search
 * text, page count) never leave the device.
 *
 * Derived fields: `searchText` and `pageCount` are NOT synced. Every device recomputes them
 * from its pages after a pull (see normalizeDocuments in engine.ts), so they can never
 * disagree with the pages they're derived from.
 *
 * Files: a page's processed image and a signature's PNG travel as separate encrypted Storage
 * objects. The payload names the object (`file.id`, fresh for every upload) and its MIME type,
 * which `encryptFile` deliberately doesn't keep.
 */

export interface FileRefPayload {
  id: string;
  type: string;
}

export interface DocumentPayload {
  name: string;
  nameSource?: ScannedDocument['nameSource'];
  folderId?: string;
  tags?: string[];
  summary?: DocumentSummary;
  createdAt: Date;
  /** Gallery order; not the sync clock. */
  updatedAt: Date;
}

export interface PagePayload {
  documentId: string;
  pageNumber: number;
  corners?: Page['corners'];
  filter: Page['filter'];
  rotation?: number;
  ocrText?: string;
  ocrWords?: Page['ocrWords'];
  ocrLang?: string;
  ocrInfo?: Page['ocrInfo'];
  annotations?: Page['annotations'];
  /** Set on a conflicted copy: the id of the page whose losing version it keeps. */
  conflictOf?: string;
  createdAt: Date;
  /** The processed image; absent if the page has none. */
  file?: FileRefPayload;
}

export interface FolderPayload {
  name: string;
  createdAt: Date;
}

export interface SignaturePayload {
  width: number;
  height: number;
  createdAt: Date;
  file?: FileRefPayload;
}

export interface SettingsPayload {
  value: unknown;
}

export type RecordPayload = DocumentPayload | PagePayload | FolderPayload | SignaturePayload | SettingsPayload;

/** Copy only the keys whose value isn't undefined (keeps payloads and records tidy). */
export function defined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function documentPayload(doc: ScannedDocument): DocumentPayload {
  return defined({
    name: doc.name,
    nameSource: doc.nameSource,
    folderId: doc.folderId,
    tags: doc.tags,
    summary: doc.summary,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

export function pagePayload(page: Page, file: FileRefPayload | undefined): PagePayload {
  return defined({
    documentId: page.documentId,
    pageNumber: page.pageNumber,
    corners: page.corners,
    filter: page.filter,
    rotation: page.rotation,
    ocrText: page.ocrText,
    ocrWords: page.ocrWords,
    ocrLang: page.ocrLang,
    ocrInfo: page.ocrInfo,
    annotations: page.annotations,
    conflictOf: page.conflictOf,
    createdAt: page.createdAt,
    file,
  });
}

// --- Material content of a page ----------------------------------------------------------

/** The page fields whose loss is real lost work. */
type MaterialFields = Pick<Page, 'annotations' | 'corners' | 'filter' | 'rotation' | 'ocrText' | 'ocrInfo'>;

/** JSON with object keys sorted, so equal values give equal strings whatever their key order. */
function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.getTime());
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** cyrb53: a fast, non-cryptographic 53-bit string hash (local comparisons only). */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A fingerprint of what a user would miss if this version of a page were overwritten:
 * annotations, crop (corners), filter, rotation, and text from a cloud model (a deliberate
 * re-transcription). Text from on-device OCR is left out: any device can recognize it again
 * from the image, and two devices recognizing the same page must not count as a conflict.
 * Synchronous, so the sync engine can compare versions inside a Dexie transaction.
 */
export function materialHash(page: MaterialFields): string {
  const llmText = page.ocrInfo?.engine === 'llm' ? (page.ocrText ?? '') : null;
  return cyrb53(
    canonicalJson({
      a: page.annotations ?? [],
      c: page.corners ?? null,
      f: page.filter ?? 'original',
      r: page.rotation ?? 0,
      t: llmText,
    })
  );
}

export function folderPayload(folder: Folder): FolderPayload {
  return { name: folder.name, createdAt: folder.createdAt };
}

export function signaturePayload(sig: Signature, file: FileRefPayload | undefined): SignaturePayload {
  return defined({ width: sig.width, height: sig.height, createdAt: sig.createdAt, file });
}

// --- Validation of decrypted payloads ----------------------------------------------------
// The payload is authenticated, so it came from one of the user's devices; these checks guard
// against older or newer app versions writing a shape this build can't use.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());
const isFileRef = (v: unknown): v is FileRefPayload => isObject(v) && typeof v.id === 'string' && typeof v.type === 'string';

export function isValidPayload(kind: SyncKind, value: unknown): value is RecordPayload {
  if (!isObject(value)) return false;
  switch (kind) {
    case 'document':
      return typeof value.name === 'string' && isDate(value.createdAt) && isDate(value.updatedAt);
    case 'page':
      return (
        typeof value.documentId === 'string' &&
        typeof value.pageNumber === 'number' &&
        typeof value.filter === 'string' &&
        isDate(value.createdAt) &&
        (value.file === undefined || isFileRef(value.file)) &&
        (value.conflictOf === undefined || typeof value.conflictOf === 'string')
      );
    case 'folder':
      return typeof value.name === 'string' && isDate(value.createdAt);
    case 'signature':
      return (
        typeof value.width === 'number' &&
        typeof value.height === 'number' &&
        isDate(value.createdAt) &&
        (value.file === undefined || isFileRef(value.file))
      );
    case 'settings':
      return 'value' in value;
    default:
      return false;
  }
}
