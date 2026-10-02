export interface Point {
  x: number;
  y: number;
}

export type ImageFilter = 'original' | 'grayscale' | 'bw';

export interface ScannedDocument {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  pageCount: number;
  thumbnailBlob?: Blob;
}

export interface Page {
  id: string;
  documentId: string;
  pageNumber: number;
  originalBlob: Blob;
  processedBlob?: Blob;
  corners?: [Point, Point, Point, Point];
  filter: ImageFilter;
  createdAt: Date;
}

export interface CameraConstraints {
  facingMode: 'user' | 'environment';
  width: number;
  height: number;
}

export interface ScanResult {
  imageBlob: Blob;
  width: number;
  height: number;
}
