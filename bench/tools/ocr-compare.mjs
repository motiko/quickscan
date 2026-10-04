// OCR accuracy of Tesseract (as the app runs it) against the native plugin (capacitor-native-ocr).
//
// Sets:
//   pages     the printable eval pages (bench/pages, `npm run bench:pages`): clean print, exact truth
//   captures  synthetic phone captures (`npm run bench:synth`) and CORD receipt photos, each warped to
//             its ground-truth quad first, so both engines read the same crop and only OCR is compared
//
//   node bench/tools/ocr-compare.mjs --set pages --write-jobs /tmp/jobs.json   # for the plugin's BenchTests
//   node bench/tools/ocr-compare.mjs --set all --export-app <example-app>/src/public/bench   # "Run benchmark" button
//   node bench/tools/ocr-compare.mjs --set pages --native /tmp/native.json [--out bench/results/<file>.json]
//
// --native takes BenchTests output ([{ id, text, ms }]) or the example app's copied results
// ({ results: [...] }). Tesseract gets what the app gives it: tesseract.js with its default language
// data, on a copy fitted to OCR_MAX_DIMENSION (read from src/lib/ocr-queue.ts).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "canvas";
import { createWorker } from "tesseract.js";
import { bagOfWordErrors, charErrors, wordErrors } from "./metrics.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pagesDir = path.join(root, "bench/pages");
const corpusDir = path.join(root, "bench/corpus");
const cropsDir = path.join(corpusDir, "ocr-crops");

// Tesseract codes as QuickScan stores them → BCP-47 tags for the plugin.
const BCP47 = { eng: "en-US", deu: "de-DE" };

function parseArgs(argv) {
  const args = { set: "pages" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--set") args.set = argv[++i];
    else if (flag === "--write-jobs") args.writeJobs = argv[++i];
    else if (flag === "--export-app") args.exportApp = argv[++i];
    else if (flag === "--native") args.native = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--filter") args.filter = argv[++i];
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!["pages", "captures", "all"].includes(args.set))
    throw new Error("--set is pages, captures or all");
  return args;
}

function ocrMaxDimension() {
  const source = fs.readFileSync(
    path.join(root, "src/lib/ocr-queue.ts"),
    "utf8",
  );
  const match = source.match(/const OCR_MAX_DIMENSION = (\d+)/);
  if (!match)
    throw new Error("OCR_MAX_DIMENSION not found in src/lib/ocr-queue.ts");
  return Number(match[1]);
}

// MARK: Cases — { id, set, lang, image (absolute path), truthPath, truth }

function pageCases() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pagesDir, "pages-eval.json"), "utf8"),
  );
  return manifest.pages.map((page) => {
    const image = path.join(pagesDir, page.png);
    if (!fs.existsSync(image))
      throw new Error(`${image} is missing; run npm run bench:pages first`);
    return {
      id: page.id,
      set: "clean print",
      lang: page.lang,
      image,
      truthPath: path.join(root, page.text),
    };
  });
}

async function captureCases() {
  const pages = JSON.parse(
    fs.readFileSync(path.join(pagesDir, "pages-eval.json"), "utf8"),
  ).pages;
  const langOfPage = new Map(pages.map((page) => [page.id, page.lang]));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpusDir, "manifest.json"), "utf8"),
  );
  const cases = [];
  for (const entry of manifest.cases ?? manifest) {
    if (!entry.text || !entry.quad || !entry.file) continue;
    let set;
    let lang;
    if (entry.id.startsWith("synth-pos-")) {
      const pageId = entry.notes?.match(/page (\S+)/)?.[1];
      set = "synthetic capture";
      lang = langOfPage.get(pageId);
    } else if (entry.id.startsWith("cord-test-")) {
      set = "CORD receipt photo";
      lang = "eng";
    } else continue;
    if (!lang) continue;
    const frame = path.join(corpusDir, entry.file);
    if (!fs.existsSync(frame))
      throw new Error(
        `${frame} is missing; run npm run bench:synth (see bench/corpus/README.md)`,
      );
    const image = path.join(cropsDir, `${entry.id}.jpg`);
    if (!fs.existsSync(image))
      await warpToQuad(frame, entry.quad, entry.docMm, image);
    cases.push({
      id: entry.id,
      set,
      lang,
      image,
      truthPath: path.join(corpusDir, entry.text),
    });
  }
  return cases;
}

