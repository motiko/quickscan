/*
 * QR codes in the browser: drawing one (uqr, ~8 KB gzipped, no dependencies) and reading one
 * from a camera <video> (the native BarcodeDetector where it supports QR codes — Chrome on
 * Android, macOS — else jsQR, which is pure JavaScript, for iOS Safari and Firefox). Both
 * libraries are loaded on first use only, and neither uses eval or inline scripts.
 */

/** Draw `text` onto `canvas`, black on white with the standard 4-module quiet zone. */
export async function drawQrCode(canvas: HTMLCanvasElement, text: string, sizePx: number): Promise<void> {
  const { encode } = await import('uqr');
  const qr = encode(text, { ecc: 'M', border: 4 });
  const scale = Math.max(1, Math.floor(sizePx / qr.size));
  const side = qr.size * scale;
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = '#000';
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) ctx.fillRect(x * scale, y * scale, scale, scale);
    }),
  );
}

export interface QrReader {
  /** The text of a QR code in the current video frame, or null. */
  read(video: HTMLVideoElement): Promise<string | null>;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

/** Frames are scaled down to this width for jsQR; QR codes on a phone screen stay readable. */
const FALLBACK_FRAME_WIDTH = 640;

export async function createQrReader(): Promise<QrReader> {
  const Native = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (Native) {
    try {
      if ((await Native.getSupportedFormats()).includes('qr_code')) {
        const detector = new Native({ formats: ['qr_code'] });
        return {
          async read(video) {
            if (video.readyState < 2) return null;
            const codes = await detector.detect(video);
            return codes[0]?.rawValue ?? null;
          },
        };
      }
    } catch {
      // Fall through to jsQR.
    }
  }

  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    async read(video) {
      if (!ctx || video.readyState < 2 || !video.videoWidth) return null;
      const width = Math.min(FALLBACK_FRAME_WIDTH, video.videoWidth);
      const height = Math.round((video.videoHeight / video.videoWidth) * width);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.drawImage(video, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);
      return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
    },
  };
}
