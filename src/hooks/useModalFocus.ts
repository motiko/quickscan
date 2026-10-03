'use client';

import { useEffect, useState, type RefObject } from 'react';

/**
 * Makes everything outside `root` inert: the siblings of `root` and of each of its ancestors up to
 * `<body>`. Elements that were already inert (e.g. by a layer underneath) are left alone, so
 * closing a layer on top of another one only undoes its own part. Returns a function that undoes it.
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

const FOCUSABLE = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';

function canFocus(el: HTMLElement): boolean {
  return !(el as HTMLButtonElement).disabled && !el.closest('[inert]') && el.getClientRects().length > 0;
}

/**
 * Where focus goes back to: the opener, and for when it's gone, its position among the focusable
 * elements of each of its ancestors (so the element that took its place can be found).
 */
interface ReturnTarget {
  opener: HTMLElement | null;
  trail: { ancestor: HTMLElement; index: number }[];
}

function returnTarget(opener: HTMLElement | null): ReturnTarget {
  const trail: ReturnTarget['trail'] = [];
  for (let a = opener?.parentElement; opener && a; a = a.parentElement) {
    trail.push({ ancestor: a, index: [...a.querySelectorAll(FOCUSABLE)].indexOf(opener) });
    if (a === document.body) break;
  }
  return { opener, trail };
}

/**
 * The opener's replacement: in the closest ancestor that's still on the page and has something to
 * focus, the element now at the opener's position (or the nearest one before it).
 */
function fallback({ trail }: ReturnTarget): HTMLElement | null {
  for (const { ancestor, index } of trail) {
    if (!ancestor.isConnected) continue;
    const all = [...ancestor.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (all.length === 0) continue;
    const start = Math.min(Math.max(index, 0), all.length - 1);
    const found = [...all.slice(start), ...all.slice(0, start).reverse()].find(canFocus);
    if (found) return found;
  }
  return null;
}

/** Stops watching the last opener focus was given back to. */
let stopWatching: (() => void) | null = null;

/**
 * Gives focus back to `target.opener`. When the opener is gone, or is removed right after (the
 * confirm dialog of a row's Delete button closes before the row goes), focus moves to the element
 * that took its place instead of falling to `<body>`.
 */
function giveFocusBack(target: ReturnTarget) {
  stopWatching?.();
  const { opener } = target;
  if (!opener?.isConnected) {
    fallback(target)?.focus();
    return;
  }
  const fresh = returnTarget(opener);
  opener.focus();
  if (document.activeElement !== opener) {
    fallback(fresh)?.focus();
    return;
  }
  const observer = new MutationObserver(() => {
    if (opener.isConnected) return;
    stop();
    if (!document.activeElement || document.activeElement === document.body) fallback(fresh)?.focus();
  });
  // Focus moved on: nothing to fix any more
  const onFocusIn = (e: FocusEvent) => {
    if (e.target !== opener) stop();
  };
  const stop = () => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocusIn);
    if (stopWatching === stop) stopWatching = null;
  };
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('focusin', onFocusIn);
  stopWatching = stop;
}

/** Layers and where each gives focus back to (a WeakMap, so closed layers drop out). */
const layers = new WeakMap<HTMLElement, ReturnTarget>();

/**
 * Focus handling for a modal layer (UX-008), self-contained so callers don't have to do anything:
 * - on open, focuses `initial` (e.g. the Close button);
 * - while open, makes everything outside `layer` inert, so Tab and screen readers can't reach the
 *   page underneath. Layers stack: a dialog over a sheet makes the sheet inert, and closing the
 *   dialog only undoes that, so the sheet stays modal;
 * - on close, gives focus back to the element that opened it (or `returnFocus()`, when given). If
 *   that element is gone, focus goes to the one that took its place, or the nearest focusable
 *   element around it. A layer opened from one that has just closed (queued dialogs) gives focus
 *   back to where that one would have.
 *
 * The opener is read while rendering, before the commit makes it inert and focus falls to `<body>`.
 * `returnFocus` must be stable (module-level or `useCallback`).
 */
export function useModalFocus(
  layer: RefObject<HTMLElement | null>,
  initial: RefObject<HTMLElement | null>,
  returnFocus?: () => HTMLElement | null
) {
  const [opened] = useState(() =>
    returnTarget(
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
    )
  );

  useEffect(() => {
    const el = layer.current;
    let target = opened;
    for (let n = opened.opener; n; n = n.parentElement) {
      const outer = layers.get(n);
      if (outer && !n.isConnected) {
        target = outer;
        break;
      }
    }
    if (el) layers.set(el, target);
    const restore = inertOutside(el);
    initial.current?.focus();
    // Not deleted on close: a dialog queued behind this one looks it up once this one is gone
    return () => {
      // Un-inert first: an inert opener can't take focus
      restore();
      const custom = returnFocus?.();
      giveFocusBack(custom ? returnTarget(custom) : target);
    };
  }, [layer, initial, opened, returnFocus]);
}
