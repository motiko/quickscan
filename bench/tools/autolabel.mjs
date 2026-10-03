#!/usr/bin/env node
// Corner proposals and review overlays for corpus frames.
//
//   node bench/tools/autolabel.mjs [--filter own-] [--force]          propose quads for unlabelled cases
//   node bench/tools/autolabel.mjs --overlay <prefix|id> --out <dir>   draw the stored quads for a visual check
//   node bench/tools/autolabel.mjs --apply <dir>                       apply *.label.json exported by label.html
//
// Proposal: the app's detector (scanic, classical, same options as src/lib/scanner.ts
// but at a 1000 px working width instead of the 320 px live preview), then each
// edge is refined on the full-resolution frame by fitting a line through the
// strongest luminance gradient along the edge's normal; adjacent lines intersect
// to give the corners. The result is stored with
//   label: { method: 'auto-refined', verified: false, detectorConfidence }
// and is a PROPOSAL until a human confirms it in label.html — a case with an
// unverified label never counts as ground truth (validate-manifest.mjs refuses to
// commit one) and must not be used to grade the detector that produced it.
//
// Overlays: proposal in red, refined in green, stored/confirmed in cyan, written
// as 1080 px wide PNGs. For private frames they go under frames/private/overlays/
// (ignored by version control) because they show the document.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installShims } from './shims.mjs';
import { readManifest, writeManifest, patchManifestCases } from './manifest-util.mjs';

installShims();
const { createCanvas, loadImage } = await import('canvas');
const { scanDocument } = await import('scanic');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const corpusDir = path.join(root, 'bench', 'corpus');

function parseArgs(argv) {
  const args = { filter: 'own-', force: false, overlay: null, out: null, apply: null, manifest: path.join(corpusDir, 'manifest.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') args.filter = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--overlay') args.overlay = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--apply') args.apply = argv[++i];
    else if (a === '--manifest') args.manifest = path.resolve(root, argv[++i]);
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Detection at a working width, mapped back to full resolution

async function detect(img) {
  const w = Math.min(1000, img.width);
  const h = Math.round((img.height * w) / img.width);
  const cv = createCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const res = await scanDocument(ctx.getImageData(0, 0, w, h), {
    mode: 'detect', detector: 'classical', minDetectionConfidence: 0.3, minDocumentCoverageRatio: 0.15, maxProcessingDimension: 1000,
  });
  if (!res.success || !res.corners) return null;
  const k = img.width / w;
  const quad = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].map((key) => ({ x: res.corners[key].x * k, y: res.corners[key].y * k }));
  return { quad, confidence: res.confidence ?? res.score ?? 0 };
}

// ---------------------------------------------------------------------------
// Edge refinement on the full-resolution luminance

