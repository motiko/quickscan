#!/usr/bin/env node
// Stills and clip records from the owner's phone videos (corpus bucket A/B).
//
//   node bench/tools/extract-frames.mjs [--src tests/fixtures/camera/private] [--out bench/corpus] [--private] [--shotlog bench/corpus/clips/shotlog.json]
//
// For every *.MOV|*.mp4 in --src: probes codec, size, rotation and HDR transfer,
// extracts three stills (settle ≈ 1.5 s, mid, end) with ffmpeg — auto-rotation ON
// (the manifest records the rotated size), HLG sources get an SDR approximation
// (`eq=contrast=1.15:saturation=1.2`; a real tone-map needs libzimg, which this
// ffmpeg build lacks) and `capture.hdr: true` — and writes:
//
//   <out>/frames/private/<id>.jpg         stills (gitignored when --private)
//   <out>/clips/<clip id>.json            clip record: timing, frame list, quads to fill
//   manifest entries (merged into <out>/manifest.json) with quad: null and
//   label { method: 'manual', verified: false } until autolabel.mjs proposes and
//   label.html confirms them.
//
// With --private (default when --src is the private folder) entries get
// `private: true`, no preview, and the harness/CI skips them. A shot log
// (`{ "IMG_1525": { "row": 14, "doc": "e-a4-deu-serif11", "conditions": {...}, "inViewAt": 1.0 } }`)
// fills conditions from the shot list; without it, conditions are left for the
// labeller with `notes: "conditions unlabelled"`.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeManifestEntries } from './manifest-util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const args = { src: 'tests/fixtures/camera/private', out: 'bench/corpus', private: null, shotlog: 'bench/corpus/clips/shotlog.json', device: 'iphone-14-pro' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') args.src = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--private') args.private = true;
    else if (a === '--public') args.private = false;
    else if (a === '--shotlog') args.shotlog = argv[++i];
    else if (a === '--device') args.device = argv[++i];
    else throw new Error(`Unknown argument ${a}`);
  }
  if (args.private === null) args.private = /private/.test(args.src);
  return args;
}

export function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,duration,color_transfer,pix_fmt:stream_side_data=rotation:format_tags=com.apple.quicktime.model,com.apple.quicktime.software,creation_time',
    '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const s = j.streams[0];
  const rotation = Number((s.side_data_list || []).find((d) => d.rotation !== undefined)?.rotation ?? 0);
  const [n, d] = s.r_frame_rate.split('/').map(Number);
  const swap = Math.abs(rotation) % 180 === 90;
  return {
    codec: s.codec_name, pixFmt: s.pix_fmt, fps: n / d, duration: Number(s.duration),
    width: swap ? s.height : s.width, height: swap ? s.width : s.height, rotation,
    hdr: s.color_transfer === 'arib-std-b67' || s.color_transfer === 'smpte2084',
    transfer: s.color_transfer, model: j.format?.tags?.['com.apple.quicktime.model'], software: j.format?.tags?.['com.apple.quicktime.software'],
    created: j.format?.tags?.creation_time,
  };
}

export function extractStill(file, t, outFile, { hdr }) {
  const vf = hdr ? 'eq=contrast=1.15:saturation=1.2' : 'null';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '2', outFile], { stdio: 'inherit' });
}

function timestamps(duration) {
  if (duration < 0.6) return [{ k: 'settle', t: Math.max(0, duration / 2 - 0.05) }];
  const settle = Math.min(1.5, duration * 0.4);
  const mid = duration * 0.62;
  const end = Math.max(mid + 0.3, duration - 0.35);
  return [{ k: 'settle', t: round2(settle) }, { k: 'mid', t: round2(mid) }, { k: 'end', t: round2(end) }];
}
const round2 = (v) => Math.round(v * 100) / 100;

function clipIdFor(file) {
  const base = path.basename(file).replace(/\.\w+$/, '');
  return `own-${base.replace(/^IMG_/i, '').toLowerCase()}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const srcDir = path.resolve(root, args.src);
  const outDir = path.resolve(root, args.out);
  const framesDir = path.join(outDir, 'frames', args.private ? 'private' : 'own');
  const clipsDir = path.join(outDir, 'clips');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(clipsDir, { recursive: true });
  const shotlog = fs.existsSync(path.resolve(root, args.shotlog)) ? JSON.parse(fs.readFileSync(path.resolve(root, args.shotlog), 'utf8')) : {};

  const files = fs.readdirSync(srcDir).filter((f) => /\.(mov|mp4)$/i.test(f)).sort();
  if (!files.length) { console.error(`no videos in ${srcDir}`); process.exit(1); }

  const entries = [];
  for (const f of files) {
    const file = path.join(srcDir, f);
    const info = probe(file);
    const clipId = clipIdFor(f);
    const log = shotlog[path.basename(f, path.extname(f))] || {};
    const frames = [];
    for (const { k, t } of timestamps(info.duration)) {
      const id = `${clipId}-${k}`;
      const rel = `frames/${args.private ? 'private' : 'own'}/${id}.jpg`;
      const abs = path.join(outDir, rel);
      if (!fs.existsSync(abs)) extractStill(file, t, abs, info);
      frames.push({ t, id, file: rel, quad: null });
      const entry = {
        id,
        ...(args.private ? { private: true, file: rel } : { file: rel, preview: `previews/own/${id}.png` }),
        width: info.width, height: info.height,
        quad: null,
        split: 'eval',
        capture: { kind: 'video-frame', codec: info.codec, hdr: info.hdr, t, clip: clipId, ...(info.hdr ? { tonemap: 'eq-approx' } : {}) },
        label: { method: 'manual', verified: false },
        conditions: log.conditions ?? { doc: 'a4-text', background: 'textured', lighting: 'low', skew: 'mild', distance: 'normal', blur: 'none', occlusion: 'none', device: args.device, orientation: 0 },
        source: { name: 'owner capture', url: '', licence: 'private', citation: '' },
        notes: [log.conditions ? `shot list row ${log.row}` : 'conditions unlabelled (defaults from the first session: pine desk, warm lamp)', info.model ? `${info.model}, ${info.software}` : '', info.hdr ? `HLG ${info.transfer} source, SDR approximation` : ''].filter(Boolean).join('; '),
      };
      if (log.doc) { entry.text = `text/${log.doc}.txt`; }
      if (log.docMm) entry.docMm = log.docMm;
      entries.push(entry);
    }
    const clip = {
      id: clipId, private: args.private, source: path.relative(root, file).split(path.sep).join('/'),
      fps: Math.round(info.fps * 1000) / 1000, duration: info.duration, width: info.width, height: info.height, rotation: info.rotation,
      codec: info.codec, hdr: info.hdr, device: info.model ?? args.device, created: info.created,
      inViewAt: log.inViewAt ?? 0, stillAt: log.stillAt ?? null, notes: log.notes ?? 'document in view from the first frame (no off-document lead-in)',
      frames,
    };
    fs.writeFileSync(path.join(clipsDir, `${clipId}.json`), JSON.stringify(clip, null, 2) + '\n');
    console.log(`${clipId}: ${info.codec} ${info.width}×${info.height} ${info.fps.toFixed(0)} fps ${info.duration.toFixed(2)} s${info.hdr ? ' HDR(HLG)' : ''} rot ${info.rotation} → ${frames.length} stills`);
  }
  mergeManifestEntries(path.join(outDir, 'manifest.json'), entries, (c) => entries.some((e) => e.id === c.id));
  console.log(`${entries.length} stills, ${files.length} clip records → ${path.relative(root, outDir)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
