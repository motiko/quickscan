'use client';

import { useEffect, useRef } from 'react';

/**
 * Open layers (overlays, sheets, modals, full-screen modes) in the order they opened.
 * Escape only closes the topmost one, so a dialog over a sheet over a viewer unwinds one at a time.
 */
const layers: { current: () => void }[] = [];

function onKeyDown(e: KeyboardEvent) {
  // Inputs that handle Escape themselves (e.g. cancelling an inline edit) call preventDefault
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  top.current();
}

/**
 * Close a layer with Escape while `enabled`. Register it in the component that renders the layer,
 * and keep it mounted for as long as the layer is open — the stack order is the order of mounting.
 */
export function useEscape(onEscape: () => void, enabled = true) {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  });

  useEffect(() => {
    if (!enabled) return;
    const layer = { current: () => handler.current() };
    layers.push(layer);
    if (layers.length === 1) window.addEventListener('keydown', onKeyDown);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (layers.length === 0) window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}
