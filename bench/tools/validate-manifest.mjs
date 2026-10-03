#!/usr/bin/env node
// Validates bench/corpus/manifest.json against schema version 2 (scanner-bench skill).
//
//   node bench/tools/validate-manifest.mjs [--manifest bench/corpus/manifest.json] [--ci] [--strict]
//
// --ci      ignore private cases entirely (CI never has the private media)
// --strict  also fail when generated (synthetic) media is missing instead of hinting `npm run bench:synth`
//
// Exit code 1 on any error; warnings are printed but do not fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export const CONDITIONS = {
  doc: ['a4-text', 'a5-text', 'receipt', 'business-card', 'id-card', 'book-curved', 'whiteboard', 'photo', 'handwritten', 'invoice', 'none'],
  background: ['plain-contrast', 'plain-similar', 'cluttered', 'textured', 'dark'],
  lighting: ['even', 'low', 'harsh-shadow', 'glare', 'mixed-colour'],
  skew: ['none', 'mild', 'strong', 'extreme'],
  distance: ['fills', 'normal', 'far', 'partial'],
  blur: ['none', 'mild', 'motion', 'focus'],
  occlusion: ['none', 'hand', 'object'],
  orientation: [0, 90, 180, 270],
};
const DEVICE_RE = /^(iphone-14-pro|iphone-15|pixel-7a|synthetic|dataset:[a-z0-9-]+)$/;
const CAPTURE_KINDS = ['video-frame', 'photo', 'synthetic', 'dataset'];
const LABEL_METHODS = ['synthetic', 'dataset', 'manual', 'auto-refined'];
const HARD = {
  background: ['plain-similar', 'cluttered', 'dark'],
  lighting: ['low', 'harsh-shadow', 'glare'],
  occlusion: ['hand', 'object'],
  distance: ['partial'],
};

