import type { CameraConstraints } from '@/types';

const DEFAULT_CONSTRAINTS: CameraConstraints = {
  facingMode: 'environment',
  // Ask for 4K; browsers fall back to the highest resolution the camera supports.
  width: 3840,
  height: 2160,
};

const SHARPNESS_FRAME_COUNT = 3;
const SHARPNESS_FRAME_INTERVAL_MS = 60;
const SHARPNESS_SAMPLE_WIDTH = 320;
const TAKE_PHOTO_TIMEOUT_MS = 2500;
const ASPECT_TOLERANCE = 0.02;

interface ImageCaptureLike {
  takePhoto(): Promise<Blob>;
}

type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

export async function startCamera(
  videoElement: HTMLVideoElement,
  constraints: Partial<CameraConstraints> = {}
): Promise<MediaStream> {
  const merged = { ...DEFAULT_CONSTRAINTS, ...constraints };

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: merged.facingMode },
      width: { ideal: merged.width },
      height: { ideal: merged.height },
    },
    audio: false,
  });

  videoElement.srcObject = stream;
  try {
    await videoElement.play();
  } catch (err) {
    // Don't leave the camera running if the caller never receives the stream
    stopCamera(stream);
    // A newer startCamera call may already own the element
    if (videoElement.srcObject === stream) videoElement.srcObject = null;
    throw err;
  }
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

/**
 * Captures the highest-quality still available.
 * Prefers ImageCapture.takePhoto() (full sensor resolution, Chrome/Android) when its framing
 * matches the preview; otherwise picks the sharpest of a short burst of video frames.
 */
export async function captureStill(
  videoElement: HTMLVideoElement,
  stream: MediaStream | null,
  quality = 0.95
): Promise<Blob> {
  const track = stream?.getVideoTracks()[0];
  if (track) {
    const photo = await tryTakePhoto(track, videoElement);
    if (photo) return photo;
  }
  return captureSharpestFrame(videoElement, quality);
}

async function tryTakePhoto(
  track: MediaStreamTrack,
  videoElement: HTMLVideoElement
): Promise<Blob | null> {
  const ImageCaptureImpl = (globalThis as unknown as { ImageCapture?: ImageCaptureCtor })
    .ImageCapture;
  if (!ImageCaptureImpl) return null;

  try {
    const imageCapture = new ImageCaptureImpl(track);
    const photo = await Promise.race([
      imageCapture.takePhoto(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TAKE_PHOTO_TIMEOUT_MS)),
    ]);
    if (!photo) return null;

    // Detected corners are normalized to the preview frame, so the photo must share its framing.
    const bitmap = await createImageBitmap(photo);
    const photoAspect = bitmap.width / bitmap.height;
    const isLarger = bitmap.width * bitmap.height > videoElement.videoWidth * videoElement.videoHeight;
    bitmap.close();

    const videoAspect = videoElement.videoWidth / (videoElement.videoHeight || 1);
    if (Math.abs(photoAspect - videoAspect) / videoAspect > ASPECT_TOLERANCE || !isLarger) {
      return null;
    }
    return photo;
  } catch (err) {
    console.warn('takePhoto failed, falling back to video frame:', err);
    return null;
  }
}

async function captureSharpestFrame(videoElement: HTMLVideoElement, quality: number): Promise<Blob> {
  const width = videoElement.videoWidth;
  const height = videoElement.videoHeight;

  const sampleW = Math.min(SHARPNESS_SAMPLE_WIDTH, width);
  const sampleH = Math.max(1, Math.round((height / (width || 1)) * sampleW));
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = sampleW;
  sampleCanvas.height = sampleH;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  let bestCanvas: HTMLCanvasElement | null = null;
  let bestScore = -1;

  for (let i = 0; i < SHARPNESS_FRAME_COUNT; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, SHARPNESS_FRAME_INTERVAL_MS));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    ctx.drawImage(videoElement, 0, 0);

    let score = 0;
    if (sampleCtx) {
      sampleCtx.drawImage(canvas, 0, 0, sampleW, sampleH);
      score = measureSharpness(sampleCtx.getImageData(0, 0, sampleW, sampleH));
    }
    if (score > bestScore) {
      bestScore = score;
      bestCanvas = canvas;
    }
  }

  return new Promise((resolve, reject) => {
    bestCanvas!.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to capture frame'))),
      'image/jpeg',
      quality
    );
  });
}

/**
 * Variance of the Laplacian over luminance: higher means sharper (less motion/focus blur).
 */
export function measureSharpness(imageData: ImageData): number {
  const { width, height, data } = imageData;
  if (width < 3 || height < 3) return 0;

  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function isCameraSupported(): boolean {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
