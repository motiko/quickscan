export interface Point {
  x: number;
  y: number;
}

export type Quad = [Point, Point, Point, Point]; // [topLeft, topRight, bottomRight, bottomLeft]

export interface DetectedQuad {
  corners: Quad;
  confidence: number;
}

export type ImageFilter = 'original' | 'magic' | 'grayscale' | 'bw';

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
  corners?: Quad;
  filter: ImageFilter;
  rotation?: number; // 0, 90, 180, 270
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
