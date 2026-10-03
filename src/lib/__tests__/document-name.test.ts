import { describe, expect, it } from 'vitest';
import { documentSnippet, isDefaultDocumentName } from '@/lib/document-name';
import { nameForFile } from '@/lib/import';

describe('isDefaultDocumentName', () => {
  it('matches the generated scan and upload names', () => {
    expect(isDefaultDocumentName('Scan 2026-10-01 12:00')).toBe(true);
    expect(isDefaultDocumentName('Upload 2026-01-31 09:05')).toBe(true);
    expect(isDefaultDocumentName(nameForFile('IMG_1234.jpg', new Date(2026, 0, 2, 3, 4)).name)).toBe(true);
  });

  it('does not match names a person or auto-naming chose', () => {
    expect(isDefaultDocumentName('Ärztlicher Befund – Dr. Meier')).toBe(false);
    expect(isDefaultDocumentName('Scan 2026-10-01 12:00 Rechnung')).toBe(false);
    expect(isDefaultDocumentName('Scan of passport')).toBe(false);
    expect(isDefaultDocumentName('scan 2026-10-01 12:00')).toBe(false);
    expect(isDefaultDocumentName(nameForFile('Gym contract.pdf').name)).toBe(false);
  });
});

describe('documentSnippet', () => {
  it('prefers the summary, then the recognized text', () => {
    expect(
      documentSnippet({
        summary: { text: 'Invoice from ACME', model: 'm', createdAt: new Date(0), sourceHash: 'h' },
        searchText: 'invoice acme',
      })
    ).toBe('Invoice from ACME');
    expect(documentSnippet({ searchText: 'rechnung\n\nnr.   42' })).toBe('rechnung nr. 42');
  });

  it('is empty without text', () => {
    expect(documentSnippet({})).toBe('');
    expect(documentSnippet({ searchText: '  \n ' })).toBe('');
  });

  it('shortens long text', () => {
    const snippet = documentSnippet({ searchText: 'word '.repeat(100) }, 20);
    expect(snippet).toBe('word word word word…');
  });
});
