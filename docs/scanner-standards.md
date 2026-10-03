# Scanner quality standards

The bar QuickScan's scanner is held to, the metrics that measure it, and the evidence behind every change. Maintained by the `scanner-expert` agent (`.claude/agents/scanner-expert.md`); the benchmark protocol is in `.claude/skills/scanner-bench/SKILL.md`. Numbers in **Targets** are what the best mobile scanners achieve (Apple VisionKit / Notes, Microsoft Lens, Adobe Scan, Genius Scan, Google Drive scan) or what the SmartDoc 2015 / MIDV benchmarks established; numbers in **Current** come only from a committed benchmark run in `bench/results/` — never from memory or estimation.

## Metrics

| Id | Metric | Definition | Unit |
|----|--------|------------|------|
| M1 | Detection rate | Cases with a document where a quad was returned and its Jaccard index with ground truth ≥ 0.9 | % of positive cases |
| M2 | Quad accuracy | Mean Jaccard index (IoU of the two quadrilaterals) over positives, plus mean corner error as % of the frame's long edge | IoU, % |
| M3 | False accept rate | Negatives (no document, or < 10 % of frame) where a quad with confidence above the auto-capture threshold was returned | % of negatives |
| M4 | Temporal stability | Per video clip: median frame-to-frame corner jitter (% long edge) once the document is in view and still, and the number of frames until `isStable` | %, frames |
| M5 | Time to auto-capture | From first in-view frame to auto-capture, at the benchmark's simulated frame cadence | ms |
| M6 | Detection latency | Wall time of `detectDocumentQuadAsync` per frame at the live-preview resolution, p50/p95 | ms |
| M7 | Processing latency | Wall time of warp + filter on a full-resolution capture, p50/p95 | ms |
| M8 | OCR accuracy | Character error rate (CER) and word error rate (WER) of Tesseract output against ground-truth text, per filter and for the raw crop | % |
| M9 | Output size | Bytes of `processedBlob` and of the exported PDF per page, grouped by filter and by page type (text, receipt, photo) | KB |
| M10 | Output legibility | Effective resolution of the warped page (px per mm of the physical document) and sharpness (variance of Laplacian) relative to the raw capture | px/mm, ratio |
| M11 | Orientation | Pages stored upright after OCR auto-orientation, on a corpus of pages captured at 0/90/180/270° | % |
| M12 | Bundle & startup | Bytes shipped for detection and OCR (scanic, tfjs + backends, model, Tesseract core/worker/traineddata) and time to first live detection on a cold load | KB, ms |

All of these are produced by `npm run bench` (see the skill) and written to `bench/results/<date>-<git sha>.json`; the human-readable summary of the latest run is `bench/results/latest.md`.

## Targets

| Metric | Target | Why this number |
|--------|--------|-----------------|
| M1 | ≥ 98 % on the SmartDoc-like subset, ≥ 95 % on hard cases (low contrast, same-colour background, partial occlusion) | SmartDoc 2015 Challenge 1 winners reached a mean Jaccard above 0.98 on simple backgrounds; commercial apps match this |
| M2 | Mean IoU ≥ 0.97; mean corner error ≤ 0.5 % long edge | Below 0.5 % the crop error is invisible after warping to A4 at 200 dpi |
| M3 | ≤ 2 % | A false capture is worse than a late one |
| M4 | Jitter ≤ 0.3 % long edge; stable within 6 frames | Apple/Lens overlays appear locked to the page; visible wobble reads as "broken" |
| M5 | ≤ 1500 ms when steady | Lens/VisionKit capture within about a second of settling |
| M6 | p95 ≤ 60 ms on a mid-range Android, ≤ 30 ms on a recent iPhone, at the preview size used by the worker | Keeps a 10 fps analysis cadence with headroom for rendering and thermal throttling |
| M7 | p95 ≤ 1200 ms for a 12 MP capture on a mid-range Android | Anything longer needs a progress UI |
| M8 | CER ≤ 2 % on clean printed text with the default filter; the best filter for OCR is never more than 1 % worse than the raw crop | Tesseract LSTM reaches ~1 % CER on 300 dpi clean scans; preprocessing must not destroy information |
| M9 | Text page JPEG 150–400 KB at ~2500 px long edge; PDF page within 20 % of the JPEG | Matches Lens/Adobe output sizes; larger wastes storage and sync bandwidth without legibility gain |
| M10 | ≥ 8 px/mm (~200 dpi) for an A4 page from a 12 MP capture; sharpness ratio ≥ 0.8 after warp | 200 dpi is the floor for reliable OCR and crisp print |
| M11 | ≥ 97 % | Users rarely notice the mechanism, always notice a sideways page |
| M12 | Detection code + model ≤ 1.5 MB compressed; first live detection ≤ 2 s on 4G | tfjs with two backends alone can exceed this; measure before adding |

