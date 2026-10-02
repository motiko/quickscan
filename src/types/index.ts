export interface Point {
  x: number;
  y: number;
}

export type Quad = [Point, Point, Point, Point]; // [topLeft, topRight, bottomRight, bottomLeft]

export type DetectionHint =
  | 'too_dark'
  | 'too_bright'
  | 'low_contrast'
  | 'hold_steady'
  | 'move_closer'
  | 'move_further'
  | 'align_document'
  | null;

export interface FrameAnalysis {
  brightness: number;       // 0-255 average luminance
  contrast: number;         // standard deviation of luminance
  isTooDark: boolean;       // brightness < 60
  isTooBright: boolean;     // brightness > 240
  isLowContrast: boolean;   // contrast < 25
  hint: DetectionHint;      // user-facing guidance
}

export interface DetectedQuad {
  corners: Quad | null;
  confidence: number;
  isStable?: boolean;
  stability?: number;
  hint?: DetectionHint;
  frameAnalysis?: FrameAnalysis;
}

export type ImageFilter = 'original' | 'magic' | 'grayscale' | 'bw';

export interface ScannedDocument {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  pageCount: number;
  thumbnailBlob?: Blob;
  searchText?: string; // lower-cased OCR text of all pages, for gallery search
}

export type OcrStatus = 'pending' | 'processing' | 'done' | 'error';

export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number }; // processed-image pixels
  confidence: number;
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
  ocrStatus?: OcrStatus;
  ocrText?: string;
  ocrWords?: OcrWord[];
  ocrLang?: string;
}

export interface AppSettings {
  ocrEnabled: boolean;
  ocrLanguages: string[]; // Tesseract language codes, e.g. ['eng', 'deu']
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
