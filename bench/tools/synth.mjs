#!/usr/bin/env node
// Seeded synthetic scanner cases (corpus bucket D).
//
// A test page from pages.mjs is placed on a background with a known camera
// homography, then degraded (shadow, glare, low light, blur, noise, colour
// cast, JPEG, occluding hand/pen, cut-off edges). The homography gives exact
// corner ground truth; the page gives exact OCR ground truth. Every output is a
// pure function of the seed, so frames and previews are not committed — only the
// manifest entries are — and `npm run bench:synth` regenerates them.
//
//   node bench/tools/synth.mjs [--seed 1] [--positives 100] [--negatives 50] [--out bench/corpus] [--no-manifest]
//   node bench/tools/synth.mjs --one <index>        # render one case to stdout path (debugging)
//
// Frame size is 1080×1920 (portrait), the common Android stream size. The live
// detector only ever sees a 320 px downscale (CameraView.tsx), and the 12 MP
// capture metrics (M7, M9, M10) come from real captures, not from here.
//
// Synthetic cases are reported in their own table (conditions.device = 'synthetic');
// they are breadth, not truth. Backgrounds: bench/backgrounds/*.jpg (photographed,
// small) plus procedural textures below; photo set BG from the shot list replaces
// the procedural ones.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from 'canvas';
import { rng, generate as generatePages } from './pages.mjs';
import { mergeManifestEntries } from './manifest-util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export const FRAME_W = 1080;
export const FRAME_H = 1920;
const PREVIEW_W = 320;

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { seed: 1, positives: 100, negatives: 50, out: 'bench/corpus', manifest: true, one: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--positives') args.positives = Number(argv[++i]);
    else if (a === '--negatives') args.negatives = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--no-manifest') args.manifest = false;
    else if (a === '--one') args.one = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
      process.exit(0);
    } else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Geometry: 3×3 homographies as row-major arrays of 9.

export function solveHomography(src, dst) {
  // DLT with 4 correspondences: h maps src → dst, h[8] = 1.
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = gaussSolve(A, b);
  return [...h, 1];
}

function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

export function invert3(h) {
  const [a, b, c, d, e, f, g, hh, i] = h;
  const A = e * i - f * hh, B = -(d * i - f * g), C = d * hh - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * hh) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * hh - b * g) / det, (a * e - b * d) / det,
  ];
}

export function apply(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

// Project a page of physical size (wMm × hMm) seen by a pinhole camera: the page is
// rotated by (tiltX, tiltY, roll) radians, centred at (cx, cy) in the frame, and
// scaled so its projected area is `areaFrac` of the frame. Returns TL,TR,BR,BL.
export function projectPage(wMm, hMm, { tiltX, tiltY, roll, cx, cy, areaFrac }) {
  const f = 1.0; // focal length in page-size units; perspective strength comes from tilt and distance
  const dist = 2.2;
  const pts = [[-wMm / 2, -hMm / 2], [wMm / 2, -hMm / 2], [wMm / 2, hMm / 2], [-wMm / 2, hMm / 2]];
  const norm = Math.max(wMm, hMm);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cx_ = Math.cos(tiltX), sx_ = Math.sin(tiltX);
  const cy_ = Math.cos(tiltY), sy_ = Math.sin(tiltY);
  let proj = pts.map(([px, py]) => {
    let x = px / norm, y = py / norm, z = 0;
    // roll about z
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    // tilt about x
    [y, z] = [y * cx_ - z * sx_, y * sx_ + z * cx_];
    // tilt about y
    [x, z] = [x * cy_ + z * sy_, -x * sy_ + z * cy_];
    z += dist;
    return { x: (f * x) / z, y: (f * y) / z };
  });
  // scale to requested area and position
  const area = Math.abs(polyArea(proj));
  const s = Math.sqrt((areaFrac * FRAME_W * FRAME_H) / area);
  proj = proj.map((p) => ({ x: cx + p.x * s, y: cy + p.y * s }));
  return proj;
}

// Translate (and if needed shrink about its centre) a quad so it lies inside the frame with a margin.
export function fitInFrame(quad, margin) {
  let q = quad;
  const bbox = () => {
    const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  let b = bbox();
  const availW = FRAME_W - 2 * margin, availH = FRAME_H - 2 * margin;
  const s = Math.min(1, availW / (b.x1 - b.x0), availH / (b.y1 - b.y0));
  if (s < 1) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    q = q.map((p) => ({ x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s }));
    b = bbox();
  }
  const dx = b.x0 < margin ? margin - b.x0 : b.x1 > FRAME_W - margin ? FRAME_W - margin - b.x1 : 0;
  const dy = b.y0 < margin ? margin - b.y0 : b.y1 > FRAME_H - margin ? FRAME_H - margin - b.y1 : 0;
  return q.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

// Keep a partial quad within `frac` of the frame size beyond each edge (labels stay in -0.5..1.5).
export function limitOvershoot(quad, frac) {
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const minX = -frac * FRAME_W, maxX = (1 + frac) * FRAME_W, minY = -frac * FRAME_H, maxY = (1 + frac) * FRAME_H;
  let dx = 0, dy = 0;
  if (Math.min(...xs) < minX) dx = minX - Math.min(...xs);
  if (Math.max(...xs) > maxX) dx = maxX - Math.max(...xs);
  if (Math.min(...ys) < minY) dy = minY - Math.min(...ys);
  if (Math.max(...ys) > maxY) dy = maxY - Math.max(...ys);
  let q = quad.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  const w = Math.max(...q.map((p) => p.x)) - Math.min(...q.map((p) => p.x));
  const h = Math.max(...q.map((p) => p.y)) - Math.min(...q.map((p) => p.y));
  const sc = Math.min(1, (maxX - minX) / w, (maxY - minY) / h);
  if (sc < 1) {
    const cx = q.reduce((a, p) => a + p.x, 0) / 4, cy = q.reduce((a, p) => a + p.y, 0) / 4;
    q = q.map((p) => ({ x: cx + (p.x - cx) * sc, y: cy + (p.y - cy) * sc }));
  }
  return q;
}

export function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    a += p[i].x * p[j].y - p[j].x * p[i].y;
  }
  return a / 2;
}

