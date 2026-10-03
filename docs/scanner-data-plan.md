# Scanner data plan: where the evidence comes from

What data QuickScan's scanner is measured against, where it comes from, which of it is worth having, and what the owner still has to film. The metrics and targets live in `docs/scanner-standards.md`; the procedure in `.claude/skills/scanner-bench/SKILL.md`; the corpus itself in `bench/corpus/` (`README.md` there lists licences and provenance). Maintained by the `scan-data-collector` agent.

## Why

Every scanner change is gated on a benchmark run, and a benchmark is only as good as its corpus. Before this plan there was no corpus: eleven iPhone 14 Pro clips from one desk under one lamp, no labels, two of them showing personal documents in a tracked path. The clips are now private (`tests/fixtures/camera/private/`, ignored by version control), and the corpus is built from sources that need no personal data at all, plus the owner's clips as private cases.

Decisions taken (2026-10-03): build corpus v1 including synthetic cases now; move the four tracked clips to the private folder without rewriting history; design the Stage 2 training set now, build it only after the Stage 1 baseline is committed.

## 1. Sources, in priority order

| # | Bucket | Serves | Target size | Label cost | Personal data | Where it lives |
|---|--------|--------|-------------|------------|---------------|----------------|
| C | **Self-generated test pages** — `npm run bench:pages`; text known before printing | M8 (CER/WER per filter, doc type, language), M10 (exact `docMm`), M11 | 22 items: 12 A4 (6 eng, 6 deu), A5, 2 fine print 7 pt, sparse 3-line page, invoice, 4 receipts 80 mm, business card | none | none | generator + seeds committed; PDFs/PNGs regenerable; text GT in `bench/corpus/text/` |
| D | **Synthetic composites** — `npm run bench:synth`; pages from C on backgrounds with a known homography, then shadow, glare, low light, blur, noise, colour cast, JPEG, hand/pen, cut-off edges | M1–M3 per condition, M8, M11 (rotations are free) | 100 positives (every hard value ≥ 20) + 50 negatives | none | none | manifest entries committed; frames and previews regenerated from the seed, not committed |
| A | **Frames from the owner's existing clips** — `node bench/tools/extract-frames.mjs` | M1, M2, M6, M7, M9, M10 (A4 → `docMm [210,297]`), clip records for M4/M5 | 31 stills, 11 clip records | ~30 quads to confirm in `label.html` (proposals from `autolabel.mjs`) | real documents → every case `private: true` | media on the owner's machine only; entries + clip JSON committed |
| F | **Public datasets** — `npm run bench:fetch -- --sample smartdoc|cord|midv` | M1/M2 cross-check against the literature, `id-card`, receipts with text | SmartDoc 60, CORD 20, MIDV 20 | none (converted GT) | specimen docs only | SmartDoc and CORD committed (CC BY 4.0); MIDV fetched locally (specimen portrait), licence + attribution committed |
| B | **Owner shot list** (section 3), HDR Video off | every metric except M12 | ≥ 60 plain positives, 5–10 per hard value per shoot (≥ 20 after a second shoot), ≥ 30 negatives | ~2.5 h with `label.html` | none, if only pages from C are filmed | previews committed; full media behind `fetch-corpus.mjs` or private |
| E | **Negatives** | M3 | ≥ 30 for the baseline, ≥ 60 before Stage 2 | none (`quad: null`) | none | from D backgrounds and rectangle traps now; from B clip lead-ins later |
| G | **Android capture** (Pixel-class phone) | M6/M7 device numbers, the 12 MP `takePhoto` path | 10 clips + 10 photos | 40 min | none | behind `fetch-corpus.mjs` |

### Public datasets: verdicts (licences checked 2026-10-03)

Use:
- **SmartDoc 2015 Challenge 1** — CC BY 4.0. Nexus 7 1080p video of A4 pages on five backgrounds, per-frame quads; the benchmark the roadmap's parity numbers refer to. Frames repack: `github.com/jchazalon/smartdoc15-ch1-dataset` (1 GB); original on Zenodo record 1230217.
- **CORD v2** — CC BY 4.0. Phone photos of receipts with the receipt outline and word-level text; the only cleanly licensed receipt set. HF `naver-clova-ix/cord-v2`, test split.
- **MIDV-500 / 2019 / 2020 / Holo** — CC BY-SA 2.5 (share-alike). The hardest real conditions: low light, hand, clutter, partial, glare and holograms, with per-frame quads that may lie outside the frame. FTP `smartengines.com`. Specimen cards carry a portrait, so frames stay out of the repository.
- **Mendeley "Image Dataset for Document Corner Localization"** — CC BY 4.0, 1,111 phone images; annotation format unverified, candidate for v2.
- **UVDoc** — MIT, 20k rendered warped pages; training augmentation only.
- **SmartDoc Ch.2 / SmartDoc-QA** — CC BY 4.0 phone-captured OCR text GT, but 13–39 GB; only a tiny fetched sample if ever.

