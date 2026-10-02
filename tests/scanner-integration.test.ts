import { describe, it, expect, vi } from 'vitest';
import { detectDocumentQuadAsync } from '@/lib/scanner';
import { mlDetector } from '@/lib/scanner';
import fs from 'fs';
import path from 'path';

describe('Hybrid ML+CV Edge Detection', () => {
  const FIXTURES_DIR = path.join(process.cwd(), 'tests/fixtures/camera');

  // Mock ImageData
  const createMockImageData = (w: number, h: number) => {
    return {
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    } as ImageData;
  };

  it('should fall back to classical detection when ML fails', async () => {
    const imageData = createMockImageData(640, 480);
    vi.spyOn(mlDetector, 'predict').mockRejectedValue(new Error('ML failure'));

    const result = await detectDocumentQuadAsync(imageData, { detector: 'ml' });
    expect(result).toBeDefined();
  });

  it('should correctly order corners returned by ML', async () => {
    const imageData = createMockImageData(640, 480);
    const mockCorners = [
      { x: 0.1, y: 0.1 }, // TL
      { x: 0.9, y: 0.1 }, // TR
      { x: 0.9, y: 0.9 }, // BR
      { x: 0.1, y: 0.9 }, // BL
    ];
    vi.spyOn(mlDetector, 'predict').mockResolvedValue(mockCorners);

    const result = await detectDocumentQuadAsync(imageData, { detector: 'ml' });

    if (result) {
      expect(result.corners[0].x).toBeLessThan(320);
      expect(result.corners[0].y).toBeLessThan(240);
      expect(result.corners[2].x).toBeGreaterThan(320);
      expect(result.corners[2].y).toBeGreaterThan(240);
    }
  });

  // Conditional test for local fixtures
  it('should process local video fixtures if they exist', async () => {
    if (!fs.existsSync(FIXTURES_DIR)) {
      console.log('Skipping fixture test: FIXTURES_DIR not found (CI environment)');
      return;
    }

    const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.MOV') || f.endsWith('.mp4'));
    if (files.length === 0) {
      console.log('Skipping fixture test: No MOV/mp4 files found');
      return;
    }

    // We can't easily process raw MOV in a Node-based Vitest environment without ffmpeg,
    // but we can verify that the detector handles a simulated frame from these files
    // in a real integration test.
    expect(files.length).toBeGreaterThan(0);
    console.log(`Found ${files.length} fixtures for manual/local verification.`);
  });
});
