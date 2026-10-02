'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import { db } from '@/lib/db';
import type { Signature } from '@/types';

export function useSignatures() {
  const signatures = useLiveQuery(() => db.signatures.orderBy('createdAt').reverse().toArray(), []);
  return signatures ?? [];
}

export async function saveSignature(blob: Blob, width: number, height: number): Promise<Signature> {
  const signature: Signature = { id: nanoid(), blob, width, height, createdAt: new Date() };
  await db.signatures.add(signature);
  return signature;
}

export async function deleteSignature(id: string): Promise<void> {
  await db.signatures.delete(id);
}
