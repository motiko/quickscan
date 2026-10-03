import { describe, it, expect } from 'vitest';
import {
  countByFolder,
  effectiveFolderId,
  filterDocuments,
  isFiltering,
  matchesQuery,
  EMPTY_FILTER,
  type DocumentFilter,
} from '@/lib/document-filter';
import type { ScannedDocument } from '@/types';

const now = new Date();
function doc(id: string, overrides: Partial<ScannedDocument> = {}): ScannedDocument {
  return { id, name: id, createdAt: now, updatedAt: now, pageCount: 1, ...overrides };
}

const docs = [
  doc('a', { folderId: 'f1', tags: ['Tax', '2026'] }),
  doc('b', { folderId: 'f1', tags: ['Tax'] }),
  doc('c', { folderId: 'f2', tags: ['2026'] }),
  doc('d'), // unfiled, untagged (as after the migration)
  doc('e', { folderId: 'deleted-folder', tags: [] }),
];
const folderIds = new Set(['f1', 'f2']);

function ids(filter: Partial<DocumentFilter>) {
  return filterDocuments(docs, { ...EMPTY_FILTER, ...filter }, folderIds).map((d) => d.id);
}

describe('filterDocuments', () => {
  it('shows everything without filters', () => {
    expect(ids({})).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('filters by folder', () => {
    expect(ids({ folder: { kind: 'folder', id: 'f1' } })).toEqual(['a', 'b']);
    expect(ids({ folder: { kind: 'folder', id: 'f2' } })).toEqual(['c']);
  });

  it('treats documents in a missing folder as unfiled', () => {
    expect(ids({ folder: { kind: 'unfiled' } })).toEqual(['d', 'e']);
    expect(ids({ folder: { kind: 'folder', id: 'deleted-folder' } })).toEqual([]);
    expect(effectiveFolderId(docs[4], folderIds)).toBeUndefined();
  });

  it('requires every selected tag, case-insensitively', () => {
    expect(ids({ tags: ['tax'] })).toEqual(['a', 'b']);
    expect(ids({ tags: ['TAX', '2026'] })).toEqual(['a']);
    expect(ids({ tags: ['missing'] })).toEqual([]);
  });

  it('combines folder, tags and search', () => {
    expect(ids({ folder: { kind: 'folder', id: 'f1' }, tags: ['2026'] })).toEqual(['a']);
    expect(ids({ folder: { kind: 'folder', id: 'f1' }, query: 'b' })).toEqual(['b']);
  });
});

describe('matchesQuery', () => {
  it('searches name, text, summary and tags', () => {
    const d = doc('x', {
      name: 'Electricity bill',
      searchText: 'kilowatt hours',
      summary: { text: 'Monthly Statement', model: 'm', createdAt: now, sourceHash: 'h' },
      tags: ['Utilities'],
    });
    expect(matchesQuery(d, 'bill')).toBe(true);
    expect(matchesQuery(d, 'kilowatt')).toBe(true);
    expect(matchesQuery(d, 'statement')).toBe(true);
    expect(matchesQuery(d, 'utilit')).toBe(true);
    expect(matchesQuery(d, 'nothing')).toBe(false);
    expect(matchesQuery(d, '  ')).toBe(true);
  });
});

describe('countByFolder', () => {
  it('counts per folder and unfiled under null', () => {
    const counts = countByFolder(docs, folderIds);
    expect(counts.get('f1')).toBe(2);
    expect(counts.get('f2')).toBe(1);
    expect(counts.get(null)).toBe(2);
  });
});

describe('isFiltering', () => {
  it('is false only for the empty filter', () => {
    expect(isFiltering(EMPTY_FILTER)).toBe(false);
    expect(isFiltering({ ...EMPTY_FILTER, query: ' ' })).toBe(false);
    expect(isFiltering({ ...EMPTY_FILTER, tags: ['a'] })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTER, folder: { kind: 'unfiled' } })).toBe(true);
  });
});
