'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ImageFilter, Quad } from '@/types';
import { CameraView } from '@/components/camera/CameraView';
import { CropOverlay } from '@/components/camera/CropOverlay';
import { FilterBar } from '@/components/camera/FilterBar';
import { applyFilter, rotateImage } from '@/lib/image-processing';
import { createDocument, addPageToDocument } from '@/hooks/useDocuments';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { useEscape } from '@/hooks/useEscape';
import { alertDialog, confirmDialog } from '@/lib/dialogs';

function ScanPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const docIdParam = searchParams?.get('docId');

  const [phase, setPhase] = useState<'camera' | 'crop' | 'review' | 'saving'>('camera');
  const [capturedBlobs, setCapturedBlobs] = useState<Blob[]>([]);
  const [rawBlob, setRawBlob] = useState<Blob | null>(null);
  const [detectedCorners, setDetectedCorners] = useState<Quad | null>(null);
  const [originalBlob, setOriginalBlob] = useState<Blob | null>(null);
  const [currentBlob, setCurrentBlob] = useState<Blob | null>(null);
  const [currentFilter, setCurrentFilter] = useState<ImageFilter>('original');
  const [documentId] = useState<string | null>(docIdParam);
  const [isRotating, setIsRotating] = useState(false);

  const previewUrl = useBlobUrl(currentBlob);

  const handleCapture = (blob: Blob, corners?: Quad | null) => {
    setRawBlob(blob);
    setDetectedCorners(corners ?? null);
    setPhase('crop');
  };

  const handleApplyCrop = (warpedBlob: Blob) => {
    setOriginalBlob(warpedBlob);
    setCurrentBlob(warpedBlob);
    setCurrentFilter('original');
    setPhase('review');
  };

  const handleRotate = async () => {
    if (!currentBlob || !originalBlob || isRotating) return;
    setIsRotating(true);
    try {
      const [newCurrent, newOriginal] = await Promise.all([
        rotateImage(currentBlob, 90),
        rotateImage(originalBlob, 90),
      ]);
      setCurrentBlob(newCurrent);
      setOriginalBlob(newOriginal);
    } catch (err) {
      console.error('Failed to rotate image:', err);
    } finally {
      setIsRotating(false);
    }
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
    setRawBlob(null);
    setDetectedCorners(null);
    setPhase('camera');
  };

  const handleAddPage = () => {
    if (currentBlob) {
      setCapturedBlobs((prev) => [...prev, currentBlob]);
      setCurrentBlob(null);
      setOriginalBlob(null);
      setRawBlob(null);
      setDetectedCorners(null);
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
      void alertDialog({ title: 'Couldn’t save the document', message: 'Please try again.' });
    }
  };

  const handleClose = async () => {
    if (capturedBlobs.length > 0 || currentBlob) {
      const count = capturedBlobs.length + (currentBlob ? 1 : 0);
      const confirmed = await confirmDialog({
        title: count === 1 ? 'Discard this scan?' : `Discard ${count} scans?`,
        message: 'Pages you haven’t saved yet will be lost.',
        confirmLabel: 'Discard',
        destructive: true,
      });
      if (!confirmed) return;
    }
    router.back();
  };

  // Escape leaves the camera (and the review screen) like the close button; crop handles its own
  useEscape(() => void handleClose(), phase === 'camera' || phase === 'review');

  if (phase === 'saving') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="flex flex-col items-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"></div>
          <p className="text-white">Saving document...</p>
        </div>
      </div>
    );
  }

  if (phase === 'crop') {
    if (!rawBlob) return <div className="h-[100dvh] bg-black" />;
    return (
      <CropOverlay
        imageBlob={rawBlob}
        initialCorners={detectedCorners}
        onApplyCrop={handleApplyCrop}
        onCancel={handleRetake}
      />
    );
  }

  if (phase === 'review') {
    const totalPages = capturedBlobs.length + 1;
    return (
      <div className="flex h-[100dvh] flex-col bg-black select-none">
        {/* Top Header */}
        <div className="relative z-10 flex items-center justify-between px-4 pb-3 pt-safe-offset-3 bg-black/80 backdrop-blur-md">
          <button
            onClick={() => setPhase('crop')}
            className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-gray-700"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 2v14a2 2 0 0 0 2 2h14" />
              <path d="M18 22V8a2 2 0 0 0-2-2H2" />
            </svg>
            Crop
          </button>

          <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white">
            Page {totalPages} {documentId ? ' (Adding to doc)' : ''}
          </span>

          <button
            onClick={handleRotate}
            disabled={isRotating}
            className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-gray-700"
            aria-label="Rotate image"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            Rotate
          </button>
        </div>

        {/* Preview Area */}
        <div className="flex-1 overflow-hidden relative flex items-center justify-center p-3">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="Scanned page"
              className="max-h-full max-w-full object-contain rounded-md shadow-2xl"
            />
          ) : (
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"></div>
          )}
        </div>

        {/* Filter Bar & Controls */}
        <div className="flex flex-col border-t border-gray-800 bg-black pb-safe-offset-3">
          <FilterBar
            imageBlob={originalBlob!}
            selectedFilter={currentFilter}
            onFilterChange={handleFilterChange}
          />

          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <button
              onClick={handleRetake}
              className="flex-1 rounded-xl bg-gray-800 py-3.5 text-sm font-semibold text-white hover:bg-gray-700 active:scale-98 transition-all"
            >
              Retake
            </button>
            <button
              onClick={handleAddPage}
              className="flex-1 rounded-xl border border-gray-600 bg-transparent py-3.5 text-sm font-semibold text-white hover:bg-white/10 active:scale-98 transition-all"
            >
              + Add Page
            </button>
            <button
              onClick={handleDone}
              className="flex-1 rounded-xl bg-blue-600 py-3.5 text-sm font-semibold text-white shadow-lg hover:bg-blue-500 active:scale-98 transition-all"
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
      <CameraView onCapture={handleCapture} onClose={() => void handleClose()} />
      {capturedBlobs.length > 0 && (
        <div className="absolute left-4 top-[calc(env(safe-area-inset-top,0px)+5rem)] z-30 flex items-center justify-center rounded-full bg-blue-600/90 px-3.5 py-1 shadow-lg backdrop-blur">
          <span className="text-xs font-semibold text-white">{capturedBlobs.length} page(s) ready</span>
        </div>
      )}
    </div>
  );
}

export default function ScanPage() {
  return (
    <Suspense
      fallback={
        <div className="bg-black flex h-[100dvh] w-full items-center justify-center">
          <p className="text-white">Loading scanner...</p>
        </div>
      }
    >
      <ScanPageContent />
    </Suspense>
  );
}
