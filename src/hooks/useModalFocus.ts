'use client';

import { useEffect, useState, type RefObject } from 'react';

/**
 * Makes everything outside `root` inert: the siblings of `root` and of each of its ancestors up to
 * `<body>`. Elements that were already inert are left alone. Returns a function that undoes it.
 */
function inertOutside(root: HTMLElement | null): () => void {
  const madeInert: HTMLElement[] = [];
  for (let node = root; node && node !== document.body; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue;
      if (sibling instanceof HTMLScriptElement || sibling instanceof HTMLStyleElement) continue;
      sibling.inert = true;
      madeInert.push(sibling);
    }
  }
  return () => {
    for (const el of madeInert) el.inert = false;
  };
}

/**
 * Focus handling for a modal layer (UX-008), self-contained so callers don't have to do anything:
 * - on open, focuses `initial` (e.g. the Close button);
 * - while open, makes everything outside `layer` inert, so Tab and screen readers can't reach the
 *   page underneath. Layers added later (a confirm dialog from `DialogHost`) aren't touched and
 *   stay usable;
 * - on close, gives focus back to the element that opened it.
 *
 * The opener is read while rendering, before the commit makes it inert and focus falls to `<body>`.
 */
export function useModalFocus(layer: RefObject<HTMLElement | null>, initial: RefObject<HTMLElement | null>) {
  const [opener] = useState(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
  );

  useEffect(() => {
    const restore = inertOutside(layer.current);
    initial.current?.focus();
    return () => {
      // Un-inert first: an inert opener can't take focus
      restore();
      if (opener?.isConnected) opener.focus();
    };
  }, [layer, initial, opener]);
}