export function validate(manifest, { ci = false, strict = false, corpusDir = path.join(root, 'bench', 'corpus') } = {}) {
  const errors = [];
  const warnings = [];
  const err = (id, msg) => errors.push(`${id}: ${msg}`);
  const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

  if (manifest.version !== 2) errors.push(`manifest.version must be 2, got ${manifest.version}`);
  if (!Array.isArray(manifest.cases)) { errors.push('manifest.cases must be an array'); return { errors, warnings, counts: {} }; }

  const ids = manifest.cases.map((c) => c.id);
  const sorted = [...ids].sort();
  if (ids.some((id, i) => id !== sorted[i])) errors.push('cases are not sorted by id');
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) errors.push(`duplicate ids: ${[...new Set(dupes)].join(', ')}`);

  const counts = { total: 0, positives: 0, negatives: 0, private: 0, synthetic: 0, dataset: 0, real: 0, hard: {}, byCondition: {} };
  let missingGenerated = 0;

  for (const c of manifest.cases) {
    const id = c.id ?? '<no id>';
    if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) err(id, 'id must be lowercase letters, digits and dashes');
    if (ci && c.private) continue;
    counts.total++;

    const media = ['file', 'remote'].filter((k) => c[k]);
    if (media.length !== 1) err(id, `exactly one of file/remote is required, got ${media.join('+') || 'none'}`);
    if (c.private && !c.file) err(id, 'private cases name their (ignored) file');
    if (c.remote && (!c.remote.url || !c.remote.sha256 || !c.remote.path)) err(id, 'remote needs url, sha256 and path');

    if (c.file) {
      const abs = path.join(corpusDir, c.file);
      if (!fs.existsSync(abs)) {
        if ((c.generated || c.private) && !strict) missingGenerated++;
        else err(id, `file missing: ${c.file}`);
      } else if (!c.generated && fs.statSync(abs).size > 5 * 1024 * 1024) err(id, `committed media over 5 MB: ${c.file}`);
    }
    if (c.remote && !fs.existsSync(path.join(corpusDir, c.remote.path))) warn(id, `remote media not fetched (${c.remote.path}); run npm run bench:fetch`);

    if (!c.private) {
      if (!c.preview) err(id, 'preview is required for non-private cases');
      else if (!fs.existsSync(path.join(corpusDir, c.preview))) {
        if ((c.generated || c.private) && !strict) missingGenerated++;
        else err(id, `preview missing: ${c.preview}`);
      }
    } else counts.private++;

    if (!(Number.isInteger(c.width) && c.width > 0 && Number.isInteger(c.height) && c.height > 0)) err(id, 'width/height must be positive integers');

    if (c.quad === null) counts.negatives++;
    else if (Array.isArray(c.quad) && c.quad.length === 4 && c.quad.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
      counts.positives++;
      const out = c.quad.some(([x, y]) => x < -0.5 || x > 1.5 || y < -0.5 || y > 1.5);
      if (out) err(id, 'quad corners far outside the frame (allowed range -0.5..1.5)');
      const partlyOut = c.quad.some(([x, y]) => x < 0 || x > 1 || y < 0 || y > 1);
      if (partlyOut && c.conditions?.distance !== 'partial') err(id, 'quad leaves the frame but distance is not "partial"');
      if (!isConvex(c.quad)) err(id, 'quad is not convex');
    } else err(id, 'quad must be null or four [x, y] pairs');

    if (c.text && !fs.existsSync(path.join(corpusDir, c.text))) err(id, `text missing: ${c.text}`);
    if (c.quad === null && c.text) warn(id, 'negative case has OCR text');
    if (c.docMm && !(Array.isArray(c.docMm) && c.docMm.length === 2 && c.docMm.every((v) => v > 0))) err(id, 'docMm must be [width, height] in mm');

    if (c.split !== 'eval') err(id, `split must be "eval" (training data never enters this manifest), got ${c.split}`);
    if (!c.capture || !CAPTURE_KINDS.includes(c.capture.kind)) err(id, `capture.kind must be one of ${CAPTURE_KINDS.join('|')}`);
    if (!c.label || !LABEL_METHODS.includes(c.label.method) || typeof c.label.verified !== 'boolean') err(id, 'label needs method and boolean verified');
    if (c.label && !c.label.verified && !c.private) err(id, 'unverified label on a committed case: confirm it in label.html first');
    if (c.label?.method === 'auto-refined' && c.label.verified === false && c.quad !== null) warn(id, 'auto-refined proposal awaiting confirmation');

    if (!c.conditions) err(id, 'conditions missing');
    else {
      for (const [key, allowed] of Object.entries(CONDITIONS)) {
        if (!allowed.includes(c.conditions[key])) err(id, `conditions.${key} "${c.conditions[key]}" not in ${allowed.join('|')}`);
      }
      if (!DEVICE_RE.test(c.conditions.device ?? '')) err(id, `conditions.device "${c.conditions.device}" invalid`);
      if (c.quad === null && c.conditions.doc !== 'none' && c.conditions.distance !== 'far') warn(id, 'negative case: doc should be "none" or distance "far" (under 10 % of frame)');
      if (c.quad !== null) {
        for (const [key, values] of Object.entries(HARD)) {
          if (values.includes(c.conditions[key])) counts.hard[c.conditions[key]] = (counts.hard[c.conditions[key]] || 0) + 1;
        }
        for (const key of Object.keys(CONDITIONS)) {
          counts.byCondition[key] ??= {};
          const v = c.conditions[key];
          counts.byCondition[key][v] = (counts.byCondition[key][v] || 0) + 1;
        }
      }
      if (c.conditions.device === 'synthetic') counts.synthetic++;
      else if (String(c.conditions.device).startsWith('dataset:')) counts.dataset++;
      else counts.real++;
      if (c.capture?.kind === 'synthetic' && c.conditions.device !== 'synthetic') err(id, 'synthetic capture must have device "synthetic"');
    }

    if (!c.source || !c.source.name || !c.source.licence) err(id, 'source needs name and licence');
    if (String(c.conditions?.device).startsWith('dataset:') && !c.source?.url) err(id, 'dataset case needs source.url');
    if (c.source?.licence && /BY-SA/i.test(c.source.licence)) {
      const dir = path.dirname(path.join(corpusDir, c.file || c.preview || ''));
      if (!fs.existsSync(path.join(dir, 'LICENSE-CC-BY-SA-2.5.txt')) && !fs.existsSync(path.join(dir, 'LICENSE.txt'))) err(id, 'share-alike case: licence text must sit next to the media');
    }
  }

  if (missingGenerated) warnings.push(`${missingGenerated} uncommitted media files missing — synthetic: npm run bench:synth; MIDV samples (kept out of the repo): npm run bench:fetch -- --sample midv; private frames: node bench/tools/extract-frames.mjs`);
  return { errors, warnings, counts };
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

function report({ errors, warnings, counts }) {
  console.log(`cases: ${counts.total}  positives: ${counts.positives}  negatives: ${counts.negatives}  private: ${counts.private}`);
  console.log(`sources: real ${counts.real}  dataset ${counts.dataset}  synthetic ${counts.synthetic}`);
  const hard = Object.entries(counts.hard).sort().map(([k, v]) => `${k}=${v}`).join('  ');
  console.log(`hard conditions (positives): ${hard || 'none'}`);
  for (const [key, vals] of Object.entries(counts.byCondition)) {
    console.log(`  ${key.padEnd(12)} ${Object.entries(vals).sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`error: ${e}`);
  console.log(errors.length ? `\n${errors.length} error(s)` : '\nmanifest valid');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const file = path.resolve(root, get('--manifest') ?? 'bench/corpus/manifest.json');
  if (!fs.existsSync(file)) { console.error(`no manifest at ${file}`); process.exit(1); }
  const result = validate(JSON.parse(fs.readFileSync(file, 'utf8')), { ci: argv.includes('--ci'), strict: argv.includes('--strict'), corpusDir: path.dirname(file) });
  report(result);
  process.exit(result.errors.length ? 1 : 0);
}
