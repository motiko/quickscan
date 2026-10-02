import type { ImageFilter } from '@/types';

export function applyFilter(
  sourceBlob: Blob,
  filter: ImageFilter,
  quality = 0.92
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0);

      if (filter === 'original') {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Failed'))),
          'image/jpeg',
          quality
        );
        return;
      }

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

        if (filter === 'grayscale') {
          data[i] = gray;
          data[i + 1] = gray;
          data[i + 2] = gray;
        } else if (filter === 'bw') {
          const bw = gray > 128 ? 255 : 0;
          data[i] = bw;
          data[i + 1] = bw;
          data[i + 2] = bw;
        }
      }

      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(sourceBlob);
  });
}

export function cropImage(
  sourceBlob: Blob,
  cropRect: { x: number; y: number; width: number; height: number },
  quality = 0.92
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = cropRect.width;
      canvas.height = cropRect.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.drawImage(
        img,
        cropRect.x,
        cropRect.y,
        cropRect.width,
        cropRect.height,
        0,
        0,
        cropRect.width,
        cropRect.height
      );

      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(sourceBlob);
  });
}

export function createThumbnail(
  sourceBlob: Blob,
  maxSize = 200,
  quality = 0.7
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(sourceBlob);
  });
}

export function blobToObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}
