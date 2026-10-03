# Scanner benchmark corpus

The cases the scanner benchmark (`npm run bench`, see `.claude/skills/scanner-bench/SKILL.md`) runs against: stills
with a ground-truth document outline, OCR text where the source has it, and the capture conditions of each frame.
`manifest.json` (schema version 2) lists every case, sorted by id. Each case is one of

- **committed** — `file` points at `frames/<id>.jpg` (≤ 5 MB, no personal data) and `preview` at the 320 px
  `previews/<id>.png` that live detection actually sees;
- **remote** — `remote: { url, sha256, path }`; the media is too large or not ours to commit and is downloaded into
  the gitignored `remote/` by `node bench/tools/fetch-corpus.mjs`;
- **private** — `private: true`; the frame is read from `tests/fixtures/camera/private/` (gitignored) and skipped
  on CI. The owner's own documents, receipts and ID cards stay there because they carry names, addresses and
  account numbers that must never enter git. Everything committed here is either a public dataset sample or
  synthetic.

## What is in it

| Prefix | Source | Cases | What | Licence |
|--------|--------|-------|------|---------|
| `smartdoc-` | [SmartDoc 2015, Challenge 1](https://github.com/jchazalon/smartdoc15-ch1-dataset) (frames repack v2.0.0) | 60 | Nexus 7 preview frames (1920×1080) of A4 pages on five backgrounds; two frames per background × document type, taken from the middle 60 % of a clip | CC BY 4.0 |
| `cord-test-` | [CORD v2](https://huggingface.co/datasets/naver-clova-ix/cord-v2), test split | 20 | Receipt photos with the receipt outline (`roi`) and word-level OCR text; personal data is blurred by the dataset itself | CC BY 4.0 |
| `midv-` | [MIDV-500](ftp://smartengines.com/midv-500/) | 20 | 1080×1920 video frames of one printed specimen ID document (chosen by seed; `31_jpn_drvlic` for seed 1) across the table, keyboard, hand, partial and clutter conditions on two phones; **media fetched locally, not committed** (specimen portrait, see below) | CC BY-SA 2.5 |

The public datasets were sampled, not copied: tens of frames per condition keep a full run in minutes. All three
are `split: "eval"`; training data lives outside this folder (`bench/train/`, gitignored).

### Licences and attribution

| Source | Licence | Attribution | Notes |
|--------|---------|-------------|-------|
| SmartDoc 2015 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Burie et al., "ICDAR2015 Competition on Smartphone Document Capture and OCR (SmartDoc)", ICDAR 2015 | Citation in every case's `source` |
| CORD v2 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Park et al., "CORD: A Consolidated Receipt Dataset for Post-OCR Parsing", Document Intelligence Workshop at NeurIPS 2019 | Citation in every case's `source` |
| MIDV-500 | [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/) | Arlazarov, Bulatov, Chernov, Arlazarov, "MIDV-500: A Dataset for Identity Documents Analysis and Recognition on Mobile Devices in Video Stream", Computer Optics 43(5), 2019 | **Share-alike.** The frames are recreated locally into their own folders, `frames/midv/` and `previews/midv/`, next to the committed licence text (`frames/midv/LICENSE-CC-BY-SA-2.5.txt`) and `frames/midv/ATTRIBUTION.md`, which names the Wikimedia Commons specimen each sampled document type was printed from. Anything derived from these images (overlays, crops, augmented copies) must be shared under the same licence; keep such derivatives inside those folders or out of the repository. |

The specimen documents in MIDV-500 are public, fictitious samples from Wikimedia Commons (the sampled Japanese
licence carries a specimen portrait and invented data), not real identity documents.

## Conditions

`conditions` follows the taxonomy in the skill. Public datasets do not annotate most of it, so the samplers fill it
from what the dataset does provide and say so in each case's `notes` ("guessed from dataset metadata"):

- `skew`, `distance` and `orientation` are computed from the ground-truth quad: skew from how unequal opposite
  sides are (`none` < 5 %, `mild` < 20 %, `strong` < 40 %, else `extreme`), distance from the share of the frame
  the document covers (`fills` ≥ 60 %, `normal` ≥ 20 %, else `far`; `partial` when a corner lies outside the
  frame, in which case the normalised quad keeps values below 0 or above 1), orientation from the direction of the
  document's top edge, rounded to 0/90/180/270.
- `background`: SmartDoc from the background id (01 wooden table → `plain-contrast`, 02 grey round table →
  `plain-contrast`, 03 speckled mauve table → `textured`, 04 pale table under a white page → `plain-similar`,
  05 desk with mouse, cup and cables → `cluttered`); MIDV from the clip condition (table/hand/partial →
  `plain-contrast`, keyboard/clutter → `cluttered`); CORD from the mean luminance inside against outside the
  receipt outline (`plain-contrast` or `plain-similar`).
- `occlusion`: `hand` for MIDV hand clips, otherwise `none`. `lighting: even` and `blur: none` everywhere, since
  none of the three datasets annotate them.
- `device`: `dataset:smartdoc15`, `dataset:cord`, `dataset:midv-500`. The MIDV notes name the phone (iPhone 5 or
  Galaxy S3) of each clip.
- `docMm`: 210×297 for SmartDoc (from the model size in its metadata), ISO/IEC 7810 sizes for MIDV by the size
  class in its attribution file (card 85.6×54, TD2 105×74, TD3 125×88); CORD receipts have no known size.

## Regenerating

```sh
node bench/tools/fetch-corpus.mjs                      # download every `remote` case (idempotent, verifies sha256)
node bench/tools/fetch-corpus.mjs --sample smartdoc    # 60 cases; downloads frames.tar.gz (1 GB) once
node bench/tools/fetch-corpus.mjs --sample cord        # 20 cases; Hugging Face datasets-server rows API
node bench/tools/fetch-corpus.mjs --sample midv        # 20 cases; one ~650 MB zip over FTP (needs curl and ffmpeg)
```

Options: `--seed <n>` (default 1), `--tmp <dir>` for downloads and scratch (default `$TMPDIR/quickscan-corpus`,
or `QUICKSCAN_CORPUS_TMP`), `--root <dir>` to work on another corpus directory. The samplers are deterministic:
the same seed produces the same ids, pixels and manifest entries, so re-running changes nothing once the files
exist. A different seed adds new cases alongside the old ones (ids carry the frame identity, never the seed). A
case that already exists under the same id from a different source is never overwritten. Committed frames are
re-encoded with their long edge at most 1920 px, JPEG quality 0.9; the manifest's `width`/`height` and the
normalised `quad` refer to that file.

Media budget: the 100 sampled cases weigh about 15 MB of frames plus 13 MB of previews. Keep new batches under
~50 MB; anything larger goes behind `remote`.

## Synthetic cases (`synth-`)

150 cases (`synth-pos-000` … `synth-pos-099`, `synth-neg-000` … `synth-neg-049`) rendered by `bench/tools/synth.mjs`
from the printable test pages of `bench/tools/pages.mjs`: a page is placed on a background with a known camera
homography, then degraded (shadow gradients, a hard shadow band, glare, low light, colour cast, blur, sensor noise,
JPEG, a hand or a pen over the page, edges cut off by the frame). Corner ground truth is exact (from the
homography), OCR ground truth is exact (from the page), and every output is a pure function of the seed, so the
frames (`frames/synth/`, 1080×1920 JPEG) and previews (`previews/synth/`) are **not committed**:

```sh
npm run bench:pages                                   # 22 printable pages + bench/corpus/text/e-*.txt (seed 1)
npm run bench:synth -- --seed 1 --positives 100 --negatives 50   # ~70 s; regenerates frames, previews, manifest entries
```

Backgrounds: three desk crops from the owner's clips (`bench/backgrounds/pine-desk-*.jpg`, document-free regions)
plus procedural textures (white table, dark cloth, grey mat, tiles, desk clutter, carpet). The photo set "BG" from
the shot list in `docs/scanner-data-plan.md` replaces the procedural ones. Synthetic cases carry
`conditions.device: "synthetic"` and are reported in their own table; they are breadth, not truth.

## Private cases (`own-`)

Stills from the owner's phone clips in `tests/fixtures/camera/private/` (ignored by version control), extracted by
`bench/tools/extract-frames.mjs` into `frames/private/` (also ignored), three per clip (settle, mid, end), with one
clip record per video in `clips/`. These frames show real letters and receipts, so only the manifest entries and
clip records are committed, and CI skips the cases (`private: true`). Corners start as **proposals** from
`bench/tools/autolabel.mjs` (the app's detector plus edge refinement, `label.method: "auto-refined"`,
`verified: false`, overlays in `frames/private/overlays/`); they become ground truth only after confirmation in
`bench/tools/label.html` (`label.method: "manual"`, `verified: true`). Entries flagged `label.suspect` are
frame-sized false detections and need hand labelling.

```sh
node bench/tools/extract-frames.mjs                   # --src tests/fixtures/camera/private by default
node bench/tools/autolabel.mjs --filter own-          # proposals + overlays for unlabelled cases
open bench/tools/label.html                           # load a frame + manifest.json, click TL, TR, BR, BL, export
node bench/tools/autolabel.mjs --apply <dir>          # apply exported *.label.json files
node bench/tools/autolabel.mjs --overlay smartdoc- --out /tmp/overlays   # draw stored quads for a spot check
```

## MIDV media is fetched, not committed

The MIDV-500 specimen documents carry a portrait, and this project's rule is that no face enters a tracked path,
specimen or not. The 20 `midv-` cases therefore have `generated: true`: their frames and previews are ignored by
version control and recreated locally with `npm run bench:fetch -- --sample midv`; only the manifest entries, the
licence text and `ATTRIBUTION.md` are committed. CI skips them with a warning from `npm run bench:validate`.

## Validation

`npm run bench:validate` checks schema version 2 (one of `file`/`remote`, `private` and `generated` flags,
previews for committed cases, quads in range and convex, `partial` for quads leaving the frame, the condition
taxonomy, licence fields, share-alike licence text next to the media) and prints the per-condition counts. It exits
non-zero on any error; missing media that a tool regenerates is a warning.
