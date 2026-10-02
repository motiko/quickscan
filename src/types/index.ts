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
  // How the current name was chosen; auto-naming only replaces 'default' names.
  // Documents created before this field existed are treated like 'user'.
  nameSource?: 'default' | 'auto' | 'user';
}

export type OcrStatus = 'pending' | 'processing' | 'done' | 'error';

export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number }; // processed-image pixels
  confidence: number;
}

export interface OcrInfo {
  engine: 'tesseract';
  languages: string[]; // traineddata used
  detectedLanguage?: string; // Tesseract language code
  confidence?: number; // 0-100
  recognizedAt: Date;
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
  ocrLang?: string; // languages joined by '+'; kept for pages recognized before ocrInfo
  ocrInfo?: OcrInfo;
  annotations?: Annotation[];
}

/*
 * Annotation coordinates are normalized to the page image: x/y in 0..1 of width/height.
 * Stroke widths and font sizes are fractions of the image width.
 */
export type Annotation =
  | { id: string; type: 'stroke'; tool: 'pen' | 'highlighter'; points: Point[]; color: string; width: number }
  | { id: string; type: 'rect'; x: number; y: number; w: number; h: number; color: string; width: number }
  | { id: string; type: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { id: string; type: 'text'; x: number; y: number; text: string; fontSize: number; color: string }
  | { id: string; type: 'signature'; x: number; y: number; w: number; h: number; signatureId: string };

export interface Signature {
  id: string;
  blob: Blob; // trimmed PNG with transparent background
  width: number;
  height: number;
  createdAt: Date;
}

export interface AppSettings {
  ocrLanguages: string[]; // Tesseract language codes, e.g. ['eng', 'deu']
  llmEnabled: boolean;
  llmProvider: LlmProvider;
  openaiApiKey: string;
  openaiModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  googleApiKey: string;
  googleModel: string;
  llmCustomEndpoint: CustomLlmEndpoint;
}

export type LlmProvider = 'openai' | 'anthropic' | 'google' | 'custom';

/** Wire format a custom endpoint speaks. */
export type LlmApiSchema = 'chat-completions' | 'anthropic-messages';

export interface CustomLlmEndpoint {
  baseUrl: string; // e.g. https://ollama.com/v1 — '/chat/completions' or '/messages' is appended
  apiKey: string;
  model: string; // optional for the user; filled in from the endpoint's model list
  schema: LlmApiSchema; // detected from the endpoint
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
