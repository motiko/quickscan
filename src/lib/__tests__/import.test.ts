import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/hooks/useDocuments', () => ({
  createDocument: vi.fn(async () => 'doc-id'),
  addPageToDocument: vi.fn(async () => 'page-id'),
  createDocumentWithPages: vi.fn(async () => 'doc-id'),
  addPagesToDocument: vi.fn(async () => {}),
}));

import { addPageToDocument, addPagesToDocument, createDocument, createDocumentWithPages } from '@/hooks/useDocuments';
import {
  isAcceptedFile,
  nameForFile,
  importFiles,
  getImportState,
  subscribeImport,
  dismissImportFailures,
  imagesFromClipboard,
  importPagesToDocument,
  importScan,
  scanName,
} from '@/lib/import';

const mockCreateDocument = vi.mocked(createDocument);
const mockAddPage = vi.mocked(addPageToDocument);
const mockCreateWithPages = vi.mocked(createDocumentWithPages);
const mockAddPages = vi.mocked(addPagesToDocument);

function file(name: string, type: string): File {
  return new File(['data'], name, { type });
}

describe('isAcceptedFile', () => {
  it('accepts common image types', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
      expect(isAcceptedFile({ name: 'x', type })).toBe(true);
    }
  });

  it('rejects other types', () => {
    expect(isAcceptedFile({ name: 'a.gif', type: 'image/gif' })).toBe(false);
    expect(isAcceptedFile({ name: 'a.pdf', type: 'application/pdf' })).toBe(false);
  });

  it('falls back to the extension when the type is missing', () => {
    expect(isAcceptedFile({ name: 'Photo.HEIC', type: '' })).toBe(true);
    expect(isAcceptedFile({ name: 'notes.txt', type: '' })).toBe(false);
  });
});

describe('nameForFile', () => {
  const now = new Date(2026, 9, 2, 9, 5);

  it('keeps meaningful file names as the user’s choice', () => {
    expect(nameForFile('Invoice March.jpg', now)).toEqual({ name: 'Invoice March', nameSource: 'user' });
    expect(nameForFile('lease-agreement.final.png', now)).toEqual({
      name: 'lease-agreement.final',
      nameSource: 'user',
    });
  });

  it('replaces camera-generated names with a default that auto-naming may change', () => {
    for (const generated of [
      'IMG_1234.jpg',
      'IMG_1234 (1).JPG',
      'PXL_20261001_123456789.jpg',
      'DSC00042.png',
      'Screenshot 2026-10-01 at 12.34.56.png',
      'WhatsApp Image 2026-10-01 at 12.34.56.jpeg',
      'IMG-20261001-WA0001.jpg',
      '20261001_120000.heic',
    ]) {
      expect(nameForFile(generated, now)).toEqual({ name: 'Upload 2026-10-02 09:05', nameSource: 'default' });
    }
  });
});

function stubImageDecoding() {
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    if ((blob as File).name.startsWith('broken')) throw new Error('decode failed');
    return { width: 8000, height: 4000, close: () => {} };
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillRect: () => {}, drawImage: () => {}, fillStyle: '' }),
    toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob([`${canvas.width}x${canvas.height}`], { type })),
  };
  vi.stubGlobal('document', { createElement: () => canvas });
}

describe('importFiles', () => {
  beforeEach(() => {
    mockCreateDocument.mockClear();
    dismissImportFailures();
    stubImageDecoding();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates one document per file with a downscaled JPEG', async () => {
    await importFiles([file('Invoice.png', 'image/png'), file('IMG_0001.jpg', 'image/jpeg')]);

    expect(mockCreateDocument).toHaveBeenCalledTimes(2);
    const [name, blob, nameSource] = mockCreateDocument.mock.calls[0];
    expect(name).toBe('Invoice');
    expect(nameSource).toBe('user');
    expect(blob.type).toBe('image/jpeg');
    expect(await blob.text()).toBe('3840x1920');
    expect(mockCreateDocument.mock.calls[1][2]).toBe('default');
    expect(getImportState()).toEqual({ total: 0, done: 0, failures: [], active: false });
  });

  it('reports progress and keeps failures after the batch finishes', async () => {
    const snapshots: string[] = [];
    const unsubscribe = subscribeImport(() => {
      const s = getImportState();
      snapshots.push(`${s.done}/${s.total}`);
    });

    await importFiles([
      file('a.jpg', 'image/jpeg'),
      file('anim.gif', 'image/gif'),
      file('broken.heic', 'image/heic'),
    ]);
    unsubscribe();

    expect(snapshots).toEqual(['0/3', '1/3', '2/3', '3/3', '3/3']);
    expect(mockCreateDocument).toHaveBeenCalledTimes(1);
    const state = getImportState();
    expect(state.active).toBe(false);
    expect(state.failures).toEqual([
      { fileName: 'anim.gif', reason: 'Unsupported file type' },
      { fileName: 'broken.heic', reason: 'This browser cannot read this image format' },
    ]);

    dismissImportFailures();
    expect(getImportState().failures).toEqual([]);
  });

  it('adds files picked mid-import to the running batch', async () => {
    const first = importFiles([file('a.jpg', 'image/jpeg')]);
    const second = importFiles([file('b.jpg', 'image/jpeg'), file('c.jpg', 'image/jpeg')]);
    expect(getImportState()).toMatchObject({ total: 3, active: true });

    await Promise.all([first, second]);
    expect(mockCreateDocument).toHaveBeenCalledTimes(3);
    expect(getImportState().active).toBe(false);
  });
});