async function loadCases(set, filter) {
  const cases = [
    ...(set === "captures" ? [] : pageCases()),
    ...(set === "pages" ? [] : await captureCases()),
  ];
  return cases
    .filter((c) => !filter || c.id.includes(filter))
    .map((c) => ({ ...c, truth: fs.readFileSync(c.truthPath, "utf8") }));
}

// MARK: Perspective warp to the ground-truth quad (TL, TR, BR, BL, normalized)

function solve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/** Homography taking destination pixels to source pixels. */
function homography(dst, src) {
  const m = [];
  const v = [];
  for (let i = 0; i < 4; i++) {
    const [u, w] = dst[i];
    const [x, y] = src[i];
    m.push([u, w, 1, 0, 0, 0, -u * x, -w * x]);
    v.push(x);
    m.push([0, 0, 0, u, w, 1, -u * y, -w * y]);
    v.push(y);
  }
  const [a, b, c, d, e, f, g, h] = solve(m, v);
  return (u, w) => {
    const z = g * u + h * w + 1;
    return [(a * u + b * w + c) / z, (d * u + e * w + f) / z];
  };
}

async function warpToQuad(framePath, quad, docMm, outPath) {
  const frame = await loadImage(framePath);
  const source = createCanvas(frame.width, frame.height);
  source.getContext("2d").drawImage(frame, 0, 0);
  const src = source
    .getContext("2d")
    .getImageData(0, 0, frame.width, frame.height);
  const corners = quad.map(([x, y]) => [x * frame.width, y * frame.height]);
  const length = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const width = Math.round(
    Math.max(length(corners[0], corners[1]), length(corners[3], corners[2])),
  );
  const height = docMm
    ? Math.round((width * docMm[1]) / docMm[0])
    : Math.round(
        Math.max(
          length(corners[0], corners[3]),
          length(corners[1], corners[2]),
        ),
      );
  const map = homography(
    [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ],
    corners,
  );

  const out = createCanvas(width, height);
  const dst = out.getContext("2d").createImageData(width, height);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const [x, y] = map(u + 0.5, v + 0.5);
      const x0 = Math.min(Math.max(Math.floor(x - 0.5), 0), frame.width - 2);
      const y0 = Math.min(Math.max(Math.floor(y - 0.5), 0), frame.height - 2);
      const fx = Math.min(Math.max(x - 0.5 - x0, 0), 1);
      const fy = Math.min(Math.max(y - 0.5 - y0, 0), 1);
      const o = (v * width + u) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const p = (yy, xx) => src.data[(yy * frame.width + xx) * 4 + ch];
        dst.data[o + ch] =
          p(y0, x0) * (1 - fx) * (1 - fy) +
          p(y0, x0 + 1) * fx * (1 - fy) +
          p(y0 + 1, x0) * (1 - fx) * fy +
          p(y0 + 1, x0 + 1) * fx * fy;
      }
      dst.data[o + 3] = 255;
    }
  }
  out.getContext("2d").putImageData(dst, 0, 0);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // High-quality JPEG keeps the app export small; both engines read the same file.
  fs.writeFileSync(outPath, out.toBuffer("image/jpeg", { quality: 0.95 }));
}

// MARK: Engines and scoring

async function fitted(imagePath, maxDimension) {
  const image = await loadImage(imagePath);
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const canvas = createCanvas(
    Math.round(image.width * scale),
    Math.round(image.height * scale),
  );
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer("image/png");
}

async function runTesseract(cases) {
  const maxDimension = ocrMaxDimension();
  const workers = new Map();
  const results = new Map();
  for (const c of cases) {
    if (!workers.has(c.lang)) workers.set(c.lang, await createWorker(c.lang));
    const started = performance.now();
    const { data } = await workers
      .get(c.lang)
      .recognize(await fitted(c.image, maxDimension));
    results.set(c.id, { text: data.text, ms: performance.now() - started });
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  await Promise.all([...workers.values()].map((worker) => worker.terminate()));
  return { results, maxDimension };
}

function readNative(file) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = Array.isArray(json) ? json : json.results;
  return {
    results: new Map(entries.map((entry) => [entry.id, entry])),
    source: Array.isArray(json) ? "BenchTests" : json.userAgent,
  };
}

