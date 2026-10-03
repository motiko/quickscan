'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { DocumentViewer } from '@/components/documents/DocumentViewer';

function DocumentFromQuery() {
  const id = useSearchParams().get('id') ?? '';
  return <DocumentViewer key={id} id={id} />;
}

// Static export URL (/doc?id=), used by the native app; see docHref in lib/routes.ts.
export default function DocumentQueryPage() {
  return (
    <Suspense>
      <DocumentFromQuery />
    </Suspense>
  );
}