## Current

_No benchmark run committed yet. The first run of `npm run bench` on the baseline corpus fills this table and `bench/results/latest.md`._

| Metric | Current | Run | Gap to target |
|--------|---------|-----|---------------|
| M1–M12 | — | — | — |

## Known facts (verified in code, date in brackets)

- [2026-10-03] `src/lib/ml-detector.ts` loads `/models/corner-detector.json`, but `public/models/` does not exist in the repo. The "hybrid ML+CV" detector therefore always falls back to the classical path in production. Any ML result in a benchmark is a result of the classical path unless a model is shipped.
- [2026-10-03] `scanner.worker.ts` initialises its own `MLCornerDetector` instance, while `detectDocumentQuadAsync` in `scanner.ts` calls `predict` on a separate module-level instance that is never initialised. Every caller also asks for `'classical'`. The ML path is dead twice over, and its confidence is hard-coded to 0.85 when it does run.
- [2026-10-03] `useDocuments.ts` saves the filtered, warped image as both `originalBlob` and `processedBlob`. The raw crop and the corners are discarded, so OCR always runs on the filtered output and a page cannot be re-filtered losslessly.
- [2026-10-03] `pdf.ts` embeds the page image as-is and sizes the PDF page in points equal to the image's pixel size (72 dpi), so a 3000 px scan becomes a ~42-inch page.
- [2026-10-03] Reported by code survey, to re-verify before acting: `warpPerspective` and the filters run full-resolution pixel loops on the main thread with no maximum output size; live frames reach the worker by structured clone rather than transfer; scanic's own ML mode fetches its model from jsDelivr, which the CSP would have to allow; object URLs created during processing are never revoked; `AGENTS.md`/`CLAUDE.md` still name jscanify/OpenCV.js and 1920×1080 constraints.
- [2026-10-03] The only automated checks on detection quality are `tests/visual-crop.test.ts` (one frame of one video: four corners, confidence > 0.3) and `tests/scanner-integration.test.ts` (mocked detector). Neither measures accuracy.
- [2026-10-03] `tests/fixtures/camera/*.MOV` (~100 MB) and `tests/output/frame_IMG_1525.MOV.png` (29 MB) are tracked in git. Fixtures of this size belong behind a download script or Git LFS.

## Decision log

Every merged change to detection, capture, warp, filters, encoding or OCR adds one line: date, PR, what changed, the metric deltas from the benchmark run before and after, and the device measurements if any. A change without a before/after row is reverted.

| Date | PR | Change | Metric deltas | Evidence |
|------|----|--------|---------------|----------|
| — | — | — | — | — |

## Reference practices (what the best do)

Keep this section short and factual; link sources. The agent updates it when it verifies a practice, and removes entries that turn out to be folklore.

- **Capture**: request the highest still resolution the device allows (`width: { ideal: 4096 }`), analyse a downscaled preview (long edge 320–480 px) at a fixed cadence, and capture the still from the full-resolution stream; honour EXIF/`imageOrientation: 'from-image'` on imported photos; torch via `applyConstraints({ advanced: [{ torch: true }] })` where supported.
- **Detection**: classical pipelines (blur → adaptive threshold or Canny → contours → convex quad with area and angle constraints) hit ~0.95 IoU on simple backgrounds and fail on low contrast; deep models (HED-style edge maps or direct corner regression at 256 px) are what pushed SmartDoc results above 0.98 and what VisionKit / Lens rely on. Hysteresis on the confidence, exponential smoothing of corners, and a "steady" requirement on both corner motion and device motion stop false captures.
- **Warp**: output size from the quad's physical aspect (longest edges, perspective-corrected), capped so the long edge stays within the source's effective resolution; bilinear at minimum, with supersampling when downscaling.
- **Enhancement**: shadow removal by dividing by a large-kernel background estimate, then adaptive (Sauvola-style) binarisation for "B&W", and a gentler contrast stretch with mild sharpening for "magic"/colour; never binarise photos or signatures.
- **OCR**: Tesseract LSTM wants ~30 px x-height (≈ 300 dpi for 10 pt type), deskewed, grayscale or binarised without JPEG artefacts; set the page segmentation mode to the layout; recompressing before OCR costs accuracy.
- **Encoding**: JPEG quality 0.82–0.9 with 4:2:0 subsampling for photos and colour pages; for binarised pages JPEG rings around strokes, so prefer PNG/WebP-lossless or a JBIG2/CCITT layer in PDF. Long edge 2000–2600 px for A4.
- **Mobile constraints**: iOS Safari canvas limits (about 16.7 M pixels per canvas), total canvas memory pressure on a 12 MP image, no `ImageCapture.takePhoto()` on Safari, WASM SIMD availability, OffscreenCanvas in workers, thermal throttling after ~30 s of continuous analysis.