function luminance(img) {
  const cv = createCanvas(img.width, img.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const lum = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return lum;
}

function sampleLum(lum, w, h, x, y) {
  const xi = Math.max(0, Math.min(w - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(h - 1, Math.round(y)));
  return lum[yi * w + xi];
}

// Fit a line to the strongest gradient along the normal of the proposed edge a→b.
function refineEdge(lum, w, h, a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const nx = -uy, ny = ux; // normal
  const band = Math.max(8, Math.round(Math.max(w, h) * 0.015));
  const step = 3; // px along the normal
  const samples = 48;
  const pts = [];
  for (let s = 0; s < samples; s++) {
    const t = 0.08 + (0.84 * s) / (samples - 1); // skip the corner regions
    const px = a.x + ux * len * t, py = a.y + uy * len * t;
    let best = 0, bestD = 0;
    for (let d = -band; d <= band; d += step) {
      // gradient along the normal, averaged over 5 px to suppress text strokes
      const g = Math.abs(
        sampleLum(lum, w, h, px + nx * (d + 4), py + ny * (d + 4)) + sampleLum(lum, w, h, px + nx * (d + 3), py + ny * (d + 3))
        - sampleLum(lum, w, h, px + nx * (d - 3), py + ny * (d - 3)) - sampleLum(lum, w, h, px + nx * (d - 4), py + ny * (d - 4)),
      );
      if (g > best) { best = g; bestD = d; }
    }
    if (best > 24) pts.push({ x: px + nx * bestD, y: py + ny * bestD, w: best });
  }
  if (pts.length < 8) return null;
  // robust least squares in the edge's own frame (parameter: offset along normal as a function of t)
  let line = fitLine(pts);
  for (let iter = 0; iter < 2; iter++) {
    const res = pts.map((p) => Math.abs((p.x - line.x0) * line.nx + (p.y - line.y0) * line.ny));
    const mean = res.reduce((s, v) => s + v, 0) / res.length;
    const sd = Math.sqrt(res.reduce((s, v) => s + (v - mean) ** 2, 0) / res.length) || 1;
    const kept = pts.filter((p, i) => res[i] <= mean + 1.5 * sd);
    if (kept.length < 6) break;
    line = fitLine(kept);
  }
  return line;
}

// Total least squares line through weighted points: returns a point and the unit normal.
function fitLine(pts) {
  let sw = 0, mx = 0, my = 0;
  for (const p of pts) { sw += p.w; mx += p.x * p.w; my += p.y * p.w; }
  mx /= sw; my /= sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += p.w * dx * dx; sxy += p.w * dx * dy; syy += p.w * dy * dy; }
  // direction = eigenvector of the larger eigenvalue
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(theta), dy = Math.sin(theta);
  return { x0: mx, y0: my, dx, dy, nx: -dy, ny: dx };
}

function intersect(l1, l2) {
  const det = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((l2.x0 - l1.x0) * l2.dy - (l2.y0 - l1.y0) * l2.dx) / det;
  return { x: l1.x0 + l1.dx * t, y: l1.y0 + l1.dy * t };
}

function refineQuad(lum, w, h, quad) {
  const lines = quad.map((a, i) => refineEdge(lum, w, h, a, quad[(i + 1) % 4]));
  if (lines.some((l) => !l)) return null;
  // corner i is the intersection of edge i-1 (ending there) and edge i (starting there)
  const corners = quad.map((_, i) => intersect(lines[(i + 3) % 4], lines[i]));
  if (corners.some((c) => !c)) return null;
  // sanity: refined corners stay within 3 % of the long edge of the proposal
  const limit = Math.max(w, h) * 0.03;
  if (corners.some((c, i) => Math.hypot(c.x - quad[i].x, c.y - quad[i].y) > limit)) return null;
  return corners;
}

// ---------------------------------------------------------------------------
// Overlays

async function drawOverlay(img, layers, outFile) {
  const w = 1080, h = Math.round((img.height * w) / img.width), k = w / img.width;
  const cv = createCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  for (const { quad, colour, label } of layers) {
    if (!quad) continue;
    ctx.strokeStyle = colour; ctx.lineWidth = 2;
    ctx.beginPath();
    quad.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)));
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = colour;
    quad.forEach((p, i) => { ctx.beginPath(); ctx.arc(p.x * k, p.y * k, 5, 0, Math.PI * 2); ctx.fill(); if (i === 0) ctx.fillText(label, p.x * k + 8, p.y * k - 8); });
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, cv.toBuffer('image/png'));
}

const toNorm = (quad, w, h) => quad.map((p) => [Math.round((p.x / w) * 10000) / 10000, Math.round((p.y / h) * 10000) / 10000]);
const fromNorm = (quad, w, h) => quad.map(([x, y]) => ({ x: x * w, y: y * h }));

// ---------------------------------------------------------------------------
// Modes

