import * as tf from '@tensorflow/tfjs';

export interface Corner {
  x: number;
  y: number;
}

export class MLCornerDetector {
  private model: tf.GraphModel | null = null;
  private readonly modelUrl = '/models/corner-detector.json';
  private readonly inputSize = 256;

  async init() {
    if (this.model) return;

    try {
      // Try WebGPU first, then WASM
      await tf.setBackend('webgpu').catch(async () => {
        await tf.setBackend('wasm');
      });

      await tf.ready();
      this.model = await tf.loadGraphModel(this.modelUrl);
    } catch (error) {
      console.error('Failed to initialize MLCornerDetector:', error);
      throw error;
    }
  }

  async predict(imageData: ImageData): Promise<Corner[]> {
    if (!this.model) {
      throw new Error('MLCornerDetector not initialized');
    }

    return tf.tidy(() => {
      // 1. Convert ImageData to tensor and downsample to 256x256
      const tensor = tf.browser.fromPixels(imageData, 1) // grayscale
        .resizeBilinear([this.inputSize, this.inputSize])
        .expandDims(0)
        .div(255.0);

      // 2. Inference
      const prediction = this.model!.predict(tensor) as tf.Tensor;
      const coords = prediction.dataSync(); // [x1, y1, x2, y2, x3, y3, x4, y4]

      // 3. Normalize coordinates back to 0..1 range
      const corners: Corner[] = [];
      for (let i = 0; i < 8; i += 2) {
        corners.push({
          x: coords[i],
          y: coords[i + 1]
        });
      }

      return corners;
    });
  }
}
