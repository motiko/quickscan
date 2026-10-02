import { describe, it, expect } from 'vitest';
import { historyReducer, type HistoryState } from '@/hooks/useAnnotationHistory';
import type { Annotation } from '@/types';

const a: Annotation = { id: 'a', type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1, color: '#000', width: 0.01 };
const b: Annotation = { ...a, id: 'b' };
const empty: HistoryState = { past: [], present: [], future: [] };

describe('historyReducer', () => {
  it('undoes and redoes commits', () => {
    let s = historyReducer(empty, { type: 'commit', annotations: [a] });
    s = historyReducer(s, { type: 'commit', annotations: [a, b] });
    expect(s.present).toEqual([a, b]);

    s = historyReducer(s, { type: 'undo' });
    expect(s.present).toEqual([a]);
    s = historyReducer(s, { type: 'undo' });
    expect(s.present).toEqual([]);
    expect(historyReducer(s, { type: 'undo' })).toBe(s);

    s = historyReducer(s, { type: 'redo' });
    s = historyReducer(s, { type: 'redo' });
    expect(s.present).toEqual([a, b]);
    expect(historyReducer(s, { type: 'redo' })).toBe(s);
  });

  it('drops the redo stack on a new commit', () => {
    let s = historyReducer(empty, { type: 'commit', annotations: [a] });
    s = historyReducer(s, { type: 'undo' });
    s = historyReducer(s, { type: 'commit', annotations: [b] });
    expect(s.future).toEqual([]);
    expect(s.present).toEqual([b]);
  });

  it('caps the history length', () => {
    let s = empty;
    for (let i = 0; i < 150; i++) s = historyReducer(s, { type: 'commit', annotations: [{ ...a, id: String(i) }] });
    expect(s.past.length).toBe(100);
  });
});