Do not commit: SROIE (no organiser licence, registration gate, flatbed scans), WildReceipt (scraped, no licence), DocUNet / DocAligner / RWMD-Extended (no licence), DIR300 (non-commercial), FUNSD (non-commercial, scans), B-MOD and CORU (contradictory licence statements), DocCornerDataset on Hugging Face (mixed and mislabelled sources; rebuild its recipe from the CC sources instead).

## 2. What is worth having, and why in this order

Detection on a fixed frame is deterministic: M1–M3 and M8–M11 have no run-to-run noise, so one case is already a visible step (2–5 % of a condition bucket). Volume matters less than two things: coverage of the **hard conditions** the roadmap names (`background: plain-similar | cluttered | dark`, `lighting: low | harsh-shadow | glare`, `occlusion: hand | object`, `distance: partial`) and **exact ground truth**.

1. **Known text beats transcribed text.** Pages generated from a seed give exact OCR ground truth and exact physical size, the only way M8 and M10 are honest and free of personal data. German pages (umlauts, ß, long compounds, `1.234,56 €`) matter because the owner's documents are German while the default OCR language is English.
2. **Synthetic composites buy breadth immediately** — every hard value at 20 cases, every orientation — at the price of realism. They are reported in their own table (`conditions.device: synthetic`) and never as the headline number.
3. **Real frames anchor realism.** The existing clips give one real device and desk now; the shot list adds the hard conditions on real paper; SmartDoc is the number the Stage 2 parity claim is compared to.
4. **Negatives are cheap and M3 is a Stage 1 row.** 30 now (synthetic), 60 before Stage 2, with real "rectangle traps" from the shot list.
5. **Clips, not stills, for M4/M5.** Four choreographed clips (hold, pan, hand enters, torch toggle) replay the tracker's own constants: 10 consecutive frames within 0.02 deviation (`document-tracker.ts`), 120 ms cadence, 320 px preview, confidence 0.65 held for 600 ms (`CameraView.tsx`).

What the pipeline actually consumes, so the data matches it (verified in code, 2026-10-03): the stream is requested at 3840×2160; live detection runs on a 320 px wide downscale every 120 ms; the iOS still is the sharpest of three video frames at stream size (so an evaluation still *is* a 4K video frame), Android uses `takePhoto` at 12 MP when its aspect matches; the warp has no output cap; OCR runs on the filtered `processedBlob` fitted to 2500 px; the dormant ML detector expects 256×256 grayscale and returns 8 normalised coordinates.

Facts about the existing clips that changed how to film: all eleven are HEVC 10-bit HLG "HDR Video" with a 90° (two: 180°) rotation tag. A browser camera stream is 8-bit SDR, so HLG frames look flat unless tone-mapped; the extractor applies an SDR approximation and records `capture.hdr: true`. New clips must be shot with **HDR Video off**.

## 3. Shot list for the owner (30 clips + 3 photo sets)

**How to film.** iPhone Camera app, 4K at 30 fps, Settings → Camera → Record Video → **HDR Video OFF**, phone in portrait, exposure and focus on auto. Each clip 6–8 s: one second off the document (this yields a negative and the `inViewAt` marker), bring it into view, hold still for at least 3 s. Film **only the printed pages from `npm run bench:pages`** (print the PDFs in `bench/pages/` at 600 dpi on a laser printer; receipts at ~60 % grey, cut to 80 mm, curled around a pen; the card on card stock), so every frame has exact text and size without a ruler. Keep a shot log: row number → IMG number, saved as `bench/corpus/clips/shotlog.json` (`{"IMG_1601": {"row": 14, "doc": "e-a4-deu-serif11", "docMm": [210, 297], "inViewAt": 1.0, "conditions": {...}}}`), which `extract-frames.mjs` reads.

Backgrounds: **PC** plain-contrast (dark mat or cloth), **PS** plain-similar (white table or an A3 sheet under the page), **CL** cluttered (keyboard, cables, pens, other papers), **TX** textured (the pine desk), **DK** dark table. Lighting: **EV** even daylight, **LO** one dim lamp, **HS** lamp low from one side with the phone's shadow crossing the page, **GL** glare on glossy paper, **MX** warm lamp plus cool monitor or daylight.