function clipArea(quad) {
  // Area of the quad inside the frame, by sampling (fine enough for condition labels).
  let inside = 0;
  const n = 60;
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = x0 + ((i + 0.5) / n) * (x1 - x0), y = y0 + ((j + 0.5) / n) * (y1 - y0);
    if (x >= 0 && x < FRAME_W && y >= 0 && y < FRAME_H && pointInQuad(quad, x, y)) inside++;
  }
  return (inside / (n * n)) * (x1 - x0) * (y1 - y0);
}

function pointInQuad(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (c === 0) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Backgrounds

const BG_DIR = path.join(root, 'bench', 'backgrounds');

function photoBackgrounds() {
  if (!fs.existsSync(BG_DIR)) return [];
  return fs.readdirSync(BG_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => ({ name: f.replace(/\.\w+$/, ''), file: path.join(BG_DIR, f) }));
}

// Procedural textures draw into a FRAME_W × FRAME_H context; `r` is the case PRNG.
const PROCEDURAL = {
  'white-table': (ctx, r) => {
    // plain-similar: off-white surface with a soft gradient and faint grain
    const g = ctx.createLinearGradient(0, 0, FRAME_W, FRAME_H);
    const a = 225 + r.int(0, 15), b = 205 + r.int(0, 20);
    g.addColorStop(0, `rgb(${a},${a},${a - 3})`);
    g.addColorStop(1, `rgb(${b},${b - 2},${b - 6})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    grain(ctx, r, 6);
  },
  'dark-cloth': (ctx, r) => {
    ctx.fillStyle = `rgb(${28 + r.int(0, 10)},${30 + r.int(0, 10)},${38 + r.int(0, 12)})`;
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    // weave
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = '#fff';
    for (let y = 0; y < FRAME_H; y += 3) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(FRAME_W, y + (r() - 0.5)); ctx.stroke(); }
    for (let x = 0; x < FRAME_W; x += 3) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + (r() - 0.5), FRAME_H); ctx.stroke(); }
    ctx.globalAlpha = 1;
    grain(ctx, r, 5);
  },
  'grey-mat': (ctx, r) => {
    ctx.fillStyle = `rgb(${70 + r.int(0, 20)},${72 + r.int(0, 20)},${75 + r.int(0, 20)})`;
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    grain(ctx, r, 4);
  },
  tiles: (ctx, r) => {
    // rectangle trap: a tiled floor with dark grout lines
    const t = 180 + r.int(0, 80);
    ctx.fillStyle = `rgb(${195 + r.int(0, 30)},${190 + r.int(0, 30)},${180 + r.int(0, 30)})`;
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    ctx.strokeStyle = 'rgb(90,85,80)'; ctx.lineWidth = 6;
    const ox = r.int(0, t), oy = r.int(0, t);
    for (let x = -ox; x < FRAME_W + t; x += t) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, FRAME_H); ctx.stroke(); }
    for (let y = -oy; y < FRAME_H + t; y += t) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(FRAME_W, y); ctx.stroke(); }
    grain(ctx, r, 5);
  },
  'desk-clutter': (ctx, r) => {
    // cluttered: a dark desk with a keyboard, cables, pens and other papers
    ctx.fillStyle = `rgb(${60 + r.int(0, 30)},${45 + r.int(0, 20)},${35 + r.int(0, 15)})`;
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    // keyboard
    ctx.save();
    ctx.translate(r.int(-100, 300), r.int(50, 700));
    ctx.rotate((r() - 0.5) * 0.4);
    ctx.fillStyle = '#2a2a2e'; ctx.fillRect(0, 0, 900, 320);
    ctx.fillStyle = '#4a4a50';
    for (let row = 0; row < 5; row++) for (let col = 0; col < 14; col++) ctx.fillRect(20 + col * 62, 20 + row * 60, 52, 50);
    ctx.restore();
    // other papers
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.translate(r.int(0, FRAME_W), r.int(FRAME_H * 0.45, FRAME_H));
      ctx.rotate((r() - 0.5) * 1.2);
      ctx.fillStyle = `rgb(${235 + r.int(0, 20)},${235 + r.int(0, 20)},${225 + r.int(0, 20)})`;
      ctx.fillRect(0, 0, r.int(200, 320), r.int(260, 420)); // each under 10 % of the frame, so a clutter frame without the page is a true negative
      ctx.fillStyle = 'rgba(40,40,40,0.8)';
      for (let l = 0; l < 12; l++) ctx.fillRect(24, 30 + l * 28, r.int(100, 250), 5);
      ctx.restore();
    }
    // cables and pens
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = i % 2 ? '#111' : '#223'; ctx.lineWidth = r.int(8, 16);
      ctx.beginPath();
      ctx.moveTo(r.int(0, FRAME_W), r.int(0, FRAME_H));
      ctx.bezierCurveTo(r.int(0, FRAME_W), r.int(0, FRAME_H), r.int(0, FRAME_W), r.int(0, FRAME_H), r.int(0, FRAME_W), r.int(0, FRAME_H));
      ctx.stroke();
    }
    grain(ctx, r, 5);
  },
  carpet: (ctx, r) => {
    ctx.fillStyle = `rgb(${110 + r.int(0, 30)},${90 + r.int(0, 30)},${70 + r.int(0, 30)})`;
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    grain(ctx, r, 18);
  },
};

function grain(ctx, r, sigma) {
  const img = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = gauss(r) * sigma;
    d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n);
  }
  ctx.putImageData(img, 0, 0);
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function gauss(r) {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Background taxonomy value per source
const BG_CLASS = {
  'white-table': 'plain-similar', 'dark-cloth': 'plain-contrast', 'grey-mat': 'plain-contrast', tiles: 'textured',
  'desk-clutter': 'cluttered', carpet: 'textured',
};
function classifyPhotoBg(name) {
  if (/pine|wood|desk/.test(name)) return 'textured';
  if (/dark|black/.test(name)) return 'dark';
  if (/white|light/.test(name)) return 'plain-similar';
  if (/clutter|keyboard/.test(name)) return 'cluttered';
  return 'textured';
}

async function drawBackground(ctx, r, choice) {
  if (choice.kind === 'procedural') {
    PROCEDURAL[choice.name](ctx, r);
  } else {
    const img = await loadImage(choice.file);
    // cover the frame, random crop offset
    const s = Math.max(FRAME_W / img.width, FRAME_H / img.height) * (1 + r() * 0.3);
    const w = img.width * s, h = img.height * s;
    const ox = -r() * Math.max(0, w - FRAME_W), oy = -r() * Math.max(0, h - FRAME_H);
    ctx.drawImage(img, ox, oy, w, h);
    if (h < FRAME_H) { // tile vertically when the crop is short
      ctx.drawImage(img, ox, oy + h, w, h);
      ctx.drawImage(img, ox, oy + 2 * h, w, h);
    }
  }
}

// ---------------------------------------------------------------------------
// Compositing

async function loadPage(pagesIndex, pageId) {
  const entry = pagesIndex.pages.find((p) => p.id === pageId);
  const img = await loadImage(path.join(root, 'bench', 'pages', entry.png));
  return { entry, img };
}

function warpPageOnto(frame, pageCanvas, H) {
  // For every frame pixel inside the projected quad, inverse-map to the page and sample bilinearly.
  const Hinv = invert3(H);
  const fd = frame.data;
  const pd = pageCanvas.getContext('2d').getImageData(0, 0, pageCanvas.width, pageCanvas.height).data;
  const pw = pageCanvas.width, ph = pageCanvas.height;
  const quad = [apply(H, 0, 0), apply(H, pw, 0), apply(H, pw, ph), apply(H, 0, ph)];
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(FRAME_W - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(FRAME_H - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = apply(Hinv, x + 0.5, y + 0.5);
      const u = p.x - 0.5, v = p.y - 0.5;
      if (u < -0.5 || v < -0.5 || u > pw - 0.5 || v > ph - 0.5) continue;
      const ux = Math.max(0, Math.min(pw - 1.001, u)), vy = Math.max(0, Math.min(ph - 1.001, v));
      const ix = Math.floor(ux), iy = Math.floor(vy), fx = ux - ix, fy = vy - iy;
      const i00 = (iy * pw + ix) * 4, i10 = i00 + 4, i01 = i00 + pw * 4, i11 = i01 + 4;
      const o = (y * FRAME_W + x) * 4;
      for (let c = 0; c < 3; c++) {
        fd[o + c] = (pd[i00 + c] * (1 - fx) + pd[i10 + c] * fx) * (1 - fy) + (pd[i01 + c] * (1 - fx) + pd[i11 + c] * fx) * fy;
      }
      // soft edge: paper has a faint shadow line
      const edge = Math.min(u, v, pw - u, ph - v);
      if (edge < 1.5) { const k = 0.6 + 0.4 * (edge / 1.5); fd[o] *= k; fd[o + 1] *= k; fd[o + 2] *= k; }
    }
  }
  return quad;
}

function paperTint(ctx, w, h, r) {
  // slightly off-white paper with a gentle shading so the page is not pure #fff
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const tint = [255 - r.int(0, 8), 255 - r.int(2, 10), 255 - r.int(6, 18)];
  for (let i = 0; i < d.length; i += 4) {
    d[i] = (d[i] * tint[0]) / 255; d[i + 1] = (d[i + 1] * tint[1]) / 255; d[i + 2] = (d[i + 2] * tint[2]) / 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Degradations on the composited frame (ImageData in place)

function shadowGradient(img, r, strength) {
  const d = img.data;
  const ang = r() * Math.PI * 2, cx = Math.cos(ang), cy = Math.sin(ang);
  for (let y = 0; y < FRAME_H; y++) for (let x = 0; x < FRAME_W; x++) {
    const t = ((x / FRAME_W) * cx + (y / FRAME_H) * cy + 1) / 2; // 0..1
    const k = 1 - strength * t;
    const o = (y * FRAME_W + x) * 4;
    d[o] *= k; d[o + 1] *= k; d[o + 2] *= k;
  }
}

function hardShadow(img, r, quad) {
  // a band of shadow (phone/hand) crossing the page, soft edge
  const d = img.data;
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4, cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const ang = r() * Math.PI, nx = Math.cos(ang), ny = Math.sin(ang);
  const width = r.int(250, 600), soft = r.int(20, 60), dark = 0.45 + r() * 0.2;
  const off = (r() - 0.5) * 300;
  for (let y = 0; y < FRAME_H; y++) for (let x = 0; x < FRAME_W; x++) {
    const dist = (x - cx) * nx + (y - cy) * ny - off;
    let k = 1;
    if (dist > -width / 2 - soft && dist < width / 2 + soft) {
      const e = Math.min(dist + width / 2 + soft, width / 2 + soft - dist) / soft;
      k = 1 - (1 - dark) * Math.min(1, Math.max(0, e));
    }
    if (k < 1) { const o = (y * FRAME_W + x) * 4; d[o] *= k; d[o + 1] *= k; d[o + 2] *= k; }
  }
}

function glare(img, r, quad) {
  const d = img.data;
  const i = r.int(0, 3);
  const cx = quad[i].x * 0.4 + (quad.reduce((s, p) => s + p.x, 0) / 4) * 0.6;
  const cy = quad[i].y * 0.4 + (quad.reduce((s, p) => s + p.y, 0) / 4) * 0.6;
  const rad = r.int(180, 420), peak = 150 + r.int(0, 100);
  for (let y = Math.max(0, cy - rad * 2); y < Math.min(FRAME_H, cy + rad * 2); y++) for (let x = Math.max(0, cx - rad * 2); x < Math.min(FRAME_W, cx + rad * 2); x++) {
    const dx = x - cx, dy = y - cy;
    const g = Math.exp(-(dx * dx + dy * dy) / (2 * rad * rad)) * peak;
    if (g < 1) continue;
    const o = ((y | 0) * FRAME_W + (x | 0)) * 4;
    d[o] = clamp(d[o] + g); d[o + 1] = clamp(d[o + 1] + g); d[o + 2] = clamp(d[o + 2] + g * 0.95);
  }
}

function lowLight(img, r) {
  const d = img.data;
  const k = 0.25 + r() * 0.2, warm = r() < 0.7;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i] * k * (warm ? 1.1 : 0.95); d[i + 1] = d[i + 1] * k; d[i + 2] = d[i + 2] * k * (warm ? 0.8 : 1.1);
  }
}

function colourCast(img, r) {
  const d = img.data;
  const cast = [1 + (r() - 0.5) * 0.25, 1 + (r() - 0.5) * 0.12, 1 + (r() - 0.5) * 0.3];
  for (let i = 0; i < d.length; i += 4) { d[i] = clamp(d[i] * cast[0]); d[i + 1] = clamp(d[i + 1] * cast[1]); d[i + 2] = clamp(d[i + 2] * cast[2]); }
}

function noise(img, r, sigma) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = gauss(r) * sigma;
    d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n + gauss(r) * sigma * 0.3); d[i + 2] = clamp(d[i + 2] + n);
  }
}

function boxBlur(img, radiusX, radiusY) {
  // separable box blur, two passes ≈ triangular kernel
  const w = FRAME_W, h = FRAME_H;
  const src = img.data;
  const tmp = new Float32Array(src.length);
  const pass = (from, to, rx, ry) => {
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0, cnt = 0;
        for (let x = -rx; x <= rx; x++) { const xx = Math.min(w - 1, Math.max(0, x)); acc += from[(y * w + xx) * 4 + c]; cnt++; }
        for (let x = 0; x < w; x++) {
          to[(y * w + x) * 4 + c] = acc / cnt;
          const xo = Math.min(w - 1, Math.max(0, x - rx)), xi = Math.min(w - 1, Math.max(0, x + rx + 1));
          acc += from[(y * w + xi) * 4 + c] - from[(y * w + xo) * 4 + c];
        }
      }
    }
    if (ry > 0) {
      const col = new Float32Array(h);
      for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
        for (let y = 0; y < h; y++) col[y] = to[(y * w + x) * 4 + c];
        let acc = 0, cnt = 0;
        for (let y = -ry; y <= ry; y++) { acc += col[Math.min(h - 1, Math.max(0, y))]; cnt++; }
        for (let y = 0; y < h; y++) {
          to[(y * w + x) * 4 + c] = acc / cnt;
          const yo = Math.min(h - 1, Math.max(0, y - ry)), yi = Math.min(h - 1, Math.max(0, y + ry + 1));
          acc += col[yi] - col[yo];
        }
      }
    }
  };
  pass(src, tmp, radiusX, radiusY);
  for (let i = 0; i < src.length; i += 4) { src[i] = tmp[i]; src[i + 1] = tmp[i + 1]; src[i + 2] = tmp[i + 2]; }
}

function drawHand(ctx, r, quad) {
  // a hand holding one corner: skin-coloured palm ellipse plus two fingers reaching over the page
  const i = r.int(0, 3);
  const corner = quad[i];
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4, cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const dirx = corner.x - cx, diry = corner.y - cy;
  const len = Math.hypot(dirx, diry) || 1;
  const ux = dirx / len, uy = diry / len;
  const skin = `rgb(${200 + r.int(0, 40)},${150 + r.int(0, 40)},${120 + r.int(0, 40)})`;
  ctx.fillStyle = skin;
  ctx.save();
  ctx.translate(corner.x + ux * 120, corner.y + uy * 120);
  ctx.rotate(Math.atan2(uy, ux));
  ctx.beginPath(); ctx.ellipse(0, 0, 170, 130, 0, 0, Math.PI * 2); ctx.fill();
  for (let f = -1; f <= 1; f += 2) {
    ctx.beginPath();
    ctx.ellipse(-230, f * 45, 110, 34, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPen(ctx, r, quad) {
  // a pen lying across one edge of the page
  const i = r.int(0, 3);
  const a = quad[i], b = quad[(i + 1) % 4];
  const t = 0.3 + r() * 0.4;
  const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
  const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2 + (r() - 0.5) * 0.6;
  ctx.save();
  ctx.translate(px, py); ctx.rotate(ang);
  ctx.fillStyle = r() < 0.5 ? '#1a1a2e' : '#8a1c1c';
  ctx.fillRect(-14, -260, 28, 520);
  ctx.fillStyle = '#c0c0c0'; ctx.fillRect(-14, 200, 28, 60);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Case plan: which conditions each case gets. Cycles with coprime periods keep
// the hard values spread across backgrounds and lighting, each ≥ 20 of 100.

const BACKGROUND_CYCLE = ['plain-contrast', 'plain-similar', 'cluttered', 'textured', 'dark'];
const LIGHT_CYCLE = ['even', 'low', 'harsh-shadow', 'glare', 'mixed-colour'];

export function planPositive(i, pages, bgChoices) {
  const r = rng(0xc0ffee + i);
  const background = BACKGROUND_CYCLE[i % 5];
  const lighting = LIGHT_CYCLE[Math.floor(i / 5) % 5];
  const occlusion = i % 4 === 1 ? 'hand' : i % 4 === 3 ? 'object' : 'none';
  const partial = i % 9 === 2 || i % 9 === 6 || i % 9 === 8;
  const blur = i % 7 === 3 ? 'motion' : i % 7 === 5 ? 'focus' : i % 7 === 1 ? 'mild' : 'none';
  const orientation = [0, 0, 0, 90, 180, 270][i % 6];
  const page = pages[(i * 7) % pages.length];
  const bgs = bgChoices.filter((b) => b.class === background);
  const bg = bgs[r.int(0, bgs.length - 1)];
  const tilt = i % 5 === 0 ? 0.03 : i % 5 === 1 ? 0.15 : i % 5 === 2 ? 0.32 : i % 5 === 3 ? 0.5 : 0.22;
  return { i, background, lighting, occlusion, partial, blur, orientation, page, bg, tilt };
}

export function planNegative(i, bgChoices, pages) {
  const r = rng(0xbadcafe + i);
  const kinds = ['empty', 'empty', 'trap', 'clutter', 'tiny-doc'];
  const kind = kinds[i % kinds.length];
  const bgClass = kind === 'trap' ? 'textured' : kind === 'clutter' ? 'cluttered' : BACKGROUND_CYCLE[i % 5];
  let bgs = bgChoices.filter((b) => (kind === 'trap' ? b.name === 'tiles' : b.class === bgClass));
  if (!bgs.length) bgs = bgChoices;
  const bg = bgs[r.int(0, bgs.length - 1)];
  const lighting = LIGHT_CYCLE[Math.floor(i / 5) % 5];
  return { i, kind, bg, lighting, page: pages[(i * 5) % pages.length] };
}

function skewLabel(tilt) { return tilt < 0.06 ? 'none' : tilt < 0.2 ? 'mild' : tilt < 0.4 ? 'strong' : 'extreme'; }
// In a 9:16 frame a portrait A4 page can cover at most ~0.73 of the area, so 'fills' starts at 0.5.
function distanceLabel(areaFrac, partial) { return partial ? 'partial' : areaFrac > 0.5 ? 'fills' : areaFrac > 0.28 ? 'normal' : 'far'; }

// ---------------------------------------------------------------------------
// Rendering a case

async function renderPositive(plan, pagesIndex, seed) {
  const r = rng((seed * 7919 + plan.i) >>> 0);
  const canvas = createCanvas(FRAME_W, FRAME_H);
  const ctx = canvas.getContext('2d');
  await drawBackground(ctx, r, plan.bg);

  // page raster, rotated for the orientation condition and pre-downscaled to about its on-frame size
  const { entry, img } = await loadPage(pagesIndex, plan.page.id);
  const [wMm, hMm] = entry.sizeMm;
  const rot = plan.orientation;
  const fills = !plan.partial && plan.i % 3 === 0;
  const areaFrac = plan.partial ? 0.75 + r() * 0.3 : fills ? 0.72 : [0, 0.45, 0.22][plan.i % 3] * (0.85 + r() * 0.3);
  const swap = rot === 90 || rot === 270;
  const pageWmm = swap ? hMm : wMm, pageHmm = swap ? wMm : hMm;
  const cx = FRAME_W / 2 + (plan.partial ? (r() - 0.5) * 500 : fills ? (r() - 0.5) * 30 : (r() - 0.5) * 160);
  const cy = FRAME_H / 2 + (plan.partial ? (r() - 0.5) * 900 : fills ? (r() - 0.5) * 60 : (r() - 0.5) * 300);
  let quad = projectPage(pageWmm, pageHmm, {
    tiltX: (r() - 0.5) * 2 * plan.tilt * (fills ? 0.5 : 1), tiltY: (r() - 0.5) * 2 * plan.tilt * (fills ? 0.5 : 1), roll: (r() - 0.5) * (plan.tilt < 0.1 || fills ? 0.08 : 0.6),
    cx, cy, areaFrac: Math.min(areaFrac, plan.partial ? 1.2 : 0.85),
  });
  if (plan.partial) {
    // push the page past a frame edge
    const side = r.int(0, 3);
    const shift = [[0, -350], [350, 0], [0, 350], [-350, 0]][side];
    quad = quad.map((p) => ({ x: p.x + shift[0], y: p.y + shift[1] }));
    quad = limitOvershoot(quad, 0.4);
  } else {
    quad = fitInFrame(quad, 24);
  }
  // target raster size ≈ longest projected edge, capped at the source
  const edge = Math.max(Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y), Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y));
  const scale = Math.min(1, (edge * 1.4) / Math.max(img.width, img.height));
  const pw = Math.max(2, Math.round((swap ? img.height : img.width) * scale));
  const ph = Math.max(2, Math.round((swap ? img.width : img.height) * scale));
  const pageCanvas = createCanvas(pw, ph);
  const pctx = pageCanvas.getContext('2d');
  pctx.imageSmoothingEnabled = true; pctx.imageSmoothingQuality = 'high';
  pctx.translate(pw / 2, ph / 2); pctx.rotate((rot * Math.PI) / 180);
  pctx.drawImage(img, -(swap ? ph : pw) / 2, -(swap ? pw : ph) / 2, swap ? ph : pw, swap ? pw : ph);
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  paperTint(pctx, pw, ph, r);

  const H = solveHomography([{ x: 0, y: 0 }, { x: pw, y: 0 }, { x: pw, y: ph }, { x: 0, y: ph }], quad);
  const frame = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
  warpPageOnto(frame, pageCanvas, H);

  // lighting
  if (plan.lighting === 'even') shadowGradient(frame, r, 0.1 + r() * 0.1);
  if (plan.lighting === 'low') { shadowGradient(frame, r, 0.3); lowLight(frame, r); }
  if (plan.lighting === 'harsh-shadow') { shadowGradient(frame, r, 0.25); hardShadow(frame, r, quad); }
  if (plan.lighting === 'glare') { shadowGradient(frame, r, 0.15); glare(frame, r, quad); }
  if (plan.lighting === 'mixed-colour') { shadowGradient(frame, r, 0.2); colourCast(frame, r); }
  ctx.putImageData(frame, 0, 0);

  // occlusion is drawn on top of the lit page
  if (plan.occlusion === 'hand') drawHand(ctx, r, quad);
  if (plan.occlusion === 'object') drawPen(ctx, r, quad);

  // optics and sensor
  const frame2 = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
  if (plan.blur === 'mild') boxBlur(frame2, 1, 1);
  if (plan.blur === 'focus') boxBlur(frame2, 4 + r.int(0, 4), 4 + r.int(0, 4));
  if (plan.blur === 'motion') {
    const m = 6 + r.int(0, 10);
    if (r() < 0.5) boxBlur(frame2, m, 0);
    else boxBlur(frame2, 0, m);
  }
  noise(frame2, r, plan.lighting === 'low' ? 7 + r() * 6 : 1.5 + r() * 2.5);
  ctx.putImageData(frame2, 0, 0);

  const area = clipArea(quad) / (FRAME_W * FRAME_H);
  const conditions = {
    doc: entry.doc, background: plan.background, lighting: plan.lighting, skew: skewLabel(plan.tilt),
    distance: distanceLabel(area, plan.partial), blur: plan.blur, occlusion: plan.occlusion, device: 'synthetic', orientation: rot,
  };
  const quality = 0.6 + r() * 0.35;
  return { canvas, quad, conditions, entry, quality, areaInFrame: area };
}

async function renderNegative(plan, pagesIndex, seed) {
  const r = rng((seed * 104729 + plan.i) >>> 0);
  const canvas = createCanvas(FRAME_W, FRAME_H);
  const ctx = canvas.getContext('2d');
  await drawBackground(ctx, r, plan.bg);
  let note = `negative: ${plan.kind}`;
  if (plan.kind === 'tiny-doc') {
    // a page occupying under 10 % of the frame
    const { entry, img } = await loadPage(pagesIndex, plan.page.id);
    const quad = projectPage(entry.sizeMm[0], entry.sizeMm[1], { tiltX: (r() - 0.5) * 0.4, tiltY: (r() - 0.5) * 0.4, roll: (r() - 0.5) * 0.5, cx: FRAME_W / 2 + (r() - 0.5) * 400, cy: FRAME_H / 2 + (r() - 0.5) * 800, areaFrac: 0.04 + r() * 0.04 });
    const pw = Math.round(img.width * 0.15), ph = Math.round(img.height * 0.15);
    const pc = createCanvas(pw, ph); const pctx = pc.getContext('2d'); pctx.drawImage(img, 0, 0, pw, ph);
    const H = solveHomography([{ x: 0, y: 0 }, { x: pw, y: 0 }, { x: pw, y: ph }, { x: 0, y: ph }], quad);
    const frame = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
    warpPageOnto(frame, pc, H);
    ctx.putImageData(frame, 0, 0);
    note += ` (${entry.id} under 10 % of frame)`;
  }
  if (plan.kind === 'trap') {
    // a dark rectangle: laptop screen off / picture frame
    ctx.save();
    ctx.translate(FRAME_W / 2 + (r() - 0.5) * 200, FRAME_H / 2 + (r() - 0.5) * 400);
    ctx.rotate((r() - 0.5) * 0.3);
    ctx.fillStyle = '#15151a'; ctx.fillRect(-380, -260, 760, 520);
    ctx.fillStyle = '#0a0a0c'; ctx.fillRect(-350, -230, 700, 460);
    ctx.restore();
    note += ' (dark rectangle, screen off)';
  }
  const frame = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
  if (plan.lighting === 'low') lowLight(frame, r);
  if (plan.lighting === 'harsh-shadow') shadowGradient(frame, r, 0.5);
  if (plan.lighting === 'glare') glare(frame, r, [{ x: FRAME_W / 2, y: FRAME_H / 2 }, { x: FRAME_W / 2, y: FRAME_H / 2 }, { x: FRAME_W / 2, y: FRAME_H / 2 }, { x: FRAME_W / 2, y: FRAME_H / 2 }]);
  if (plan.lighting === 'mixed-colour') colourCast(frame, r);
  noise(frame, r, plan.lighting === 'low' ? 8 : 2);
  ctx.putImageData(frame, 0, 0);
  const conditions = {
    doc: 'none', background: plan.bg.class, lighting: plan.lighting, skew: 'none', distance: plan.kind === 'tiny-doc' ? 'far' : 'normal',
    blur: 'none', occlusion: 'none', device: 'synthetic', orientation: 0,
  };
  return { canvas, quad: null, conditions, note, quality: 0.8 };
}

function previewOf(canvas) {
  const h = Math.round((canvas.height * PREVIEW_W) / canvas.width);
  const c = createCanvas(PREVIEW_W, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, PREVIEW_W, h);
  return c;
}

const normQuad = (quad) => quad.map((p) => [round(p.x / FRAME_W), round(p.y / FRAME_H)]);
const round = (v) => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------------------
// Main

export function backgroundChoices() {
  const photos = photoBackgrounds().map((b) => ({ kind: 'photo', name: b.name, file: b.file, class: classifyPhotoBg(b.name) }));
  const procedural = Object.keys(PROCEDURAL).map((name) => ({ kind: 'procedural', name, class: BG_CLASS[name] }));
  const all = [...photos, ...procedural];
  // 'dark' has no photographed background yet: dark cloth stands in and is labelled so
  if (!all.some((b) => b.class === 'dark')) all.push({ kind: 'procedural', name: 'dark-cloth', class: 'dark' });
  return all;
}

export async function renderCase(index, { seed = 1, positives = 100 } = {}) {
  const pagesIndex = ensurePages(seed);
  const bgChoices = backgroundChoices();
  const pages = pagesIndex.pages.filter((p) => p.doc !== 'business-card' || true);
  if (index < positives) return { ...(await renderPositive(planPositive(index, pages, bgChoices), pagesIndex, seed)), id: caseId('pos', index) };
  return { ...(await renderNegative(planNegative(index - positives, bgChoices, pages), pagesIndex, seed)), id: caseId('neg', index - positives) };
}

const caseId = (kind, i) => `synth-${kind}-${String(i).padStart(3, '0')}`;

function ensurePages(seed) {
  const idx = path.join(root, 'bench', 'pages', 'pages-eval.json');
  if (!fs.existsSync(idx) || JSON.parse(fs.readFileSync(idx, 'utf8')).seed !== seed) generatePages({ seed, set: 'eval', quiet: true });
  return JSON.parse(fs.readFileSync(idx, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(root, args.out);
  const framesDir = path.join(outDir, 'frames', 'synth');
  const previewsDir = path.join(outDir, 'previews', 'synth');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(previewsDir, { recursive: true });

  if (args.one !== null) {
    const c = await renderCase(args.one, args);
    const file = path.join(framesDir, `${c.id}.jpg`);
    fs.writeFileSync(file, c.canvas.toBuffer('image/jpeg', { quality: c.quality }));
    console.log(file, JSON.stringify(c.conditions), c.quad ? JSON.stringify(normQuad(c.quad)) : 'negative');
    return;
  }

  const t0 = Date.now();
  const entries = [];
  const total = args.positives + args.negatives;
  for (let i = 0; i < total; i++) {
    const c = await renderCase(i, args);
    const frameRel = `frames/synth/${c.id}.jpg`;
    const previewRel = `previews/synth/${c.id}.png`;
    fs.writeFileSync(path.join(outDir, frameRel), c.canvas.toBuffer('image/jpeg', { quality: c.quality }));
    fs.writeFileSync(path.join(outDir, previewRel), previewOf(c.canvas).toBuffer('image/png'));
    const entry = {
      id: c.id,
      file: frameRel,
      preview: previewRel,
      generated: true,
      width: FRAME_W, height: FRAME_H,
      quad: c.quad ? normQuad(c.quad) : null,
      split: 'eval',
      capture: { kind: 'synthetic', seed: args.seed, index: i, jpegQuality: Math.round(c.quality * 100) / 100 },
      label: { method: 'synthetic', verified: true },
      conditions: c.conditions,
      source: { name: 'QuickScan synth.mjs', url: 'bench/tools/synth.mjs', licence: 'project', citation: '' },
      notes: c.note || `page ${c.entry.id} on ${planLabel(i, args)}`,
    };
    if (c.entry) { entry.text = c.entry.text.replace(/^bench\/corpus\//, ''); entry.docMm = c.entry.sizeMm; }
    entries.push(entry);
    if (i % 10 === 9) process.stdout.write(`${i + 1}/${total} `);
  }
  console.log(`\nrendered ${total} cases in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  if (args.manifest) mergeManifest(path.join(outDir, 'manifest.json'), entries);
  summarise(entries);
}

function planLabel(i, args) {
  if (i < args.positives) { const p = planPositive(i, [{ id: '?' }], backgroundChoices()); return `${p.bg.kind}:${p.bg.name}`; }
  return 'background';
}

export function mergeManifest(file, entries) {
  const manifest = mergeManifestEntries(file, entries, (c) => c.id.startsWith('synth-'));
  console.log(`manifest: ${manifest.cases.length} cases (${entries.length} synthetic) → ${path.relative(root, file)}`);
}

function summarise(entries) {
  const pos = entries.filter((e) => e.quad);
  console.log(`positives ${pos.length}, negatives ${entries.length - pos.length}`);
  for (const key of ['background', 'lighting', 'occlusion', 'distance', 'blur', 'skew', 'orientation', 'doc']) {
    const counts = {};
    for (const e of pos) counts[e.conditions[key]] = (counts[e.conditions[key]] || 0) + 1;
    console.log(`  ${key.padEnd(12)} ${Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
