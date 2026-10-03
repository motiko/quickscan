# Scanner quality standards

The bar QuickScan's scanner is held to, the metrics that measure it, and the evidence behind every change. Maintained by the `scanner-expert` agent (`.claude/agents/scanner-expert.md`); the benchmark protocol is in `.claude/skills/scanner-bench/SKILL.md`. The **Roadmap** sets the goals in three stages: the first is reachable with the classical pipeline, the second is parity with the best mobile scanners (Apple VisionKit / Notes, Microsoft Lens, Adobe Scan, Genius Scan, Google Drive scan) and with the SmartDoc 2015 / MIDV benchmark results, the third names the honest ceilings of a browser-only app. Numbers in **Current** come only from a committed benchmark run in `bench/results/` — never from memory or estimation.

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

## Roadmap

Three stages, each a gate: work on the next stage starts only when a committed benchmark run on the full corpus clears every row of the current one. "Hard cases" are the corpus conditions `background: plain-similar | cluttered | dark`, `lighting: low | harsh-shadow | glare`, `occlusion: hand | object` and `distance: partial`; everything else is "plain". Device columns mean a recent iPhone (iPhone 15 class) and a mid-range Android from the last three years (Pixel 7a class); older devices must degrade gracefully, not meet the numbers. The stages are uncalibrated until the first baseline run: a Stage 1 row the current pipeline already clears is raised, a row it misses by more than half is split.

### Stage 1 — no bad scans (classical pipeline, fix the structural defects)

| Metric | Goal | Why this number |
|--------|------|-----------------|
| M1 | ≥ 92 % plain, ≥ 75 % hard | Where tuned contour pipelines plateau; low contrast and clutter need a model |
| M2 | Mean IoU ≥ 0.95; corner error ≤ 1.0 % long edge | A 1 % error is a 3 mm sliver on A4, visible but not a lost margin |
| M3 | ≤ 5 % | Halves what a hard-coded confidence lets through today |
| M4 | Jitter ≤ 0.5 % long edge; stable within 10 frames | The tracker's current stability rule, made to actually hold |
| M5 | ≤ 2000 ms when steady | 10 frames at 120 ms plus the 600 ms dwell, with no wasted frames |
| M6 | p95 ≤ 80 ms iPhone, ≤ 150 ms Android, at the 320 px preview | Keeps the 8 fps cadence without dropped frames |
| M7 | p95 ≤ 2500 ms for a 12 MP capture, and off the main thread | A frozen UI is the current failure; the worker makes it a progress state |
| M8 | CER ≤ 5 % on clean print with the default filter; no filter worse than the raw crop by more than 2 % | Requires keeping the raw crop and measuring every filter against it |
| M9 | A4 text page ≤ 600 KB; PDF page sized at 200 dpi, not pixel size | Stops the 42-inch PDF page and the oversized JPEGs |
| M10 | ≥ 6 px/mm (~150 dpi) for A4 from a 12 MP capture | The warp must not throw away resolution it has |
| M11 | ≥ 90 % | The current orientation retry, measured for the first time |
| M12 | No increase over the baseline bundle | Nothing is added until it is measured |

### Stage 2 — parity on everyday documents (small on-device corner model)

| Metric | Goal | Why this number |
|--------|------|-----------------|
| M1 | ≥ 97 % plain, ≥ 92 % hard | SmartDoc 2015 Challenge 1 winners reached a mean Jaccard above 0.98 on simple backgrounds; commercial apps match this |
| M2 | Mean IoU ≥ 0.97; corner error ≤ 0.5 % long edge | Below 0.5 % the crop error is invisible after warping to A4 at 200 dpi |
| M3 | ≤ 2 % | A false capture is worse than a late one |
| M4 | Jitter ≤ 0.3 % long edge; stable within 6 frames | Apple/Lens overlays appear locked to the page; visible wobble reads as "broken" |
| M5 | ≤ 1500 ms when steady | Lens/VisionKit capture within about a second of settling |
| M6 | p95 ≤ 40 ms iPhone, ≤ 80 ms Android | Headroom for rendering and thermal throttling at 10 fps |
| M7 | p95 ≤ 1200 ms for a 12 MP capture on Android | Anything longer needs a progress UI |
| M8 | CER ≤ 2.5 % clean print, ≤ 8 % receipts, with the default filter; best filter never more than 1 % worse than the raw crop | Tesseract LSTM reaches ~1 % CER on 300 dpi clean scans; receipts are thermal print on curled paper |
| M9 | Text page JPEG 150–400 KB at ~2500 px long edge; PDF page within 20 % of the JPEG | Matches Lens/Adobe output sizes; larger wastes storage and sync bandwidth without legibility gain |
| M10 | ≥ 8 px/mm (~200 dpi) for A4 from a 12 MP capture; sharpness ratio ≥ 0.8 after warp | 200 dpi is the floor for reliable OCR and crisp print |
| M11 | ≥ 97 % | Users rarely notice the mechanism, always notice a sideways page |
| M12 | Detection code + model ≤ 1.5 MB compressed; first live detection ≤ 2 s on 4G | tfjs with two backends alone can exceed this; one backend, one small model |

### Stage 3 — ceilings for a browser-only app

Native scanners read RAW frames, fuse HDR exposures and use the platform OCR engine; a PWA gets a JPEG from a video track and Tesseract. These are the honest limits, and the point where cloud OCR (opt-in) takes over rather than more local work:

| Area | Goal | Boundary |
|------|------|----------|
| Print OCR | CER ≤ 1.5 % on clean print | Tesseract's practical floor on phone captures; VisionKit's ~0.5 % is not reachable locally |
| Curved pages | IoU ≥ 0.90 on `book-curved` with simple dewarping | Full dewarping models are too large for the M12 budget |
| Handwriting | No local target; route to cloud OCR | Tesseract has no usable handwriting model |
| Low light | M1 ≥ 85 % on `lighting: low` | No exposure fusion without RAW access; torch guidance is the lever |
| Live cadence | 10 fps analysis, not 30 | Thermal throttling and battery on sustained preview |

## Current

_No benchmark run committed yet. The first run of `npm run bench` on the baseline corpus fills this table and `bench/results/latest.md`._

| Metric | Current | Run | Stage 1 gap | Stage 2 gap |
|--------|---------|-----|-------------|-------------|
| M1–M12 | — | — | — | — |

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
