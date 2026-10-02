// Polyfill minimal OffscreenCanvas for Vitest Node environment
if (typeof globalThis.OffscreenCanvas === 'undefined') {
  class MockOffscreenCanvas {
    width: number;
    height: number;
    data: Uint8ClampedArray;

    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }

    getContext() {
      return {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'medium' as const,
        putImageData: (imgData: ImageData) => {
          this.data.set(imgData.data);
        },
        drawImage: (src: { data?: Uint8ClampedArray }) => {
          if (src?.data) {
            for (let i = 0; i < Math.min(this.data.length, src.data.length); i++) {
              this.data[i] = src.data[i];
            }
          }
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          return { width: w, height: h, data: this.data } as ImageData;
        },
      };
    }
  }

  (globalThis as unknown as { OffscreenCanvas: typeof MockOffscreenCanvas }).OffscreenCanvas =
    MockOffscreenCanvas;
}
