---
name: scanner-bench
description: QuickScan's scanner benchmark protocol — corpus layout and manifest schema under bench/, the metrics (detection IoU, corner error, false accepts, jitter, latency, OCR CER/WER, output size, bundle size), how to run `npm run bench` headless in Node, how to compare a change against the baseline and record the result in docs/scanner-standards.md. Use before changing anything in src/lib/scanner*, ml-detector, document-tracker, frame-analyzer, camera, image-processing, ocr*, import or pdf, and when asked whether the scanner got better or worse.
---

# Scanner benchmark (QuickScan)

Evidence beats opinion. No change to detection, capture, warp, filters, encoding, OCR or export is merged without a before/after run of this benchmark on the same corpus, with the results committed. The targets and the ledger live in `docs/scanner-standards.md`; this skill is the procedure.

## Layout

```
bench/
  corpus/
    manifest.json          # every case (schema below), sorted by id
    frames/<id>.jpg|png    # committed stills (≤ 5 MB each, no PII); frames/private/ is gitignored
    previews/<id>.png      # committed 320 px wide previews of every non-private case (what live detection sees)
    text/<id>.txt          # OCR ground truth, UTF-8, reading order
    clips/<id>.json        # per-clip frame list + per-frame quads, for M4/M5
    remote/                # gitignored: media fetched by fetch-corpus.mjs
    README.md              # licences, provenance, what is private, how to regenerate
  pages/                   # printable test pages (bench:pages); PDFs/PNGs regenerable, gitignored
  backgrounds/             # photographed / procedural backgrounds for synth.mjs (committed, small)
  results/
    <YYYY-MM-DD>-<sha7>.json   # one run; never edited after commit
    latest.md                  # human summary of the newest run
  tools/
    run.mjs                # node bench/tools/run.mjs [--filter <glob>] [--only M1,M8] [--compare <results.json>] [--ci]
    metrics.mjs            # pure functions: quadIoU, cornerError, cer, wer, laplacianVariance …
    validate-manifest.mjs  # schema v2, sorted ids, media present, quads in range, licences
    fetch-corpus.mjs       # downloads `remote` media and samples public datasets (SmartDoc, CORD, MIDV)
    label.html             # click-four-corners labeller, exports manifest entries
    pages.mjs              # seeded printable test pages with exact OCR ground truth (bucket C)
    synth.mjs              # seeded synthetic compositor: pages × backgrounds × homography × degradations (bucket D)
    extract-frames.mjs     # ffmpeg stills + clip records from the owner's MOVs (HLG tone-mapped, auto-rotated)
    autolabel.mjs          # quad proposals + overlays for private frames; proposals until confirmed in label.html
```

`npm run bench` runs `node bench/tools/run.mjs`; add the script to `package.json` when creating the harness. The harness runs in **Node**, like Vitest does in this repo (no jsdom): decode with the `canvas` package (already a dependency), import app code through the same `@/` alias `vitest.config.mts` uses, and call `detectDocumentQuadAsync`, `warpPerspective`/`applyFilter` and the Tesseract worker directly. Where a function needs a browser-only API (`OffscreenCanvas`, `createImageBitmap`, `URL.createObjectURL`), add the smallest shim in `bench/tools/shims.mjs` and record it in the run's `environment` field. A shim is never a reason to change app code. ffmpeg is required for clips; fail with a clear message when it is missing.

## Manifest schema

Version 2. Entries are sorted by `id`; the corpus itself is described in `docs/scanner-data-plan.md` and `bench/corpus/README.md`.

```jsonc
{
  "version": 2,
  "cases": [{
    "id": "smartdoc-bg01-0007",              // stable, never renamed
    "file": "frames/smartdoc-bg01-0007.jpg", // committed still (≤ 5 MB), or
    "remote": { "url": "…", "sha256": "…", "path": "remote/smartdoc/…" }, // fetched by fetch-corpus.mjs, gitignored, or
    "private": true,                         // read from tests/fixtures/camera/private (gitignored, skipped on CI)
    "preview": "previews/smartdoc-bg01-0007.png", // committed 320 px wide PNG; detection sees nothing larger, so CI covers M1–M6 from previews alone
    "width": 1920, "height": 1080,           // of `file`/`remote`/private media, after EXIF/rotation metadata is applied
    "quad": [[0.21,0.18],[0.79,0.17],[0.81,0.84],[0.19,0.86]], // TL,TR,BR,BL normalised 0..1; null = negative
    "text": "text/smartdoc-bg01-0007.txt",   // optional OCR ground truth
    "docMm": [210, 297],                     // physical size when known, for M10
    "split": "eval",                         // always "eval" here; training data lives outside bench/corpus (bench/train/, gitignored)
    "capture": { "kind": "video-frame | photo | synthetic | dataset", "codec": "hevc", "hdr": true, "t": 1.5 }, // provenance; `hdr` true = HLG source tone-mapped at extraction
    "label": { "method": "synthetic | dataset | manual | auto-refined", "verified": true }, // auto-refined quads are proposals until a human confirms them in label.html; never commit an unverified case
    "conditions": {
      "doc": "a4-text | a5-text | receipt | business-card | id-card | book-curved | whiteboard | photo | handwritten | invoice | none",
      "background": "plain-contrast | plain-similar | cluttered | textured | dark",
      "lighting": "even | low | harsh-shadow | glare | mixed-colour",
      "skew": "none | mild | strong | extreme",
      "distance": "fills | normal | far | partial",
      "blur": "none | mild | motion | focus",
      "occlusion": "none | hand | object",
      "device": "iphone-14-pro | iphone-15 | pixel-7a | synthetic | dataset:<name>",
      "orientation": 0                        // 0 | 90 | 180 | 270, how far the page content is turned from upright
    },
    "source": { "name": "SmartDoc 2015", "url": "…", "licence": "CC BY 4.0", "citation": "…" },
    "notes": ""
  }]
}
```

