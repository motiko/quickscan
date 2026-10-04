'use client';

import { useSyncExternalStore } from 'react';
import { usesSystemScanner } from '@/lib/platform/scanner';

const subscribe = () => () => {};

/** Whether scan buttons open the system scanner; false while prerendering, so hydration matches. */
export function useSystemScanner(): boolean {
  return useSyncExternalStore(subscribe, usesSystemScanner, () => false);
}