describe('imagesFromClipboard', () => {
  const item = (kind: string, f: File | null) => ({ kind, type: f?.type ?? 'text/plain', getAsFile: () => f });

  it('returns pasted image files', () => {
    const png = file('image.png', 'image/png');
    const data = { files: [png, file('notes.txt', 'text/plain')], items: [] };
    expect(imagesFromClipboard(data as unknown as DataTransfer)).toEqual([png]);
  });

  it('falls back to clipboard items when files is empty', () => {
    const png = file('image.png', 'image/png');
    const data = { files: [], items: [item('string', null), item('file', png)] };
    expect(imagesFromClipboard(data as unknown as DataTransfer)).toEqual([png]);
  });

  it('returns nothing for text pastes', () => {
    expect(imagesFromClipboard({ files: [], items: [item('string', null)] } as unknown as DataTransfer)).toEqual([]);
    expect(imagesFromClipboard(null)).toEqual([]);
  });
});

describe('importPagesToDocument', () => {
  beforeEach(() => {
    mockAddPage.mockClear();
    stubImageDecoding();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends each image as a normalized page and reports failures', async () => {
    const failures = await importPagesToDocument('doc-1', [
      file('image.png', 'image/png'),
      file('anim.gif', 'image/gif'),
      file('broken.png', 'image/png'),
    ]);

    expect(mockAddPage).toHaveBeenCalledTimes(1);
    const [docId, blob] = mockAddPage.mock.calls[0];
    expect(docId).toBe('doc-1');
    expect(blob.type).toBe('image/jpeg');
    expect(failures).toEqual([
      { fileName: 'anim.gif', reason: 'Unsupported file type' },
      { fileName: 'broken.png', reason: 'This browser cannot read this image format' },
    ]);
  });
});

describe('importScan', () => {
  beforeEach(() => {
    mockCreateWithPages.mockClear();
    mockAddPages.mockClear();
    stubImageDecoding();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const page = (name: string) => new File(['data'], name, { type: 'image/jpeg' });

  it('makes one document of the scan, pages in order, re-encoded to the M9 size', async () => {
    const id = await importScan([page('p1.jpg'), page('p2.jpg'), page('p3.jpg')]);

    expect(id).toBe('doc-id');
    expect(mockCreateWithPages).toHaveBeenCalledTimes(1);
    const [name, blobs, nameSource] = mockCreateWithPages.mock.calls[0];
    expect(name).toMatch(/^Scan \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(nameSource).toBeUndefined(); // 'default': auto-naming may replace it
    expect(blobs).toHaveLength(3);
    expect(blobs.map((b) => b.type)).toEqual(['image/jpeg', 'image/jpeg', 'image/jpeg']);
    expect(await blobs[0].text()).toBe('2500x1250');
  });

  it('keeps the page order', async () => {
    vi.stubGlobal('createImageBitmap', async (blob: File) => ({
      width: Number(blob.name.slice(1, 2)) * 100,
      height: 1000,
      close: () => {},
    }));
    await importScan([page('p1.jpg'), page('p2.jpg'), page('p3.jpg')]);
    const blobs = mockCreateWithPages.mock.calls[0][1];
    expect(await Promise.all(blobs.map((b) => b.text()))).toEqual(['100x1000', '200x1000', '300x1000']);
  });

  it('appends to an existing document', async () => {
    await expect(importScan([page('p1.jpg'), page('p2.jpg')], 'doc-1')).resolves.toBe('doc-1');
    expect(mockCreateWithPages).not.toHaveBeenCalled();
    expect(mockAddPages).toHaveBeenCalledWith('doc-1', [expect.any(Blob), expect.any(Blob)]);
  });

  it('writes nothing when a page can’t be read', async () => {
    await expect(importScan([page('p1.jpg'), page('broken.jpg')])).rejects.toThrow();
    expect(mockCreateWithPages).not.toHaveBeenCalled();
    expect(mockAddPages).not.toHaveBeenCalled();
  });

  it('names the document like a camera scan', () => {
    expect(scanName(new Date(2026, 9, 4, 9, 5))).toBe('Scan 2026-10-04 09:05');
  });
});