async function propose(args) {
  const manifest = readManifest(args.manifest);
  const targets = manifest.cases.filter((c) => c.id.startsWith(args.filter) && c.file && (args.force || (c.quad === null && !c.label?.verified)));
  if (!targets.length) { console.log('nothing to propose'); return; }
  const patches = {};
  for (const c of targets) {
    const file = path.join(corpusDir, c.file);
    if (!fs.existsSync(file)) { console.log(`${c.id}: media missing, skipped`); continue; }
    const img = await loadImage(file);
    const det = await detect(img);
    const overlayDir = c.private ? path.join(corpusDir, 'frames', 'private', 'overlays') : path.join(corpusDir, 'overlays');
    if (!det) {
      await drawOverlay(img, [], path.join(overlayDir, `${c.id}.png`));
      patches[c.id] = { notes: appendNote(c.notes, 'autolabel: no detection at 1000 px') };
      console.log(`${c.id}: no detection`);
      continue;
    }
    const lum = luminance(img);
    const refined = refineQuad(lum, img.width, img.height, det.quad);
    const final = refined ?? det.quad;
    // A quad hugging the frame is usually the detector giving up and returning the whole image.
    const touching = final.filter((p) => p.x < img.width * 0.01 || p.x > img.width * 0.99 || p.y < img.height * 0.01 || p.y > img.height * 0.99).length;
    const suspect = touching >= 2 || Math.abs(polyArea(final)) > img.width * img.height * 0.9;
    await drawOverlay(img, [
      { quad: det.quad, colour: 'rgba(255,60,60,0.9)', label: 'detector' },
      { quad: refined, colour: 'rgba(60,255,90,0.9)', label: 'refined' },
    ], path.join(overlayDir, `${c.id}.png`));
    // Refined edge lines can meet a hair outside the frame when the true corner sits on the edge:
    // snap overshoot under 0.5 % back to the frame; anything larger means the page really is cut off.
    const snapped = final.map((p) => ({ x: snap(p.x, img.width), y: snap(p.y, img.height) }));
    const leaves = snapped.some((p) => p.x < 0 || p.x > img.width || p.y < 0 || p.y > img.height);
    const conditions = leaves && c.conditions?.distance !== 'partial' ? { ...c.conditions, distance: 'partial' } : undefined;
    patches[c.id] = {
      ...(conditions ? { conditions } : {}),
      quad: toNorm(snapped, img.width, img.height),
      label: { method: 'auto-refined', verified: false, detectorConfidence: Math.round(det.confidence * 100) / 100, refined: Boolean(refined), ...(suspect ? { suspect: true } : {}) },
      notes: appendNote(c.notes, `autolabel proposal (${refined ? 'edge-refined' : 'detector only'}${suspect ? ', SUSPECT: frame-sized quad, relabel by hand' : ''}); confirm in label.html`),
    };
    console.log(`${c.id}: proposal conf ${det.confidence.toFixed(2)} ${refined ? 'refined' : 'unrefined'}${suspect ? ' SUSPECT' : ''} → ${JSON.stringify(patches[c.id].quad)}`);
  }
  const n = patchManifestCases(args.manifest, patches);
  console.log(`${n} cases updated; overlays for review under frames/private/overlays or overlays/`);
}

function snap(v, size) {
  const tol = size * 0.005;
  if (v < 0 && v > -tol) return 0;
  if (v > size && v < size + tol) return size;
  return v;
}

function appendNote(notes, add) {
  const base = (notes || '').split('; ').filter((n) => !n.startsWith('autolabel')).join('; ');
  return base ? `${base}; ${add}` : add;
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; }
  return a / 2;
}

async function overlays(args) {
  const manifest = readManifest(args.manifest);
  const outDir = path.resolve(root, args.out ?? 'bench/corpus/overlays');
  const targets = manifest.cases.filter((c) => c.id === args.overlay || c.id.startsWith(args.overlay));
  let n = 0;
  for (const c of targets) {
    const file = c.file && path.join(corpusDir, c.file);
    if (!file || !fs.existsSync(file)) continue;
    const img = await loadImage(file);
    await drawOverlay(img, [{ quad: c.quad ? fromNorm(c.quad, img.width, img.height) : null, colour: 'rgba(60,220,255,0.95)', label: c.label?.verified ? 'ground truth' : 'proposal' }], path.join(outDir, `${c.id}.png`));
    n++;
  }
  console.log(`${n} overlays → ${path.relative(root, outDir)}`);
}

function applyLabels(args) {
  const dir = path.resolve(root, args.apply);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.label.json'));
  const manifest = readManifest(args.manifest);
  const byId = new Map(manifest.cases.map((c) => [c.id, c]));
  let n = 0;
  for (const f of files) {
    const entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const c = byId.get(entry.id);
    if (!c) { console.log(`${entry.id}: not in manifest, skipped`); continue; }
    Object.assign(c, { quad: entry.quad, conditions: entry.conditions, width: entry.width, height: entry.height, label: { method: 'manual', verified: true, labelledAt: entry.label?.labelledAt } });
    n++;
  }
  writeManifest(args.manifest, manifest);
  console.log(`${n} labels applied`);
}

const args = parseArgs(process.argv.slice(2));
if (args.apply) applyLabels(args);
else if (args.overlay) await overlays(args);
else await propose(args);
