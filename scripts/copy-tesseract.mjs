#!/usr/bin/env node
/*
 * Copies Tesseract's worker script and WASM cores from node_modules into public/tesseract,
 * so OCR runs code from our own origin instead of cdn.jsdelivr.net. Allowing a public npm
 * CDN in script-src would let an injected script load any package from it, defeating the
 * CSP. Runs before `next dev` and `next build`; the output is gitignored.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'tesseract');

const tesseractDist = join(dirname(require.resolve('tesseract.js/package.json')), 'dist');
const coreDir = dirname(require.resolve('tesseract.js-core/package.json'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

copyFileSync(join(tesseractDist, 'worker.min.js'), join(out, 'worker.min.js'));
// The worker picks one build by CPU features (SIMD, relaxed SIMD) and LSTM-only mode; the
// .wasm.js files embed their WASM, so they're the only ones it loads.
const cores = readdirSync(coreDir).filter((f) => /^tesseract-core.*\.wasm\.js$/.test(f));
for (const file of cores) copyFileSync(join(coreDir, file), join(out, file));

console.log(`Copied Tesseract worker and ${cores.length} cores to public/tesseract`);