function score(cases, results) {
  const perCase = {};
  const totals = { chars: [0, 0], words: [0, 0], bag: [0, 0] };
  for (const c of cases) {
    const result = results.get(c.id);
    if (!result) continue;
    const ch = charErrors(result.text, c.truth);
    const w = wordErrors(result.text, c.truth);
    const b = bagOfWordErrors(result.text, c.truth);
    perCase[c.id] = {
      cer: ch.errors / ch.total,
      wer: w.errors / w.total,
      bagWer: b.errors / b.total,
      ms: Math.round(result.ms),
    };
    totals.chars[0] += ch.errors;
    totals.chars[1] += ch.total;
    totals.words[0] += w.errors;
    totals.words[1] += w.total;
    totals.bag[0] += b.errors;
    totals.bag[1] += b.total;
  }
  return {
    cer: totals.chars[0] / totals.chars[1],
    wer: totals.words[0] / totals.words[1],
    bagWer: totals.bag[0] / totals.bag[1],
    perCase,
  };
}

const pct = (value) =>
  value === undefined || Number.isNaN(value)
    ? "—"
    : `${(value * 100).toFixed(2)} %`;

function exportApp(cases, dir) {
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.mkdirSync(path.join(dir, "text"), { recursive: true });
  const entries = cases.map((c) => {
    const image = `images/${c.id}${path.extname(c.image)}`;
    const truth = `text/${c.id}.txt`;
    fs.copyFileSync(c.image, path.join(dir, image));
    fs.writeFileSync(path.join(dir, truth), c.truth);
    return { id: c.id, set: c.set, image, languages: [BCP47[c.lang]], truth };
  });
  const sha = execSync("git rev-parse --short HEAD", { cwd: root })
    .toString()
    .trim();
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      { name: `QuickScan OCR bench (${sha})`, cases: entries },
      null,
      2,
    ),
  );
  console.log(`${entries.length} cases → ${dir}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadCases(args.set, args.filter);

  if (args.writeJobs) {
    const jobs = cases.map((c) => ({
      id: c.id,
      path: c.image,
      languages: [BCP47[c.lang]],
    }));
    fs.writeFileSync(args.writeJobs, JSON.stringify(jobs, null, 2));
    console.log(`${jobs.length} jobs → ${args.writeJobs}`);
    return;
  }
  if (args.exportApp) {
    exportApp(cases, args.exportApp);
    return;
  }

  const tesseract = await runTesseract(cases);
  const results = { tesseract: tesseract.results };
  let nativeSource;
  if (args.native) {
    const native = readNative(args.native);
    results.native = native.results;
    nativeSource = native.source;
  }
  const names = Object.keys(results);
  const engines = Object.fromEntries(
    names.map((n) => [n, score(cases, results[n])]),
  );

  const cells = (s) =>
    names.flatMap((n) => [pct(s(n)?.cer), pct(s(n)?.bagWer)]).join(" | ");
  console.log(
    `| Case | ${names.map((n) => `${n} CER | ${n} order-free WER`).join(" | ")} |`,
  );
  console.log(`|---|${names.map(() => "---|---").join("|")}|`);
  for (const c of cases)
    console.log(`| ${c.id} | ${cells((n) => engines[n].perCase[c.id])} |`);
  const groups = [
    ...[...new Set(cases.map((c) => c.set))].map((set) => [
      set,
      cases.filter((c) => c.set === set),
    ]),
    ...[...new Set(cases.map((c) => c.lang))].map((lang) => [
      `all ${lang}`,
      cases.filter((c) => c.lang === lang),
    ]),
  ];
  for (const [label, subset] of groups)
    console.log(
      `| **${label}** | ${cells((n) => score(subset, results[n]))} |`,
    );
  console.log(`| **All** | ${cells((n) => engines[n])} |`);

  if (args.out) {
    const sha = execSync("git rev-parse --short HEAD", { cwd: root })
      .toString()
      .trim();
    const record = {
      date: new Date().toISOString().slice(0, 10),
      sha,
      set: args.set,
      environment: {
        node: process.version,
        tesseract: `tesseract.js ${JSON.parse(fs.readFileSync(path.join(root, "node_modules/tesseract.js/package.json"), "utf8")).version}, default language data, image fitted to ${tesseract.maxDimension} px`,
        native: nativeSource,
      },
      metrics: Object.fromEntries(
        names.map((n) => [
          n,
          Object.fromEntries(
            [["all", engines[n]], ...groups].map(([label, subset]) => {
              const s =
                label === "all" ? engines[n] : score(subset, results[n]);
              return [label, { cer: s.cer, wer: s.wer, bagWer: s.bagWer }];
            }),
          ),
        ]),
      ),
      perCase: Object.fromEntries(names.map((n) => [n, engines[n].perCase])),
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(record, null, 2) + "\n");
    console.log(`→ ${args.out}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
