import { describe, expect, it } from 'vitest';
import { collectDocumentText } from '../ocr-text';

describe('collectDocumentText', () => {
  it('joins text of finished pages with blank lines', () => {
    expect(
      collectDocumentText([
        { ocrStatus: 'done', ocrText: 'Page one' },
        { ocrStatus: 'done', ocrText: 'Page two\n' },
      ])
    ).toBe('Page one\n\nPage two');
  });

  it('skips pages that are not done or have no text', () => {
    expect(
      collectDocumentText([
        { ocrStatus: 'pending', ocrText: 'stale' },
        { ocrStatus: 'done', ocrText: '   ' },
        { ocrStatus: 'done' },
        { ocrStatus: 'done', ocrText: 'Kept' },
      ])
    ).toBe('Kept');
  });

  it('returns an empty string when nothing is recognized', () => {
    expect(collectDocumentText([])).toBe('');
  });
});
