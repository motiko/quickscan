import type { CameraConstraints } from '@/types';

const DEFAULT_CONSTRAINTS: CameraConstraints = {
  facingMode: 'environment',
  width: 1920,
  height: 1080,
};

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
  await videoElement.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

export function captureFrame(
  videoElement: HTMLVideoElement,
  quality = 0.92
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Could not get canvas context'));
      return;
    }

    ctx.drawImage(videoElement, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to capture frame'));
        }
      },
      'image/jpeg',
      quality
    );
  });
}

export function isCameraSupported(): boolean {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
