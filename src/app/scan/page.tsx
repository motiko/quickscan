'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ImageFilter } from '@/types';
import { CameraView } from '@/components/camera/CameraView';
import { FilterBar } from '@/components/camera/FilterBar';
import { applyFilter } from '@/lib/image-processing';
import { createDocument, addPageToDocument } from '@/hooks/useDocuments';

function ScanPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const docIdParam = searchParams?.get('docId');

  const [phase, setPhase] = useState<'camera' | 'review' | 'saving'>('camera');
  const [capturedBlobs, setCapturedBlobs] = useState<Blob[]>([]);
  const [currentBlob, setCurrentBlob] = useState<Blob | null>(null);
  const [originalBlob, setOriginalBlob] = useState<Blob | null>(null);
  const [currentFilter, setCurrentFilter] = useState<ImageFilter>('original');
  const [documentId, setDocumentId] = useState<string | null>(docIdParam);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (currentBlob) {
      const url = URL.createObjectURL(currentBlob);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [currentBlob]);

  const handleCapture = (blob: Blob) => {
    setOriginalBlob(blob);
    setCurrentBlob(blob);
    setCurrentFilter('original');
    setPhase('review');
  };

  const handleFilterChange = async (filter: ImageFilter) => {
    setCurrentFilter(filter);
    if (!originalBlob) return;
    
    if (filter === 'original') {
      setCurrentBlob(originalBlob);
    } else {
      try {
        const filteredBlob = await applyFilter(originalBlob, filter);
        setCurrentBlob(filteredBlob);
      } catch (err) {
        console.error('Failed to apply filter:', err);
      }
    }
  };

  const handleRetake = () => {
    setCurrentBlob(null);
    setOriginalBlob(null);
    setPhase('camera');
  };

  const handleAddPage = () => {
    if (currentBlob) {
      setCapturedBlobs((prev) => [...prev, currentBlob]);
      setCurrentBlob(null);
      setOriginalBlob(null);
      setPhase('camera');
    }
  };

  const handleDone = async () => {
    if (!currentBlob && capturedBlobs.length === 0) {
      router.back();
      return;
    }
    
    setPhase('saving');
    try {
      const allBlobs = currentBlob ? [...capturedBlobs, currentBlob] : capturedBlobs;
      
      let finalDocId = documentId;
      if (!finalDocId) {
        const now = new Date();
        const docName = `Scan ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        finalDocId = await createDocument(docName, allBlobs[0]);
        
        for (let i = 1; i < allBlobs.length; i++) {
          await addPageToDocument(finalDocId, allBlobs[i]);
        }
      } else {
        for (const blob of allBlobs) {
          await addPageToDocument(finalDocId, blob);
        }
      }
      
      router.push(`/doc/${finalDocId}`);
    } catch (err) {
      console.error('Failed to save document:', err);
      setPhase('review');
      alert('Failed to save document. Please try again.');
    }
  };

  const handleClose = () => {
    if (capturedBlobs.length === 0 && !currentBlob) {
      router.back();
    } else if (window.confirm('Discard current scan(s)?')) {
      router.back();
    }
  };

  if (phase === 'saving') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="flex flex-col items-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"></div>
          <p className="text-white">Saving...</p>
        </div>
      </div>
    );
  }

  if (phase === 'review' && previewUrl) {
    const totalPages = capturedBlobs.length + 1;
    return (
      <div className="flex h-[100dvh] flex-col bg-black">
        <div className="absolute left-0 right-0 top-4 z-10 text-center">
          <span className="rounded bg-black/50 px-3 py-1 text-sm font-medium text-white backdrop-blur">
            Page {totalPages} {documentId ? ' (Adding to doc)' : ''}
          </span>
        </div>
        
        <div className="flex-1 overflow-hidden relative flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img 
            src={previewUrl} 
            alt="Scanned page" 
            className="max-h-full max-w-full object-contain"
          />
        </div>

        <div className="flex flex-col border-t border-gray-800 bg-black pb-safe">
          <FilterBar imageBlob={originalBlob!} selectedFilter={currentFilter} onFilterChange={handleFilterChange} />
          
          <div className="flex items-center justify-between gap-2 px-4 py-4">
            <button
              onClick={handleRetake}
              className="flex-1 rounded-lg bg-gray-800 py-3 font-medium text-white hover:bg-gray-700"
            >
              Retake
            </button>
            <button
              onClick={handleAddPage}
              className="flex-1 rounded-lg border border-white bg-transparent py-3 font-medium text-white hover:bg-white/10"
            >
              Add Page
            </button>
            <button
              onClick={handleDone}
              className="flex-1 rounded-lg bg-blue-600 py-3 font-medium text-white hover:bg-blue-700"
            >
              Done ✓
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] bg-black">
      <CameraView onCapture={handleCapture} onClose={handleClose} />
      {capturedBlobs.length > 0 && (
        <div className="absolute left-4 top-4 z-10 flex items-center justify-center rounded bg-blue-600 px-3 py-1 shadow-lg">
          <span className="text-sm font-medium text-white">{capturedBlobs.length} saved</span>
        </div>
      )}
    </div>
  );
}

export default function ScanPage() {
  return (
    <Suspense fallback={<div className="bg-black flex h-[100dvh] w-full items-center justify-center"><p className="text-white">Loading...</p></div>}>
      <ScanPageContent />
    </Suspense>
  );
}
