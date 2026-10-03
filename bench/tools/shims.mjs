// Minimal browser shims so app code and scanic run under Node for the benchmark.
// Keep this file small: a shim is never a reason to change app code. Every shim
// installed here is listed in `installedShims` so a run can record it in its
// `environment` field.

import { createCanvas, ImageData as CanvasImageData, Image } from 'canvas';

export const installedShims = [];

export function installShims() {
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
      createElement(tag) {
        if (tag !== 'canvas') throw new Error(`document.createElement(${tag}) is not shimmed`);
        return createCanvas(1, 1);
      },
    };
    installedShims.push('document.createElement("canvas") → node-canvas');
  }
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = CanvasImageData;
    installedShims.push('ImageData → node-canvas ImageData');
  }
  if (typeof globalThis.Image === 'undefined') {
    globalThis.Image = Image;
    installedShims.push('Image → node-canvas Image');
  }
  if (typeof globalThis.OffscreenCanvas === 'undefined') {
    globalThis.OffscreenCanvas = class OffscreenCanvas {
      constructor(w, h) { return createCanvas(w, h); }
    };
    installedShims.push('OffscreenCanvas → node-canvas');
  }
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
    installedShims.push('window → globalThis');
  }
  return installedShims;
}
