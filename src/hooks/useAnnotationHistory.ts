'use client';

import { useCallback, useReducer } from 'react';
import type { Annotation } from '@/types';

export interface HistoryState {
  past: Annotation[][];
  present: Annotation[];
  future: Annotation[][];
}

export type HistoryAction =
  | { type: 'commit'; annotations: Annotation[] }
  | { type: 'undo' }
  | { type: 'redo' };

const MAX_HISTORY = 100;

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'commit':
      if (action.annotations === state.present) return state;
      return {
        past: [...state.past, state.present].slice(-MAX_HISTORY),
        present: action.annotations,
        future: [],
      };
    case 'undo': {
      if (state.past.length === 0) return state;
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
      };
    }
  }
}

export function useAnnotationHistory(initial: Annotation[]) {
  const [state, dispatch] = useReducer(historyReducer, { past: [], present: initial, future: [] });

  return {
    annotations: state.present,
    commit: useCallback((annotations: Annotation[]) => dispatch({ type: 'commit', annotations }), []),
    undo: useCallback(() => dispatch({ type: 'undo' }), []),
    redo: useCallback(() => dispatch({ type: 'redo' }), []),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    isDirty: state.past.length > 0,
  };
}
