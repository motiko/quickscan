'use client';

import React, { useEffect, useState } from 'react';
import { ImageFilter } from '@/types';
import { applyFilter, createThumbnail } from '@/lib/image-processing';

interface FilterBarProps {
  imageBlob: Blob;
  selectedFilter: ImageFilter;
  onFilterChange: (filter: ImageFilter) => void;
}

const FILTERS: { id: ImageFilter; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'magic', label: 'Magic Color' },
  { id: 'bw', label: 'B&W' },
  { id: 'grayscale', label: 'Grayscale' },
];

export function FilterBar({ imageBlob, selectedFilter, onFilterChange }: FilterBarProps) {
  const [previews, setPreviews] = useState<Record<ImageFilter, string | null>>({
    original: null,
    magic: null,
    bw: null,
    grayscale: null,
  });

  useEffect(() => {
    let isMounted = true;
    const objectUrls: string[] = [];

    const generatePreviews = async () => {
      try {
        // Generate a small thumbnail first for near-instant filter previews
        const thumbBlob = await createThumbnail(imageBlob, 100, 0.7);

        const previewResults = await Promise.all(
          FILTERS.map(async (filter) => {
            const resultBlob = await applyFilter(thumbBlob, filter.id);
            const url = URL.createObjectURL(resultBlob);
            objectUrls.push(url);
            return { id: filter.id, url };
          })
        );

        if (isMounted) {
          const newPreviews = {
            original: null,
            magic: null,
            bw: null,
            grayscale: null,
          } as Record<ImageFilter, string | null>;

          previewResults.forEach((result) => {
            newPreviews[result.id] = result.url;
          });

          setPreviews(newPreviews);
        }
      } catch (error) {
        console.error('Error generating filter previews:', error);
      }
    };

    generatePreviews();

    return () => {
      isMounted = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [imageBlob]);

  return (
    <div className="flex justify-center gap-4 py-4 bg-gray-900 w-full overflow-x-auto px-4 safe-area-bottom">
      {FILTERS.map((filter) => (
        <button
          key={filter.id}
          onClick={() => onFilterChange(filter.id)}
          className="flex flex-col items-center gap-2 focus:outline-none min-w-[68px]"
        >
          <div
            className={`w-14 h-14 rounded-full overflow-hidden transition-all flex items-center justify-center bg-gray-800 ${
              selectedFilter === filter.id
                ? 'ring-2 ring-blue-500 scale-105'
                : 'ring-1 ring-gray-700 opacity-70 hover:opacity-100'
            }`}
          >
            {previews[filter.id] ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={previews[filter.id]!}
                alt={`${filter.label} filter`}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full animate-pulse bg-gray-700"></div>
            )}
          </div>
          <span
            className={`text-xs font-medium whitespace-nowrap ${
              selectedFilter === filter.id ? 'text-blue-500' : 'text-gray-400'
            }`}
          >
            {filter.label}
          </span>
        </button>
      ))}
    </div>
  );
}
