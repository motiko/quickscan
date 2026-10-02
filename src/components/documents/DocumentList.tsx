'use client';

import React from 'react';
import { ScannedDocument } from '@/types';
import { DocumentCard } from './DocumentCard';

interface DocumentListProps {
  documents: ScannedDocument[];
  onScanClick: () => void;
  onDeleteDocument: (id: string) => void;
}

export function DocumentList({ documents, onScanClick, onDeleteDocument }: DocumentListProps) {
  if (!documents || documents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 p-8 text-center min-h-[50vh]">
        <div className="w-24 h-24 mb-6 rounded-full bg-blue-50 text-blue-500 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path>
            <circle cx="12" cy="13" r="3"></circle>
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">No documents yet</h2>
        <p className="text-gray-500 mb-8 max-w-sm">
          Scan your first document to get started. Use your camera to quickly capture receipts, notes, and more.
        </p>
        <button
          onClick={onScanClick}
          className="bg-blue-600 text-white px-8 py-3 rounded-full font-semibold hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm"
        >
          Start Scanning
        </button>
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
        />
      ))}
    </div>
  );
}
