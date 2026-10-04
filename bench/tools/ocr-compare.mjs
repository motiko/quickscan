// OCR accuracy of Tesseract (as the app runs it) against the native plugin
// (capacitor-native-ocr) on the printable eval pages: clean print with exact ground truth.
//
//   npm run bench:pages                                         # renders bench/pages/*.png
//   node bench/tools/ocr-compare.mjs --write-jobs /tmp/jobs.json  # job file for the plugin's BenchTests
//   (run BenchTests in the plugin repo, see its ios/Tests/NativeOcrPluginTests/BenchTests.swift)
//   node bench/tools/ocr-compare.mjs --native /tmp/native.json [--out bench/results/<file>.json]
//
// Tesseract gets what the app gives it: tesseract.js with its default language data, on a copy
// fitted to OCR_MAX_DIMENSION (read from src/lib/ocr-queue.ts). The plugin gets the full page.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from 'canvas';
import { createWorker } from 'tesseract.js';
import { bagOfWordErrors, charErrors, wordErrors } from './metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pagesDir = path.join(root, 'bench/pages');

// Tesseract codes as QuickScan stores them → BCP-47 tags for the plugin.
const BCP47 = { eng: 'en-US', deu: 'de-DE' };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write-jobs') args.writeJobs = argv[++i];
    else if (argv[i] === '--native') args.native = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--filter') args.filter = argv[++i];
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  return args;
}

function ocrMaxDimension() {
  const source = fs.readFileSync(path.join(root, 'src/lib/ocr-queue.ts'), 'utf8');
  const match = source.match(/const OCR_MAX_DIMENSION = (\d+)/);
  if (!match) throw new Error('OCR_MAX_DIMENSION not found in src/lib/ocr-queue.ts');
  return Number(match[1]);
}

function loadPages(filter) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pagesDir, 'pages-eval.json'), 'utf8'));
  return manifest.pages
    .filter((page) => !filter || page.id.includes(filter))
    .map((page) => {
      const png = path.join(pagesDir, page.png);
      if (!fs.existsSync(png)) throw new Error(`${png} is missing; run npm run bench:pages first`);
      return { ...page, pngPath: png, truth: fs.readFileSync(path.join(root, page.text), 'utf8') };
    });
}

async function fitted(pngPath, maxDimension) {
  const image = await loadImage(pngPath);
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/png');
}

async function runTesseract(pages) {
  const maxDimension = ocrMaxDimension();
  const workers = new Map();
  const results = new Map();
  for (const page of pages) {
    if (!workers.has(page.lang)) workers.set(page.lang, await createWorker(page.lang));
    const started = performance.now();
    const { data } = await workers.get(page.lang).recognize(await fitted(page.pngPath, maxDimension));
    results.set(page.id, { text: data.text, ms: performance.now() - started });
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  await Promise.all([...workers.values()].map((worker) => worker.terminate()));
  return { results, maxDimension };
}

function score(pages, results) {
  const perPage = {};
  const totals = { chars: [0, 0], words: [0, 0], bag: [0, 0] };
  for (const page of pages) {
    const result = results.get(page.id);
    if (!result) continue;
    const c = charErrors(result.text, page.truth);
    const w = wordErrors(result.text, page.truth);
    const b = bagOfWordErrors(result.text, page.truth);
    perPage[page.id] = { cer: c.errors / c.total, wer: w.errors / w.total, bagWer: b.errors / b.total, ms: Math.round(result.ms) };
    totals.chars[0] += c.errors;
    totals.chars[1] += c.total;
    totals.words[0] += w.errors;
    totals.words[1] += w.total;
    totals.bag[0] += b.errors;
    totals.bag[1] += b.total;
  }
  return {
    cer: totals.chars[0] / totals.chars[1],
    wer: totals.words[0] / totals.words[1],
    bagWer: totals.bag[0] / totals.bag[1],
    perPage,
  };
}

const pct = (value) => (value === undefined ? '—' : `${(value * 100).toFixed(2)} %`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pages = loadPages(args.filter);

  if (args.writeJobs) {
    const jobs = pages.map((page) => ({ id: page.id, path: page.pngPath, languages: [BCP47[page.lang]] }));
    fs.writeFileSync(args.writeJobs, JSON.stringify(jobs, null, 2));
    console.log(`${jobs.length} jobs → ${args.writeJobs}`);
    return;
  }

  const tesseract = await runTesseract(pages);
  const results = { tesseract: tesseract.results };
  if (args.native) {
    const native = JSON.parse(fs.readFileSync(args.native, 'utf8'));
    results.native = new Map(native.map((entry) => [entry.id, entry]));
  }
  const names = Object.keys(results);
  const engines = Object.fromEntries(names.map((n) => [n, score(pages, results[n])]));

  const cells = (s) => names.flatMap((n) => [pct(s(n)?.cer), pct(s(n)?.bagWer)]).join(' | ');
  console.log(`| Page | ${names.map((n) => `${n} CER | ${n} order-free WER`).join(' | ')} |`);
  console.log(`|---|${names.map(() => '---|---').join('|')}|`);
  for (const page of pages) console.log(`| ${page.id} | ${cells((n) => engines[n].perPage[page.id])} |`);
  for (const lang of new Set(pages.map((page) => page.lang))) {
    const subset = pages.filter((page) => page.lang === lang);
    console.log(`| All ${lang} | ${cells((n) => score(subset, results[n]))} |`);
  }
  console.log(`| **All pages** | ${cells((n) => engines[n])} |`);
  console.log(`| All pages, WER | ${names.map((n) => `${pct(engines[n].wer)} | `).join(' | ')} |`);

  if (args.out) {
    const sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
    const record = {
      date: new Date().toISOString().slice(0, 10),
      sha,
      corpus: 'bench/pages eval set (clean print, 300 dpi)',
      environment: {
        node: process.version,
        tesseract: `tesseract.js ${JSON.parse(fs.readFileSync(path.join(root, 'node_modules/tesseract.js/package.json'), 'utf8')).version}, default language data, image fitted to ${tesseract.maxDimension} px`,
        native: args.native ? 'capacitor-native-ocr BenchTests output (see the native file for device)' : undefined,
      },
      metrics: Object.fromEntries(names.map((n) => [n, { cer: engines[n].cer, wer: engines[n].wer, bagWer: engines[n].bagWer }])),
      perPage: Object.fromEntries(names.map((n) => [n, engines[n].perPage])),
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(record, null, 2) + '\n');
    console.log(`→ ${args.out}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