### Session 1 — daylight (EV)

| # | Document | Bg | Motion | Stills (conditions) | Negative? |
|---|----------|----|--------|---------------------|-----------|
| 1 | A4 eng (`e-a4-eng-serif11`) | PC | off → far (<10 %) → far (~15 %) → normal → fills; hold at normal | 4: far-negative, far, normal, fills | first two |
| 2 | A4 deu (`e-a4-deu-serif11`) | PS | mild skew, hold; tilt to strong skew, hold | 2: skew mild, strong (hard: plain-similar) | |
| 3 | invoice (`e-a4-deu-invoice`) | CL | hold; lay a pen across one corner, hold | 2: clean; occlusion object (hard: cluttered) | |
| 4 | receipt (`e-receipt-1`, curled) | TX | normal → fills, hold | 2; `docMm [80, measured]` | |
| 5 | card (`e-card`) | PS | fills → normal → far | 3: fills, normal, far (<10 % → negative) | last |
| 6 | open paperback (`book-curved`) | PC | fills, mild skew; one spread, one single page | 2 | |
| 7 | glossy photo print | TX → GL | hold; move until the window reflects on the print | 2: none, glare (hard) | |
| 8 | A5 (`e-a5-eng-serif10`) + cup beside | CL | 45° camera angle (extreme skew) → recover to mild | 2 | |
| 9 | none | CL | 8 s slow pan over keyboard, monitor, paper stack edge | 4 | all |
| 10 | none | — | window frame, door, laptop screen off, tiled floor | 4 | all |
| 11 | A4 eng over a second A4, overlapping | PS | hold | 2 (notes: two pages; hard) | |
| 12 | handwritten pangram page (no name, no signature) | TX | hand holding one corner → hand out | 2: occlusion hand, none | |
| 13 | whiteboard | — | fills, strong skew, standing off-axis | 2 | |
| 14 | **M4/M5-A** A4 deu | PC | off 2 s → in view → hold 4 s → pan left/right 2 s → hold 3 s | clip record, 3 keyframe quads | |
| 15 | **M4/M5-B** A4 eng | CL | as 14, a hand enters during the last hold | clip record | |
| 16 | **M4/M5-C** receipt | PS | hold 4 s → lift the phone slowly away → hold | clip record + 2 stills | |
| 17 | A4 eng | TX | fast side-to-side swipes with short stops | 2: blur motion, 1 sharp | |
| 18 | A4 deu | PC | start 5 cm away (out of focus, partial) → pull back | 3: focus blur + partial, partial, normal | |
| 19 | invoice | TX | too close: cut on two sides → one side → fits | 3: partial ×2, fills (hard) | |

### Session 2 — evening, one warm desk lamp

| # | Document | Bg | Light | Motion | Stills | Negative? |
|---|----------|----|-------|--------|--------|-----------|
| 20 | A4 eng | DK | LO | hold 3 s, torch on, hold 3 s | 2: low, low + torch (hard: dark, low) | |
| 21 | A4 deu | TX | HS | your shadow crossing the page | 2: shadow on page, off page (hard) | |
| 22 | receipt + pen beside | PC | LO | normal → fills | 2 (hard: low; object) | |
| 23 | invoice | PS | MX | lamp one side, monitor the other | 2 | |
| 24 | glossy card | DK | LO + torch | torch reflection on the card | 2: glare, none (hard: dark, glare) | |
| 25 | open paperback | TX | HS | hold | 2 | |
| 26 | sparse page (`e-a4-deu-sparse`) | PC | LO | hold upright | 1 | |
| 27 | none | DK | LO | empty dark table, lamp, dark shelf | 4 | all |
| 28 | A4 eng | CL | LO | hand flattening the page along one edge, strong skew | 2 (hard: cluttered, hand, low) | |
| 29 | **M4/M5-D** A4 deu | DK | LO | hold 4 s, toggle the torch, hold 3 s | clip record | |
| 30 | glossy photo | PS | HS + GL | lamp reflection | 2 (hard) | |

One shoot yields about 90 positives and 25 negatives with each hard value at 5–10. Extract one extra still per second of each steady segment (correlated frames; say so in `notes`) to reach ~150, and plan a second shoot in a different room to reach ≥ 20 per hard value once the baseline shows where failures cluster.

