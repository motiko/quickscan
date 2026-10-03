import { addPageToDocument, createDocument } from '@/hooks/useDocuments';
import { canvasToBlob } from '@/lib/image-processing';

/** File types the upload picker accepts. HEIC/HEIF only decode where the browser supports them (Safari). */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const ACCEPTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];

/** Value for `<input accept>`: MIME types plus extensions, since some pickers report an empty type. */
export const ACCEPT_ATTRIBUTE = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_EXTENSIONS].join(',');

// Matches the camera capture's upper bound; larger uploads only slow OCR down.
const MAX_EDGE = 3840;
const JPEG_QUALITY = 0.92;

export function isAcceptedFile(file: { name: string; type: string }): boolean {
  if (file.type) return ACCEPTED_IMAGE_TYPES.includes(file.type.toLowerCase());
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

// Names cameras, phones and screenshot tools generate; these carry no meaning for the user.
const GENERATED_NAME =
  /^(img|image|dsc|dscn|dcim|pxl|photo|scan|screenshot|bildschirmfoto|whatsapp image|signal)?(?:[\d\s_.:()-]|at|wa)*$/i;

/**
 * Document name for an uploaded file. A meaningful file name is kept as the user's choice;
 * a camera-generated one is marked 'default' so auto-naming may replace it after OCR.
 */
export function nameForFile(fileName: string, now = new Date()): { name: string; nameSource: 'default' | 'user' } {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  if (base && !GENERATED_NAME.test(base)) {
    return { name: base, nameSource: 'user' };
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { name: `Upload ${stamp}`, nameSource: 'default' };
}

/** Decode an uploaded image (applying EXIF orientation), cap its size and re-encode as JPEG. */
export async function normalizeImage(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This browser cannot read this image format');
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    // Transparent PNG areas would turn black in JPEG
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

export interface ImportFailure {
  fileName: string;
  reason: string;
}

export interface ImportState {
  total: number; // files in the current batch
  done: number; // files finished, successfully or not
  failures: ImportFailure[];
  active: boolean;
}

const IDLE: ImportState = { total: 0, done: 0, failures: [], active: false };

let state: ImportState = IDLE;
let queue: File[] = [];
const subscribers = new Set<() => void>();

function setState(next: ImportState) {
  state = next;
  for (const notify of subscribers) notify();
}

/** For useSyncExternalStore: import progress survives navigating away from the gallery. */
export function subscribeImport(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function getImportState(): ImportState {
  return state;
}

/** Clear the failure list of a finished batch. */
export function dismissImportFailures(): void {
  if (!state.active) setState(IDLE);
}

/**
 * Turn each file into a one-page document whose page is queued for OCR.
 * Files added while a batch is running join that batch.
 */
export async function importFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const startsBatch = !state.active;
  queue.push(...files);
  setState({
    total: (startsBatch ? 0 : state.total) + files.length,
    done: startsBatch ? 0 : state.done,
    failures: startsBatch ? [] : state.failures,
    active: true,
  });
  if (!startsBatch) return;

  while (queue.length > 0) {
    const file = queue.shift()!;
    let failure: ImportFailure | null = null;
    if (!isAcceptedFile(file)) {
      failure = { fileName: file.name, reason: 'Unsupported file type' };
    } else {
      try {
        const blob = await normalizeImage(file);
        const { name, nameSource } = nameForFile(file.name);
        await createDocument(name, blob, nameSource);
      } catch (err) {
        console.warn('Import failed for', file.name, err);
        failure = { fileName: file.name, reason: err instanceof Error ? err.message : 'Import failed' };
      }
    }
    setState({
      ...state,
      done: state.done + 1,
      failures: failure ? [...state.failures, failure] : state.failures,
    });
  }

  queue = [];
  setState(state.failures.length > 0 ? { ...state, active: false } : IDLE);
}

/**
 * Image files on the clipboard of a paste event. Screenshots arrive as `image/png` items;
 * files copied in a file manager show up in `files`.
 */
export function imagesFromClipboard(data: Pick<DataTransfer, 'files' | 'items'> | null): File[] {
  if (!data) return [];
  const fromFiles = Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (fromFiles.length > 0) return fromFiles;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
}

/** Append each file as a new page of an existing document. Returns the files that failed. */
export async function importPagesToDocument(documentId: string, files: File[]): Promise<ImportFailure[]> {
  const failures: ImportFailure[] = [];
  for (const file of files) {
    if (!isAcceptedFile(file)) {
      failures.push({ fileName: file.name, reason: 'Unsupported file type' });
      continue;
    }
    try {
      await addPageToDocument(documentId, await normalizeImage(file));
    } catch (err) {
      console.warn('Import failed for', file.name, err);
      failures.push({ fileName: file.name, reason: err instanceof Error ? err.message : 'Import failed' });
    }
  }
  return failures;
}