Exactly one of `file` or `remote` names the full-resolution media. `private: true` marks a `file` that is ignored by version control (read from the owner's machine, skipped on CI). `generated: true` marks media a tool recreates deterministically and that is therefore not committed: synthetic cases (`npm run bench:synth`) and dataset samples that may not be redistributed in the repository, such as the MIDV frames with specimen portraits (`npm run bench:fetch -- --sample midv`). `preview` is required for every non-private case. `conditions.device` for synthetic cases is `synthetic`, for public data `dataset:<name>`. A case from a share-alike source (MIDV, CC BY-SA 2.5) lives in a folder that carries the licence text and the attribution file next to the images.

Clips (`clips/<id>.json`) list frames with timestamps and quads so M4 (jitter, frames to stable) and M5 (time to auto-capture) can replay the tracker and auto-capture rules exactly as `CameraView.tsx` and `document-tracker.ts` apply them, at the live cadence (120 ms) and preview width (320 px). Read those constants from the source; do not copy them into the harness.

## Metrics (what `run.mjs` computes)

Definitions and targets: `docs/scanner-standards.md`, M1–M12. Implementation rules:

- **Quad IoU** by polygon clipping (Sutherland–Hodgman) in pixel space. Corner error = mean distance between matched corners after `orderCorners`, divided by `max(width, height)`.
- **Detection** counts a hit at IoU ≥ 0.9. Report hits per condition value, not only overall; the per-condition table is where regressions hide.
- **False accepts** use the production auto-capture threshold imported from the app, never a copy.
- **OCR**: run Tesseract on the raw warped crop and on every filter. Normalise both sides (NFC, collapse whitespace, trim; keep case and punctuation) before Levenshtein. Report CER and WER per filter and per `doc` type. Use the same traineddata source as the app.
- **Latency**: `performance.now()` around the call, one warm-up then ≥ 5 repetitions, p50/p95. Node timings are not phone timings: label them `node-<cpu>` and use them only to rank variants. Device numbers come from the device protocol below.
- **Output size and legibility**: bytes of each encoded blob; px/mm from the warped size and `docMm`; sharpness as variance of Laplacian on the warped grayscale divided by the same measure on the source region.
- **Bundle (M12)**: after `npm run build`, sum the compressed sizes of the chunks that import scanic, tfjs, the model and Tesseract; skip with a note when there is no build.

Every run writes `{ date, sha, branch, dirty, environment, corpusHash, metrics, perCase, devices }`. `--compare <file>` prints a delta table and exits non-zero when any roadmap metric worsens beyond its noise band. Define the band per metric in `metrics.mjs` from three repeated baseline runs.

## The loop

1. **Baseline**: on `main`, `npm run bench` → `bench/results/<date>-<sha>.json`; refresh `latest.md` and the **Current** table in `docs/scanner-standards.md`.
2. **Hypothesis**: name the metric you expect to move, by how much, and why, in one line in the PR body. If no metric fits, the corpus lacks a case: add it first (spawn `scan-data-collector`).
3. **Change** the app code; run `--compare` against the baseline file.
4. **Verify on devices** when the change touches latency, memory or camera behaviour (below).
5. **Record**: commit the results file, update `latest.md`, add the decision-log row in the standards doc with the deltas, and put the per-condition table in the PR body.
6. **Guard**: a metric that moved without being predicted gets explained or the change is reverted.

A regression on any roadmap metric blocks the merge unless the decision log says why the trade is worth it.

## Device protocol

- **iOS**: `npm run sim` for behaviour. For timings use a physical iPhone over Safari Web Inspector and the `scanner:*` `performance.mark`/`measure` pairs in `scanner.worker.ts`, `image-processing.ts` and `ocr-queue.ts` (add them if missing; marks cost nothing in production).
- **Android**: Chrome remote debugging, Performance panel. With no device, 4× CPU throttling on desktop Chromium is the "mid-range" proxy; say so.
- **Automated proxy**: Playwright project "iPhone Camera (Chromium)" with `--use-file-for-fake-video-capture=<clip>.y4m` (recipe in `e2e/fixtures/README.md`) drives the real UI with a benchmark clip; read the marks with `performance.getEntriesByType('measure')`. WebKit cannot fake a camera, so test WebKit memory and canvas limits through imported images.
- Record device measurements in the run's `devices` array with model and OS; never merge them into the Node metrics.

## CI

`run.mjs --ci` runs the committed, non-private, non-remote subset and fails on regression against the newest results file from `main`. Add the job to `.github/workflows/ci.yml` (install ffmpeg), triggered by changes to the files named in this skill's description, and keep it under about three minutes. The full corpus runs locally.
