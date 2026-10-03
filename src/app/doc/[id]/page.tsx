'use client';

import { useParams } from 'next/navigation';
import { DocumentViewer } from '@/components/documents/DocumentViewer';

// Web build URL. The static export (native app) can't prerender unknown ids and uses /doc?id=.
export default function DocumentPage() {
  const params = useParams();
  return <DocumentViewer id={params?.id as string} />;
}