### Photo sets (Camera app stills, HEIC, 12 MP)

- **O — orientation (M11, import path):** 5 documents (A4 deu dense, invoice, sparse page, receipt, card) × 0/90/180/270° on PC under EV = 20 photos. Each gets a quad; the page is warped before OCR. Also exercises the EXIF handling in `import.ts`.
- **P — 12 MP captures (M7/M9/M10):** one photo of each of the 22 printed items, EV, normal distance. These are the "12 MP capture" the roadmap's M7 and M10 rows mean.
- **BG — backgrounds for synthesis and negatives:** PC/PS/CL/TX/DK × EV/LO plus carpet and tiles = 12 photos with no document. They replace the procedural textures in `bench/backgrounds/`.

## 4. Training data for the Stage 2 corner model (design only; build after the Stage 1 baseline is committed)

- **Volume.** Realistically ≥ 2,000 real labelled frames with diverse backgrounds plus 30–50k synthetic, then fine-tune on the real frames. Below about 1,000 real frames the model will not beat the classical path on `cluttered` and `plain-similar`, and the evaluation corpus will show that honestly.
- **Sources.** (1) `synth.mjs --train` (to be added): pages from a *second* seed (`--set train`, ids `t-…`, text kept beside the PNGs and never in `bench/corpus/text/`) onto backgrounds not used for evaluation, random homography (tilt ≤ 60°, scale 0.15–0.95 of the frame, rotation 0–360°), edge-partial crops and 10 % negatives, output 256×256 grayscale plus 8 normalised coordinates as `ml-detector.ts` expects. (2) ArUco mat auto-labelling: an A3 mat with four markers and a printed page outline; the homography from the markers gives the corners in every frame without hand labelling, markers are inpainted before training. This adds motion, lighting and blur diversity, not background diversity. (3) A few hundred hand-labelled frames from a second-room shoot via `label.html`. (4) SmartDoc 2015 training split, MIDV-500, UVDoc, using the official splits.
- **Non-overlap, enforced rather than hoped.** Disjoint page seeds (set E for evaluation, set T for training), disjoint backgrounds, rooms and sessions, disjoint public splits, training data outside `bench/corpus/` (ignored folder `bench/train/`), and a perceptual-hash (dHash) check of every training frame against every evaluation frame that fails above a similarity threshold. The manifest's `split` field is always `eval`; the validator rejects anything else.

## 5. Storage rules

- **Committed** (`bench/`): `corpus/manifest.json`, `corpus/text/*.txt`, `corpus/clips/*.json`, SmartDoc and CORD frames and previews (≤ 5 MB each, no personal data), MIDV licence and attribution files, `backgrounds/` (small), `fonts/` (Liberation, SIL OFL 1.1), the tools, and one synthetic frame as the fixture of `tests/visual-crop.test.ts`.
- **Regenerated locally, not committed:** synthetic frames and previews (`npm run bench:synth`, deterministic), printed-page PDFs and PNGs (`npm run bench:pages`), MIDV frames (`npm run bench:fetch -- --sample midv`).
- **Private, never committed:** everything under `tests/fixtures/camera/private/`, the extracted stills under `bench/corpus/frames/private/` and their review overlays. Manifest entries for these carry `private: true`; CI skips them.
- **Behind `fetch-corpus.mjs`:** media too large for the repository that is not private (future shot-list clips as a release asset, with `remote: { url, sha256, path }` in the manifest).

## 6. Status (2026-10-03, corpus v1)

| Bucket | Cases | State |
|--------|-------|-------|
| C pages | 22 items, 23 kchars of ground truth | generated, seed 1 |
| D synthetic | 100 positives + 50 negatives | generated, seed 1; every hard value ≥ 20 |
| A own clips | 31 private stills, 11 clip records | extracted; corner **proposals** from `autolabel.mjs`, to be confirmed in `label.html` (three flagged frame-sized, one trifold letter needs the full sheet, clip 1518 shows a medicine box and needs a decision) |
| F datasets | SmartDoc 60, CORD 20, MIDV 20 | sampled, deterministic; MIDV media local only |
| B shot list | 0 | **owner's turn**: print `bench/pages/*.pdf`, film sections 3, run `extract-frames.mjs --src <folder> --public` with a shot log, label, add previews |
| G Android | 0 | needs a device |

Next step after this corpus: the benchmark harness itself (`bench/tools/run.mjs`, `metrics.mjs`; `scanner-expert`), then the first baseline run that fills the **Current** table in `docs/scanner-standards.md`.
