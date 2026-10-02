'use client';

import { useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useDocument, deleteDocument, renameDocument } from '@/hooks/useDocuments';
import { generatePdf, shareOrDownload } from '@/lib/pdf';
import { Page } from '@/types';

export default function DocumentViewer() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  
  const { document, pages, isLoading } = useDocument(id);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [selectedPageUrl, setSelectedPageUrl] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4">
        <p className="mb-4 text-lg text-gray-700">Document not found</p>
        <button 
          onClick={() => router.push('/')}
          className="rounded-md bg-blue-600 px-4 py-2 text-white"
        >
          Return Home
        </button>
      </div>
    );
  }

  const handleNameClick = () => {
    setEditName(document.name);
    setIsEditingName(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleNameSubmit = async () => {
    if (editName.trim() && editName !== document.name) {
      await renameDocument(id, editName.trim());
    }
    setIsEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleNameSubmit();
    if (e.key === 'Escape') setIsEditingName(false);
  };

  const handleDelete = async () => {
    if (window.confirm('Are you sure you want to delete this entire document?')) {
      await deleteDocument(id);
      router.push('/');
    }
  };

  const handleExport = async () => {
    if (pages.length === 0) return;
    setIsExporting(true);
    try {
      const blobs = pages.map(p => p.processedBlob || p.originalBlob).filter(Boolean) as Blob[];
      const pdfBlob = await generatePdf(blobs);
      await shareOrDownload(pdfBlob, `${document.name}.pdf`);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Failed to export PDF.');
    } finally {
      setIsExporting(false);
    }
  };

  const getPageUrl = (page: Page) => {
    const blob = page.processedBlob || page.originalBlob;
    if (!blob) return '';
    return URL.createObjectURL(blob);
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 pb-20">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-2 bg-white px-4 shadow-sm">
        <button 
          onClick={() => router.push('/')}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-gray-100"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-6 w-6">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </button>
        
        <div className="flex-1 truncate">
          {isEditingName ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={handleNameKeyDown}
              className="w-full rounded border border-blue-500 px-2 py-1 outline-none"
            />
          ) : (
            <h1 
              onClick={handleNameClick}
              className="truncate text-lg font-semibold cursor-pointer text-gray-900"
            >
              {document.name}
            </h1>
          )}
        </div>
      </header>

      <main className="flex-1 p-4">
        <div className="grid grid-cols-2 gap-4">
          {pages.map((page, index) => {
            const url = getPageUrl(page);
            return (
              <div 
                key={page.id} 
                className="relative aspect-[3/4] overflow-hidden rounded-lg bg-gray-200 shadow"
                onClick={() => setSelectedPageUrl(url)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {url && <img src={url} alt={`Page ${index + 1}`} className="h-full w-full object-cover" />}
                <div className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
                  {index + 1}
                </div>
              </div>
            );
          })}
        </div>
      </main>

      <div className="fixed bottom-0 left-0 right-0 z-10 flex justify-around border-t bg-white p-3 pb-safe shadow-lg">
        <button
          onClick={() => router.push(`/scan?docId=${id}`)}
          className="flex flex-col items-center justify-center p-2 text-gray-600 hover:text-blue-600"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="mb-1 h-6 w-6">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-xs font-medium">Add Page</span>
        </button>
        
        <button
          onClick={handleExport}
          disabled={isExporting || pages.length === 0}
          className="flex flex-col items-center justify-center p-2 text-gray-600 hover:text-blue-600 disabled:opacity-50"
        >
          {isExporting ? (
            <div className="mb-1 h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-gray-600"></div>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="mb-1 h-6 w-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          )}
          <span className="text-xs font-medium">Export PDF</span>
        </button>

        <button
          onClick={handleDelete}
          className="flex flex-col items-center justify-center p-2 text-gray-600 hover:text-red-600"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="mb-1 h-6 w-6">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
          <span className="text-xs font-medium">Delete</span>
        </button>
      </div>

      {selectedPageUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm">
          <button
            onClick={() => setSelectedPageUrl(null)}
            className="absolute right-4 top-4 z-10 rounded-full bg-white/20 p-2 text-white hover:bg-white/30"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-6 w-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={selectedPageUrl} alt="Page full view" className="max-h-[90dvh] max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}
