'use client';

import { useRouter } from 'next/navigation';
import { useDocuments, deleteDocument } from '@/hooks/useDocuments';
import { DocumentList } from '@/components/documents/DocumentList';

export default function Home() {
  const router = useRouter();
  const { documents, isLoading } = useDocuments();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 pb-20">
      <header className="fixed top-0 left-0 right-0 z-10 flex h-14 items-center justify-between bg-white px-4 shadow-sm">
        <h1 className="text-xl font-bold text-gray-900">
          QuickScan <span role="img" aria-label="camera">📸</span>
        </h1>
      </header>
      
      <main className="mt-14 flex-1 overflow-y-auto">
        <DocumentList
          documents={documents}
          onScanClick={() => router.push('/scan')}
          onDeleteDocument={async (id: string) => {
            if (window.confirm('Are you sure you want to delete this document?')) {
              await deleteDocument(id);
            }
          }}
        />
      </main>

      <button
        onClick={() => router.push('/scan')}
        className="fixed bottom-6 right-6 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 shadow-lg hover:bg-blue-700 active:bg-blue-800"
        aria-label="Scan new document"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2.5}
          stroke="currentColor"
          className="h-6 w-6 text-white"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
    </div>
  );
}
