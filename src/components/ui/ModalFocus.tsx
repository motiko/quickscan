'use client';

import type { RefObject } from 'react';
import { useModalFocus } from '@/hooks/useModalFocus';

/**
 * `useModalFocus` as a component, for a modal layer written inline in a bigger component: render
 * it inside the layer, so it mounts and unmounts with it.
 */
export function ModalFocus({
  layer,
  initial,
  returnFocus,
}: {
  layer: RefObject<HTMLElement | null>;
  initial: RefObject<HTMLElement | null>;
  /** Stable (`useCallback`); where focus goes on close instead of the opener. */
  returnFocus?: () => HTMLElement | null;
}) {
  useModalFocus(layer, initial, returnFocus);
  return null;
}
