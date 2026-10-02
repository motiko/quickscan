export async function generatePdf(imageBlobs: Blob[]): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();

  for (const blob of imageBlobs) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let image;

    // Try JPEG first, fall back to PNG
    try {
      image = await pdfDoc.embedJpg(bytes);
    } catch {
      image = await pdfDoc.embedPng(bytes);
    }

    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function shareOrDownload(
  blob: Blob,
  filename: string,
  title?: string
): Promise<void> {
  // Try native share first (mobile)
  if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      const shareData = { title: title || filename, files: [file] };

      if (navigator.canShare(shareData)) {
        await navigator.share(shareData);
        return;
      }
    } catch (err) {
      // User cancelled or share failed, fall through to download
      if ((err as Error).name === 'AbortError') return;
      console.warn('Share API error, falling back to download:', err);
    }
  }

  // Fall back to download
  downloadBlob(blob, filename);
}

export async function shareImage(
  imageBlob: Blob,
  filename: string,
  title?: string
): Promise<void> {
  return shareOrDownload(imageBlob, filename, title);
}
