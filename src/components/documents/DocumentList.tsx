'use client';

import React from 'react';
import { ScannedDocument } from '@/types';
import { DocumentCard } from './DocumentCard';

interface DocumentListProps {
  documents: ScannedDocument[];
  onScanClick: () => void;
  /** The built-in camera, offered under "Start Scanning" when that opens the system scanner. */
  onCameraClick?: () => void;
  onUploadClick: () => void;
  onDeleteDocument: (id: string) => void;
  processingIds?: Set<string>;
}

export function DocumentList({
  documents,
  onScanClick,
  onCameraClick,
  onUploadClick,
  onDeleteDocument,
  processingIds,
}: DocumentListProps) {
  if (!documents || documents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 p-8 text-center min-h-[50vh]">
        <div className="w-24 h-24 mb-6 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-500 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path>
            <circle cx="12" cy="13" r="3"></circle>
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">No documents yet</h2>
        <p className="text-gray-500 dark:text-gray-400 mb-8 max-w-sm">
          Scan your first document to get started, or upload photos you already have.
        </p>
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={onScanClick}
            className="bg-blue-600 text-white px-8 py-3 rounded-full font-semibold hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm"
          >
            Start Scanning
          </button>
          <button
            onClick={onUploadClick}
            className="px-8 py-3 rounded-full font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/60 transition-colors"
          >
            Upload Files
          </button>
          {onCameraClick && (
            <button
              onClick={onCameraClick}
              className="text-sm text-gray-500 dark:text-gray-400 underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Use the built-in camera
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 p-4">
      {documents.map((doc) => (
        <DocumentCard 
          key={doc.id} 
          document={doc} 
          onDelete={onDeleteDocument}
          isProcessing={processingIds?.has(doc.id)}
        />
      ))}
    </div>
  );
}
