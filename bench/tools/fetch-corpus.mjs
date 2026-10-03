#!/usr/bin/env node
// Fetches the benchmark corpus media that is not committed and samples public datasets into committed cases.
//
//   node bench/tools/fetch-corpus.mjs                       download every manifest case with a `remote` entry
//   node bench/tools/fetch-corpus.mjs --sample smartdoc     SmartDoc 2015 ch. 1 frames (CC BY 4.0), 60 cases
//   node bench/tools/fetch-corpus.mjs --sample cord         CORD v2 receipts, test split (CC BY 4.0), 20 cases
//   node bench/tools/fetch-corpus.mjs --sample midv         MIDV-500 ID frames, one document type (CC BY-SA 2.5), 20 cases
//
// Options: --seed <n> (default 1), --tmp <dir> (downloads and scratch, default $TMPDIR/quickscan-corpus),
// --root <dir> (corpus directory, default bench/corpus). Samplers are deterministic: the same seed yields the
// same ids, pixels and manifest entries, so re-running is a no-op apart from the download cache.
//
// Only Node built-ins and the `canvas` package are used. curl is needed for FTP (MIDV-500) and ffmpeg to
// decode MIDV's TIFF frames; both are checked before use. Manifest schema: .claude/skills/scanner-bench/SKILL.md.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCanvas, loadImage } from 'canvas';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

// Committed frames: long edge and JPEG quality. 1600 px keeps the 100 sampled frames plus previews under ~45 MB;
// detection runs on 320 px previews and the quads are normalised, so the pixel size of `file` is not load-bearing.
const MAX_EDGE = 1920;
const JPEG_QUALITY = 0.9;
const PREVIEW_WIDTH = 320;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 25 * 60 * 1000;

const SMARTDOC = {
  name: 'SmartDoc 2015',
  url: 'https://github.com/jchazalon/smartdoc15-ch1-dataset',
  licence: 'CC BY 4.0',
  citation:
    'J.-C. Burie, J. Chazalon, M. Coustaty, S. Eskenazi, M. M. Luqman, M. Mehri, N. Nayef, J.-M. Ogier, S. Prum, M. Rusiñol: "ICDAR2015 Competition on Smartphone Document Capture and OCR (SmartDoc)", ICDAR 2015',
  frames: 'https://github.com/jchazalon/smartdoc15-ch1-dataset/releases/download/v2.0.0/frames.tar.gz',
  framesSha256: '3acb8be143fc86c507d90d298097cba762e91a3abf7e2d35ccd5303e13a79eae',
  fallback: 'https://zenodo.org/records/1230217',
  // What the five backgrounds look like (checked on the frames; the dataset itself only numbers them).
  backgrounds: {
    background01: ['plain-contrast', 'wooden table'],
    background02: ['plain-contrast', 'grey round table, table edge in frame'],
    background03: ['textured', 'speckled mauve table'],
    background04: ['plain-similar', 'pale cream table, low contrast with the page'],
    background05: ['cluttered', 'desk with mouse, cup, cables and other papers'],
  },
};

const CORD = {
  name: 'CORD v2',
  url: 'https://huggingface.co/datasets/naver-clova-ix/cord-v2',
  licence: 'CC BY 4.0',
  citation:
    'S. Park, S. Shin, B. Lee, J. Lee, J. Surh, M. Seo, H. Lee: "CORD: A Consolidated Receipt Dataset for Post-OCR Parsing", Document Intelligence Workshop at NeurIPS 2019',
  rows: 'https://datasets-server.huggingface.co/rows?dataset=naver-clova-ix/cord-v2&config=default&split=test&offset=0&length=100',
  count: 20,
};

const MIDV = {
  name: 'MIDV-500',
  url: 'ftp://smartengines.com/midv-500/',
  licence: 'CC BY-SA 2.5',
  citation:
    'V. V. Arlazarov, K. Bulatov, T. Chernov, V. L. Arlazarov: "MIDV-500: A Dataset for Identity Documents Analysis and Recognition on Mobile Devices in Video Stream", Computer Optics 43(5), 2019, 818–824, doi:10.18287/2412-6179-2019-43-5-818-824',
  dataset: 'ftp://smartengines.com/midv-500/dataset/',
  md5: 'ftp://smartengines.com/midv-500/md5.txt',
  sourcesPdf: 'ftp://smartengines.com/midv-500/documents.pdf',
  legalcode: 'https://creativecommons.org/licenses/by-sa/2.5/legalcode',
  frameWidth: 1080,
  frameHeight: 1920,
  perCondition: 4, // 2 frames from each of the two device clips
  // First letter of a clip code (readme.txt §2).
  conditions: {
    T: ['table', 'plain-contrast', 'none'],
    K: ['keyboard', 'cluttered', 'none'],
    H: ['hand', 'plain-contrast', 'hand'],
    P: ['partial', 'plain-contrast', 'none'],
    C: ['clutter', 'cluttered', 'none'],
  },
  devices: { A: 'Apple iPhone 5', S: 'Samsung Galaxy S3 (GT-I9300)' },
  // ISO/IEC 7810 sizes in mm by the size class named in documents.pdf.
  sizes: { 'card-size': [85.6, 54], 'td2-size': [105, 74], 'td3-size': [125, 88] },
};

// Transcribed from ftp://smartengines.com/midv-500/documents.pdf ("MIDV-500 Source images"): the Wikimedia
// Commons file each printed document was made from and its credits (author / uploader / host).
const MIDV_SOURCES = {
  1: ['Albanian ID Card', 'card-size', 'https://en.wikipedia.org/wiki/File:Leternjoftimi_shqiptar_biometrik...jpg', 'Government of Albania / Twofortnights / Wikimedia Commons'],
  2: ['Austrian Driving Licence (new)', 'card-size', 'https://commons.wikimedia.org/wiki/File:A_Licence_2013_Front.jpg', 'Republik Österreich, Bundesministeriums für Verkehr, Innovation und Technologie / Lumu / Wikimedia Commons'],
  3: ['Austrian Driving Licence (old)', 'card-size', 'https://en.wikipedia.org/wiki/File:ATdrivinglicencefront.png', 'Austrian Government / Lumu / Wikimedia Commons'],
  4: ['Austrian ID Card', 'card-size', 'https://commons.wikimedia.org/wiki/File:Austrian_ID_card.jpg', 'Emu / Gugganij / Wikimedia Commons'],
  5: ['Azerbaijani Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:The_data_page_of_the_Azerbaijani_biometric_passport.jpg', 'Government of Azerbaijan / Twofortnights / Wikimedia Commons'],
  6: ['Brazilian Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:Brazil_passport_data_page.jpg', 'Government of Brazil / Twofortnights / Wikimedia Commons'],
  7: ['Chilean ID Card', 'card-size', 'https://commons.wikimedia.org/wiki/File:El_ejemplo_de_Cedula_identidad_Chile_2013.jpg', 'Civil Registry and Identification Service of Chile / Rec79 / Wikimedia Commons'],
  8: ['Chinese Home Return Permit', 'card-size', 'https://en.wikipedia.org/wiki/File:Home_Return_Permit_New.jpg', 'Exit Entry Administration of the Ministry of Public Security of the People Republic of China / Charmless Man / Wikimedia Commons'],
  9: ['Chinese ID Card', 'card-size', 'https://en.wikipedia.org/wiki/File:The_People%27s_Republic_of_China_resident_identity_card_(SAMPLE).png', 'Discovery23 / Discovery23 / Wikimedia Commons'],
  10: ['Czech ID Card', 'card-size', 'https://commons.wikimedia.org/wiki/File:ID-card_CZ_2012.jpg', 'Ministerstvo vnitra České republiky / Torf / Wikimedia Commons'],
  11: ['Czech Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:Czech_passport_2006_MRZ_data.jpg', 'Dan Lukes / Magnus Manske / Wikimedia Commons'],
  12: ['German Driving Licence (new)', 'card-size', 'https://en.wikipedia.org/wiki/File:DE_Licence_2013_Front.jpg', 'Bundesrepublik Deutschland, Bundesministerium des Innern / JBFirefox / Wikimedia Commons'],
  13: ['German Driving Licence (old)', 'card-size', 'https://commons.wikimedia.org/wiki/File:DE_licence_front.jpg', 'Bundesrepublik Deutschland, Bundesministerium des Innern / Doco / Wikimedia Commons'],
  14: ['German ID Card (new)', 'card-size', 'https://commons.wikimedia.org/wiki/File:Mustermann_nPA.jpg', 'Bundesrepublik Deutschland, Bundesministerium des Innern / Komischn / Wikimedia Commons'],
  15: ['German ID Card (old)', 'td2-size', 'https://en.wikipedia.org/wiki/File:MustermannPA.jpg', 'Bundesrepublik Deutschland, Bundesministerium des Innern / Doco / Wikimedia Commons'],
  16: ['German Passport (new)', 'td3-size', 'https://en.wikipedia.org/wiki/File:Mustermann_Reisepass_2017.jpg', 'Bundesrepublik Deutschland, Bundesministerium des Innern / Lumu / Wikimedia Commons'],
  17: ['German Passport (old)', 'td3-size', 'https://en.wikipedia.org/wiki/File:Mustermann_Reisepass_2007.jpg', 'Bundesrepublik Deutschland, Bundesministerium des Innern / Lumu / Wikimedia Commons'],
  18: ['Algerian Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:Passeport_biom%C3%A9trique_alg%C3%A9rien_page_2-3.jpg', 'Reda Kerbouche (User:Vikoula5) / Reda Kerbouche / Wikimedia Commons'],
  19: ['Spanish Driving Licence', 'card-size', 'https://en.wikipedia.org/wiki/File:Permiso_de_conducir_plastificado.jpg', 'Joaquinceb / Joaquinceb / Wikimedia Commons'],
  20: ['Spanish ID Card (new)', 'card-size', 'https://en.wikipedia.org/wiki/File:DNIe3.0_Spanish_ID_Card.png', 'Viollits / Viollits / Wikimedia Commons'],
  21: ['Spanish ID Card (old)', 'card-size', 'https://commons.wikimedia.org/wiki/File:DNI-ID_card.jpg', 'Tuerto-O / Tuerto-O / Wikimedia Commons'],
  22: ['Estonian ID Card', 'card-size', 'https://commons.wikimedia.org/wiki/File:Estonian_identity_card_front.png', 'Estonian Government / Bonus bon~commonswiki / Wikimedia Commons'],
  23: ['Finnish Driving Licence', 'card-size', 'https://commons.wikimedia.org/wiki/File:Finnish_driver%27s_licence,_front.jpg', 'Finnish Transport Safety Agency / Omegaosiris / Wikimedia Commons'],
  24: ['Finnish ID Card', 'card-size', 'https://commons.wikimedia.org/wiki/File:Finnish_identity_card.png', 'Finnish Government / Bonus bon~commonswiki / Wikimedia Commons'],
  25: ['Greek Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:Greek_passport_biodata_page.png', 'Greek Government / Bonus bon~commonswiki / Wikimedia Commons'],
  26: ['Croatian Driving Licence', 'card-size', 'https://commons.wikimedia.org/wiki/File:Croatian_driving_licence.jpg', 'Croatian Ministry of Interior / Tomi566 / Wikimedia Commons'],
  27: ['Croatian Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:Croatian_passport_data_page.jpg', 'Government of Croatia / Twofortnights / Wikimedia Commons'],
  28: ['Hungarian Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:Hungarian_passport_biodata_page.png', 'Hungarian Government / Twofortnights / Wikimedia Commons'],
  29: ['Iranian Driving Licence', 'card-size', 'https://en.wikipedia.org/wiki/File:%DA%AF%D9%88%D8%A7%D9%87%DB%8C%E2%80%8C%D9%86%D8%A7%D9%85%D9%87_%D8%B1%D8%A7%D9%86%D9%86%D8%AF%DA%AF%DB%8C_-_%D8%B1%D9%88.jpg', 'Ahmadrknowledge / Ahmadrknowledge / Wikimedia Commons'],
  30: ['Italian Driving Licence', 'card-size', 'https://en.wikipedia.org/wiki/File:IT_licence_(front).jpg', 'Istituto Poligrafico e Zecca dello Stato per Ministero delle Infrastrutture e dei Trasporti / Asþont / Wikimedia Commons'],
  31: ['Japanese Driving Licence', 'card-size', 'https://en.wikipedia.org/wiki/File:Driver%27sLicenseJAPAN2012.jpg', 'Shiga Prefecture Public Safety Commission-Own work / MOTOI Kenkichi / Wikimedia Commons'],
  32: ['Latvian Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:LR_Pases_3._lapa.jpg', 'Government of Latvia / Twofortnights / Wikimedia Commons'],
  33: ['Macao ID Card', 'card-size', 'https://en.wikipedia.org/wiki/File:FRONT_OF_MACAU_ID_CARD.jpg', 'Hong Kong Student / Magnus Manske / Wikimedia Commons'],
  34: ['Moldovan Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:PAEMD.jpg', 'Xeex / Xeex~commonswiki / Wikimedia Commons'],
  35: ['Norwegian Driving Licence', 'card-size', 'https://en.wikipedia.org/wiki/File:F%C3%B8rerkort_fremside.jpg', 'Hans-Petter Fjeld / Atluxity / Wikimedia Commons'],
  36: ['Polish Driving Licence', 'card-size', 'https://en.wikipedia.org/wiki/File:PL_driving_license_front.JPG', 'Marcin.sobczyk / Marcin.sobczyk / Wikimedia Commons'],
  37: ['Portuguese ID', 'card-size', 'https://en.wikipedia.org/wiki/File:Cart%C3%A3o_de_Cidad%C3%A3o_Portugu%C3%AAs.jpg', 'Bgmota / Bgmota / Wikimedia Commons'],
  38: ['Romanian Driving Licence', 'card-size', 'https://en.wikipedia.org/wiki/File:RO_licence_front.jpg', 'ES Vic / Magnus Manske / Wikimedia Commons'],
  39: ['Russian Internal Passport', 'td3-size', 'https://commons.wikimedia.org/wiki/File:Pasport_RF.jpg', 'Fnaq / Deerstop / Wikimedia Commons'],
  40: ['Serbian ID Card', 'card-size', 'https://en.wikipedia.org/wiki/File:ChippedSerbianID_face.png', 'Republic of Serbia, Ministry of Interior / GifTagger / Wikimedia Commons'],
  41: ['Serbian Passport', 'td3-size', 'https://commons.wikimedia.org/wiki/File:Passport_of_Serbia_ID.jpg', 'Government of Serbia / Twofortnights / Wikimedia Commons'],
  42: ['Slovak ID Card', 'card-size', 'https://en.wikipedia.org/wiki/File:Slovak_ID_card_2015.jpg', 'Ministry of Interior of the Slovak Republic / Uncle sam205 / Wikimedia Commons'],
  43: ['Turkish ID Card', 'card-size', 'https://en.wikipedia.org/wiki/File:TR_Nat_ID_Card_Front.png', 'TCKK / Probeklein / Wikimedia Commons'],
  44: ['Ukrainian ID Card', 'card-size', 'https://commons.wikimedia.org/wiki/File:Passport_of_the_Citizen_of_Ukraine_(Since_2016).jpg', 'Державна міграційна служба України / Gnesener1900 / Wikimedia Commons'],
  45: ['Ukrainian Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:Ukrainian_biometric_passport_data_page.jpg', "Poligrafkombinat 'Ukraina' / Gnesener1900 / Wikimedia Commons"],
  46: ['Uruguayan Passport', 'td3-size', 'https://en.wikipedia.org/wiki/File:Pasaporte_Uruguayo_-_Especimen.png', 'Direccion Nacional de Identificacion Civil, Gobierno de la Republica Oriental del Uruguay / Twofortnights / Wikimedia Commons'],
  47: ['USA Border Crossing Card', 'card-size', 'https://en.wikipedia.org/wiki/File:Border_Crossing_Card.jpg', 'US Department of State / Twofortnights / Wikimedia Commons'],
  48: ['USA Passport Card', 'card-size', 'https://en.wikipedia.org/wiki/File:Passport_card.jpg', 'US Department of State / Twofortnights / Wikimedia Commons'],
  49: ['USA Social Security Number Card (1982)', 'card-size', 'https://commons.wikimedia.org/wiki/File:Social_security_card_john_q_public.png', 'Social Security Administration / Evrik / Wikimedia Commons'],
  50: ['Interpol ID Card', 'card-size', 'https://en.wikipedia.org/wiki/File:Interpol_ID_card_front.jpg', 'European Communities / Phinn / Wikimedia Commons'],
};

// ---------------------------------------------------------------------------------------------------------------
// Small utilities

function parseArgs(argv) {
  const args = { seed: 1, sample: null, tmp: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') args.sample = argv[++i];
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--tmp') args.tmp = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.seed) || args.seed < 0) throw new Error('--seed must be a non-negative integer');
  return args;
}

/** Seeded PRNG (mulberry32): same seed, same sequence, on every platform. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k distinct integers in [0, n), in draw order. */
function pickDistinct(rng, n, k) {
  if (k > n) throw new Error(`cannot pick ${k} of ${n}`);
  const out = [];
  const seen = new Set();
  while (out.length < k) {
    const i = Math.floor(rng() * n);
    if (!seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

const exists = (p) => access(p).then(() => true, () => false);

async function sha256File(file) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function md5File(file) {
  const hash = createHash('md5');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function hasBinary(name) {
  try {
    await execFileP(name, ['-version']);
    return true;
  } catch (err) {
    return err && err.code !== 'ENOENT';
  }
}

/** Download `url` to `dest` atomically. FTP goes through curl; everything else through fetch. */
async function download(url, dest, { timeoutMs = DOWNLOAD_TIMEOUT_MS, label = url } = {}) {
  await mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const started = Date.now();
  console.log(`  downloading ${label}`);
  if (url.startsWith('ftp://')) {
    if (!(await hasBinary('curl'))) throw new Error('curl is required for FTP downloads (MIDV-500) and was not found');
    await execFileP('curl', ['-sS', '--fail', '--retry', '3', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-o', part, url], {
      maxBuffer: 1024 * 1024,
    });
  } else {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  }
  await rename(part, dest);
  const { size } = await stat(dest);
  console.log(`  ${(size / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

/** Download once; a file that is present and matches the expected hash is kept. */
async function ensureDownload(url, dest, { sha256, md5, ...opts } = {}) {
  const verify = async () => {
    if (sha256) return (await sha256File(dest)) === sha256;
    if (md5) return (await md5File(dest)) === md5;
    return true;
  };
  if (await exists(dest)) {
    if (await verify()) return false;
    console.log(`  ${path.basename(dest)} is present but its hash differs; downloading again`);
    await rm(dest);
  }
  await download(url, dest, opts);
  if (!(await verify())) {
    await rm(dest);
    throw new Error(`${url}: checksum mismatch after download`);
  }
  return true;
}

async function fetchJson(url, cacheFile) {
  if (cacheFile && (await exists(cacheFile))) return JSON.parse(await readFile(cacheFile, 'utf8'));
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (cacheFile) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, text);
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry: quads are [TL, TR, BR, BL]

function orderCorners(points) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  // Angle from the centre runs TL (-135°) → TR (-45°) → BR (45°) → BL (135°).
  return [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;
const normaliseQuad = (quad, w, h) => quad.map(([x, y]) => [round4(x / w), round4(y / h)]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Perspective strength from how unequal opposite sides are. */
function skewFromQuad(quad) {
  const top = dist(quad[0], quad[1]);
  const bottom = dist(quad[3], quad[2]);
  const left = dist(quad[0], quad[3]);
  const right = dist(quad[1], quad[2]);
  const r = Math.max(Math.abs(top - bottom) / Math.max(top, bottom), Math.abs(left - right) / Math.max(left, right));
  return r < 0.05 ? 'none' : r < 0.2 ? 'mild' : r < 0.4 ? 'strong' : 'extreme';
}

/** `plain-contrast` or `plain-similar` from the mean luminance inside the quad against the surround. */
function backgroundFromImage(image, normQuad) {
  const w = 160;
  const h = Math.max(1, Math.round((image.height * w) / image.width));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const poly = normQuad.map(([x, y]) => [x * w, y * h]);
  const inside = (x, y) => {
    let hit = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const sum = [0, 0];
  const n = [0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      const k = inside(x + 0.5, y + 0.5) ? 0 : 1;
      sum[k] += lum;
      n[k]++;
    }
  }
  if (!n[0] || !n[1]) return 'plain-contrast';
  return Math.abs(sum[0] / n[0] - sum[1] / n[1]) < 40 ? 'plain-similar' : 'plain-contrast';
}

/** Share of the frame the document covers; `partial` when a corner lies outside the frame. */
function distanceFromQuad(normQuad) {
  if (normQuad.some(([x, y]) => x < 0 || x > 1 || y < 0 || y > 1)) return 'partial';
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = normQuad[i];
    const [x2, y2] = normQuad[(i + 1) % 4];
    area += x1 * y2 - x2 * y1;
  }
  area = Math.abs(area) / 2;
  return area >= 0.6 ? 'fills' : area >= 0.2 ? 'normal' : 'far';
}

/** How far the content is turned from upright, from the direction of the document's top edge. */
function orientationFromQuad(quad) {
  const deg = (Math.atan2(quad[1][1] - quad[0][1], quad[1][0] - quad[0][0]) * 180) / Math.PI;
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

// ---------------------------------------------------------------------------------------------------------------
// Images

/** Writes the committed JPEG (long edge ≤ MAX_EDGE) and the 320 px PNG preview; returns the JPEG's size. */
async function writeFrame(image, jpegPath, previewPath) {
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  const jpeg = canvas.toBuffer('image/jpeg', { quality: JPEG_QUALITY, progressive: false, chromaSubsampling: true });
  if (jpeg.length > MAX_FILE_BYTES) throw new Error(`${jpegPath}: ${jpeg.length} bytes exceeds the 5 MB limit`);
  await mkdir(path.dirname(jpegPath), { recursive: true });
  await writeFile(jpegPath, jpeg);

  const pw = PREVIEW_WIDTH;
  const ph = Math.round((height * pw) / width);
  const preview = createCanvas(pw, ph);
  const pctx = preview.getContext('2d');
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(canvas, 0, 0, pw, ph);
  await mkdir(path.dirname(previewPath), { recursive: true });
  await writeFile(previewPath, preview.toBuffer('image/png'));
  return { width, height, bytes: jpeg.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest

async function loadManifest(file) {
  if (!(await exists(file))) return { version: 2, cases: [] };
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.version !== 2) throw new Error(`${file}: expected manifest version 2, found ${manifest.version}`);
  return manifest;
}

async function saveManifest(file, manifest) {
  manifest.cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Cases of another source with the same id are never touched. Returns the ids that are free to write. */
function claimIds(manifest, ids, sourceName) {
  const free = [];
  for (const id of ids) {
    const existing = manifest.cases.find((c) => c.id === id);
    if (existing && existing.source?.name !== sourceName) {
      console.warn(`  skipping ${id}: already in the manifest from ${existing.source?.name ?? 'an unknown source'}`);
    } else free.push(id);
  }
  return free;
}

function mergeCases(manifest, cases) {
  for (const c of cases) {
    const i = manifest.cases.findIndex((x) => x.id === c.id);
    if (i < 0) manifest.cases.push(c);
    else manifest.cases[i] = c;
  }
}

function baseCase(id, source, notes) {
  return {
    id,
    split: 'eval',
    capture: { kind: 'dataset' },
    label: { method: 'dataset', verified: true },
    source: { name: source.name, url: source.url, licence: source.licence, citation: source.citation },
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Job 1: remote media

async function fetchRemote(root, manifest) {
  const remote = manifest.cases.filter((c) => c.remote);
  let downloaded = 0;
  let kept = 0;
  const failed = [];
  for (const c of remote) {
    const { url, sha256, path: rel } = c.remote;
    if (!url || !sha256 || !rel) {
      failed.push(`${c.id}: remote needs url, sha256 and path`);
      continue;
    }
    const dest = path.join(root, rel);
    try {
      if (await ensureDownload(url, dest, { sha256, label: `${c.id} ← ${url}` })) downloaded++;
      else kept++;
    } catch (err) {
      failed.push(`${c.id}: ${err.message}`);
    }
  }
  console.log(`Remote media: ${remote.length} case(s), ${downloaded} downloaded, ${kept} already present, ${failed.length} failed`);
  for (const f of failed) console.error(`  ${f}`);
  if (failed.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Job 2a: SmartDoc 2015 Challenge 1

async function sampleSmartdoc({ root, tmp, seed, manifest }) {
  const dir = path.join(tmp, 'smartdoc');
  const tarball = path.join(dir, 'frames.tar.gz');
  console.log('SmartDoc 2015: frames.tar.gz (about 1 GB)');
  try {
    await ensureDownload(SMARTDOC.frames, tarball, { sha256: SMARTDOC.framesSha256, label: 'frames.tar.gz' });
  } catch (err) {
    throw new Error(
      `${err.message}\nThe GitHub release did not come through. The Zenodo record ${SMARTDOC.fallback} holds a 21 MB sample ` +
        '(videos + XML ground truth) that can be cut into frames with ffmpeg, but this sampler only reads the frames repack.',
    );
  }

  // Per-frame metadata and the archive's own README/licence.
  const metaGz = path.join(dir, 'metadata.csv.gz');
  if (!(await exists(metaGz))) await execFileP('tar', ['-xzf', tarball, '-C', dir, 'metadata.csv.gz', 'README.md', 'LICENCE']);
  const { gunzipSync } = await import('node:zlib');
  const csv = gunzipSync(await readFile(metaGz)).toString('utf8').trim().split('\n');
  const header = csv.shift().split(',');
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = csv.map((line) => line.split(','));

  // bg → doctype → model → frames (sorted by frame index)
  const tree = new Map();
  for (const r of rows) {
    const bg = r[col.bg_name];
    const type = r[col.modeltype_name];
    const model = r[col.model_name];
    if (!tree.has(bg)) tree.set(bg, new Map());
    if (!tree.get(bg).has(type)) tree.get(bg).set(type, new Map());
    if (!tree.get(bg).get(type).has(model)) tree.get(bg).get(type).set(model, []);
    tree.get(bg).get(type).get(model).push(r);
  }

  // Two frames per (background, document type), from the middle 60 % of a seed-chosen clip.
  const rng = mulberry32(seed);
  const picks = [];
  for (const bg of [...tree.keys()].sort()) {
    for (const type of [...tree.get(bg).keys()].sort()) {
      const models = [...tree.get(bg).get(type).keys()].sort();
      const chosen = new Set();
      while (chosen.size < 2) {
        const model = models[Math.floor(rng() * models.length)];
        const frames = tree.get(bg).get(type).get(model).sort((a, b) => Number(a[col.frame_index]) - Number(b[col.frame_index]));
        const lo = Math.ceil(frames.length * 0.2);
        const hi = Math.floor(frames.length * 0.8);
        const frame = frames[lo + Math.floor(rng() * (hi - lo))];
        const key = frame[col.image_path];
        if (chosen.has(key)) continue;
        chosen.add(key);
        picks.push({ bg, type, model, row: frame });
      }
    }
  }

  const idFor = (p) => `smartdoc-bg${p.bg.slice(-2)}-${p.model}-${String(p.row[col.frame_index]).padStart(4, '0')}`;
  const free = new Set(claimIds(manifest, picks.map(idFor), SMARTDOC.name));
  const wanted = picks.filter((p) => free.has(idFor(p)));

  // Pull only the chosen frames out of the tarball, in one pass.
  const framesDir = path.join(dir, 'frames');
  const missing = [];
  for (const p of wanted) if (!(await exists(path.join(framesDir, p.row[col.image_path])))) missing.push(p.row[col.image_path]);
  if (missing.length) {
    await mkdir(framesDir, { recursive: true });
    const list = path.join(dir, 'extract-list.txt');
    await writeFile(list, `${missing.join('\n')}\n`);
    console.log(`  extracting ${missing.length} frame(s) from the tarball`);
    await execFileP('tar', ['-xzf', tarball, '-C', framesDir, '-T', list]);
  }

  const cases = [];
  let bytes = 0;
  for (const p of wanted) {
    const r = p.row;
    const id = idFor(p);
    const image = await loadImage(path.join(framesDir, r[col.image_path]));
    const px = [
      [Number(r[col.tl_x]), Number(r[col.tl_y])],
      [Number(r[col.tr_x]), Number(r[col.tr_y])],
      [Number(r[col.br_x]), Number(r[col.br_y])],
      [Number(r[col.bl_x]), Number(r[col.bl_y])],
    ];
    const quad = normaliseQuad(px, image.width, image.height);
    const out = await writeFrame(image, path.join(root, 'frames', `${id}.jpg`), path.join(root, 'previews', `${id}.png`));
    bytes += out.bytes;
    const [background, backgroundNote] = SMARTDOC.backgrounds[p.bg] ?? ['plain-contrast', p.bg];
    const c = baseCase(
      id,
      SMARTDOC,
      `SmartDoc 2015 ch1 ${r[col.image_path]} (${p.type} ${p.model}, Nexus 7 preview frame ${image.width}×${image.height}, resized to ${out.width}×${out.height}). ` +
        `Conditions guessed from dataset metadata: background from the background id (${backgroundNote}); skew, distance and orientation computed from the ground-truth quad; ` +
        'lighting, blur and occlusion are not annotated by the dataset.',
    );
    Object.assign(c, {
      file: `frames/${id}.jpg`,
      preview: `previews/${id}.png`,
      width: out.width,
      height: out.height,
      quad,
      docMm: [Number(r[col.model_width]) / 10, Number(r[col.model_height]) / 10],
      conditions: {
        doc: 'a4-text',
        background,
        lighting: 'even',
        skew: skewFromQuad(px),
        distance: distanceFromQuad(quad),
        blur: 'none',
        occlusion: 'none',
        device: 'dataset:smartdoc15',
        orientation: orientationFromQuad(px),
      },
    });
    cases.push(c);
  }
  mergeCases(manifest, cases);
  console.log(`SmartDoc 2015: ${cases.length} case(s) written, ${(bytes / 1e6).toFixed(1)} MB of frames`);
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------
// Job 2b: CORD v2 receipts (test split)

/** Receipt words in reading order: lines grouped into rows by their y centre, rows top to bottom, words left to right. */
function receiptText(gt) {
  const lines = [];
  for (const line of gt.valid_line ?? []) {
    const words = (line.words ?? [])
      .filter((w) => w.text != null && w.quad)
      .map((w) => {
        const q = w.quad;
        return {
          text: String(w.text).trim(),
          x: (q.x1 + q.x4) / 2,
          y: (q.y1 + q.y2 + q.y3 + q.y4) / 4,
          h: Math.abs((q.y3 + q.y4) / 2 - (q.y1 + q.y2) / 2),
        };
      })
      .filter((w) => w.text)
      .sort((a, b) => a.x - b.x);
    if (!words.length) continue;
    lines.push({
      text: words.map((w) => w.text).join(' '),
      x: Math.min(...words.map((w) => w.x)),
      y: words.reduce((s, w) => s + w.y, 0) / words.length,
      h: words.reduce((s, w) => s + w.h, 0) / words.length,
    });
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const line of lines) {
    const row = rows.at(-1);
    if (row && Math.abs(line.y - row.y) < 0.5 * Math.max(line.h, row.h)) row.items.push(line);
    else rows.push({ y: line.y, h: line.h, items: [line] });
  }
  return `${rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(' ')).join('\n')}\n`;
}

async function sampleCord({ root, tmp, seed, manifest }) {
  const dir = path.join(tmp, 'cord');
  console.log('CORD v2: test split rows via the Hugging Face datasets-server');
  const data = await fetchJson(CORD.rows, path.join(dir, 'rows-test.json'));
  const rows = data.rows
    .map((r) => ({ idx: r.row_idx, image: r.row.image, gt: JSON.parse(r.row.ground_truth) }))
    .filter((r) => r.gt.roi && ['x1', 'y1', 'x2', 'y2', 'x3', 'y3', 'x4', 'y4'].every((k) => typeof r.gt.roi[k] === 'number'))
    .sort((a, b) => a.idx - b.idx);
  console.log(`  ${data.rows.length} rows, ${rows.length} with a receipt outline (roi)`);

  const rng = mulberry32(seed);
  const picks = pickDistinct(rng, rows.length, Math.min(CORD.count, rows.length)).map((i) => rows[i]);
  const idFor = (r) => `cord-test-${String(r.idx).padStart(3, '0')}`;
  const free = new Set(claimIds(manifest, picks.map(idFor), CORD.name));

  const cases = [];
  let bytes = 0;
  for (const r of picks) {
    const id = idFor(r);
    if (!free.has(id)) continue;
    const cached = path.join(dir, `test-${String(r.idx).padStart(3, '0')}.jpg`);
    // The image URLs are signed and expire; the cached copy is what makes a re-run reproducible offline.
    if (!(await exists(cached))) await download(r.image.src, cached, { label: `${id} image` });
    const image = await loadImage(cached);
    if (image.width !== r.image.width || image.height !== r.image.height) {
      throw new Error(`${id}: image is ${image.width}×${image.height}, metadata says ${r.image.width}×${r.image.height}`);
    }
    const roi = r.gt.roi;
    const px = orderCorners([
      [roi.x1, roi.y1],
      [roi.x2, roi.y2],
      [roi.x3, roi.y3],
      [roi.x4, roi.y4],
    ]);
    const quad = normaliseQuad(px, image.width, image.height);
    const out = await writeFrame(image, path.join(root, 'frames', `${id}.jpg`), path.join(root, 'previews', `${id}.png`));
    bytes += out.bytes;
    await mkdir(path.join(root, 'text'), { recursive: true });
    await writeFile(path.join(root, 'text', `${id}.txt`), receiptText(r.gt));
    const c = baseCase(
      id,
      CORD,
      `CORD v2 test image_id ${r.gt.meta?.image_id ?? r.idx} (${image.width}×${image.height}, resized to ${out.width}×${out.height}). ` +
        'Quad from ground_truth.roi; text is valid_line words in reading order (rows by y, then x), so layout-only tokens are absent. ' +
        'Conditions guessed from dataset metadata: skew, distance and orientation computed from the roi; background from the luminance inside vs outside the roi ' +
        '(plain-contrast or plain-similar only); lighting, blur and occlusion are not annotated.',
    );
    Object.assign(c, {
      file: `frames/${id}.jpg`,
      preview: `previews/${id}.png`,
      width: out.width,
      height: out.height,
      quad,
      text: `text/${id}.txt`,
      conditions: {
        doc: 'receipt',
        background: backgroundFromImage(image, quad),
        lighting: 'even',
        skew: skewFromQuad(px),
        distance: distanceFromQuad(quad),
        blur: 'none',
        occlusion: 'none',
        device: 'dataset:cord',
        orientation: orientationFromQuad(px),
      },
    });
    cases.push(c);
  }
  mergeCases(manifest, cases);
  console.log(`CORD v2: ${cases.length} case(s) written, ${(bytes / 1e6).toFixed(1)} MB of frames`);
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------
// Job 2c: MIDV-500 (one document type per run)

async function parseFtpListing(url, cacheFile) {
  if (!(await exists(cacheFile))) await download(url, cacheFile, { label: 'MIDV-500 dataset listing' });
  const text = await readFile(cacheFile, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/).pop())
    .filter((n) => n && /^\d\d_.+\.zip$/.test(n))
    .sort();
}

/** CC BY-SA 2.5 legal code as plain text, from the licence title to the Creative Commons notice. */
function legalcodeToText(html) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const text = body
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr|blockquote|dd|dt)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const start = text.indexOf('Attribution-ShareAlike 2.5 Generic');
  const endMarker = 'Creative Commons may be contacted at';
  const end = text.indexOf(endMarker);
  if (start < 0 || end < 0) throw new Error('unexpected legalcode page layout');
  const tail = text.slice(end);
  const stop = tail.indexOf('creativecommons.org');
  return `${text.slice(start, end)}${stop < 0 ? endMarker : tail.slice(0, stop + 'creativecommons.org'.length)}.\n`;
}

async function writeMidvLicence(midvDir) {
  const file = path.join(midvDir, 'LICENSE-CC-BY-SA-2.5.txt');
  if (await exists(file)) return;
  const res = await fetch(MIDV.legalcode, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${MIDV.legalcode}: HTTP ${res.status}`);
  const text = legalcodeToText(await res.text());
  await mkdir(midvDir, { recursive: true });
  await writeFile(file, `Creative Commons Attribution-ShareAlike 2.5 Generic\n${MIDV.legalcode}\n\n${text}`);
}

async function writeMidvAttribution(midvDir, manifest) {
  const types = new Map();
  for (const c of manifest.cases) {
    if (!c.id.startsWith('midv-')) continue;
    const n = Number(c.id.split('-')[1]);
    if (MIDV_SOURCES[n]) types.set(n, (types.get(n) ?? 0) + 1);
  }
  const lines = [
    '# MIDV-500 frames — attribution',
    '',
    'The frames in this folder (`bench/corpus/frames/midv/`) and their previews (`bench/corpus/previews/midv/`) are',
    'taken from the MIDV-500 dataset and are redistributed under the Creative Commons Attribution-ShareAlike 2.5',
    'Generic licence (`LICENSE-CC-BY-SA-2.5.txt`). Share-alike applies: a derivative of these images must carry the',
    'same licence. Each frame was decoded from the dataset\'s TIFF, resized so its long edge is at most',
    `${MAX_EDGE} px and re-encoded as JPEG; the previews are ${PREVIEW_WIDTH} px wide PNGs. Nothing else was changed.`,
    '',
    '## Dataset',
    '',
    `${MIDV.citation}.`,
    '',
    `Distributed by Smart Engines at ${MIDV.url} (readme.txt, license.txt, documents.pdf).`,
    '',
    '## Source images of the sampled document types',
    '',
    'MIDV-500 printed modified copies of publicly licensed specimen images from Wikimedia Commons. The table is',
    `transcribed from the dataset's attribution file (${MIDV.sourcesPdf}) for every document type sampled here.`,
    '',
    '| # | Document | Frames here | Original image | Credits (author / uploader / host) |',
    '|---|----------|-------------|----------------|------------------------------------|',
  ];
  for (const n of [...types.keys()].sort((a, b) => a - b)) {
    const [desc, , url, credits] = MIDV_SOURCES[n];
    lines.push(`| ${String(n).padStart(2, '0')} | ${desc} | ${types.get(n)} | ${url} | ${credits} |`);
  }
  lines.push('');
  await writeFile(path.join(midvDir, 'ATTRIBUTION.md'), `${lines.join('\n')}`);
}

async function sampleMidv({ root, tmp, seed, manifest }) {
  if (!(await hasBinary('curl'))) throw new Error('MIDV-500 is served over FTP; curl is required and was not found');
  if (!(await hasBinary('ffmpeg'))) throw new Error('MIDV-500 frames are TIFFs; ffmpeg is required to decode them and was not found');
  const dir = path.join(tmp, 'midv');
  console.log('MIDV-500: one document type (about 650 MB over FTP)');
  const zips = await parseFtpListing(MIDV.dataset, path.join(dir, 'listing.txt'));
  if (!zips.length) throw new Error('the MIDV-500 FTP listing returned no zip files');
  const md5File_ = path.join(dir, 'md5.txt');
  if (!(await exists(md5File_))) await download(MIDV.md5, md5File_, { label: 'md5.txt' });
  const md5s = Object.fromEntries(
    (await readFile(md5File_, 'utf8'))
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 2)
      .map(([hash, name]) => [name, hash]),
  );

  // Prefer a card over a passport: cards match QuickScan's `id-card` type and the small-document use case.
  const rng = mulberry32(seed);
  const candidates = zips.filter((z) => !/passport/.test(z));
  const zipName = (candidates.length ? candidates : zips)[Math.floor(rng() * (candidates.length ? candidates : zips).length)];
  const docNumber = Number(zipName.slice(0, 2));
  const docCode = zipName.slice(3, -4); // "31_jpn_drvlic.zip" → "jpn_drvlic"
  const docId = `${String(docNumber).padStart(2, '0')}-${docCode.replace(/_/g, '-')}`;
  const [desc, sizeClass, sourceUrl] = MIDV_SOURCES[docNumber] ?? ['unknown document', 'card-size', ''];
  console.log(`  document type ${zipName} (${desc})`);
  const zipPath = path.join(dir, zipName);
  await ensureDownload(`${MIDV.dataset}${zipName}`, zipPath, { md5: md5s[zipName], label: zipName });

  // Four frames per condition (two per device clip), chosen by seed from the 30 frames of each clip.
  const picks = [];
  for (const cond of Object.keys(MIDV.conditions)) {
    for (const dev of Object.keys(MIDV.devices)) {
      for (const i of pickDistinct(rng, 30, MIDV.perCondition / 2)) picks.push({ cond, dev, frame: i + 1 });
    }
  }
  // Zip layout: <zip>/images/<cond><dev>/<cond><dev><nn>_<frame>.tif and the same under ground_truth/ as .json
  const clipDir = (p) => `${p.cond}${p.dev}`;
  const clipOf = (p) => `${clipDir(p)}${String(docNumber).padStart(2, '0')}`;
  const frameName = (p) => `${clipOf(p)}_${String(p.frame).padStart(2, '0')}`;
  const idFor = (p) => `midv-${docId}-${(p.cond + p.dev).toLowerCase()}-${String(p.frame).padStart(2, '0')}`;
  const free = new Set(claimIds(manifest, picks.map(idFor), MIDV.name));
  const wanted = picks.filter((p) => free.has(idFor(p)));

  const unpacked = path.join(dir, 'unpacked');
  const members = [];
  for (const p of wanted) {
    members.push(`${zipName.slice(0, -4)}/images/${clipDir(p)}/${frameName(p)}.tif`);
    members.push(`${zipName.slice(0, -4)}/ground_truth/${clipDir(p)}/${frameName(p)}.json`);
  }
  const need = [];
  for (const m of members) if (!(await exists(path.join(unpacked, m)))) need.push(m);
  if (need.length) {
    await mkdir(unpacked, { recursive: true });
    console.log(`  unpacking ${need.length} file(s)`);
    await execFileP('unzip', ['-q', '-o', zipPath, ...need, '-d', unpacked], { maxBuffer: 1024 * 1024 });
  }

  const midvFrames = path.join(root, 'frames', 'midv');
  const midvPreviews = path.join(root, 'previews', 'midv');
  await mkdir(midvFrames, { recursive: true });
  await writeMidvLicence(midvFrames);

  const cases = [];
  let bytes = 0;
  for (const p of wanted) {
    const id = idFor(p);
    const base = `${zipName.slice(0, -4)}/${'%s'}/${clipDir(p)}/${frameName(p)}`;
    const tif = path.join(unpacked, base.replace('%s', 'images') + '.tif');
    const gt = JSON.parse(await readFile(path.join(unpacked, base.replace('%s', 'ground_truth') + '.json'), 'utf8'));
    const png = path.join(unpacked, `${frameName(p)}.png`);
    if (!(await exists(png))) await execFileP('ffmpeg', ['-v', 'error', '-y', '-i', tif, '-frames:v', '1', png]);
    const image = await loadImage(png);
    const px = gt.quad.map(([x, y]) => [Number(x), Number(y)]);
    const quad = normaliseQuad(px, image.width, image.height);
    const out = await writeFrame(image, path.join(midvFrames, `${id}.jpg`), path.join(midvPreviews, `${id}.png`));
    bytes += out.bytes;
    const [condName, background, occlusion] = MIDV.conditions[p.cond];
    const passport = /passport/i.test(desc);
    const c = baseCase(
      id,
      MIDV,
      `MIDV-500 ${zipName.slice(0, -4)} clip ${clipOf(p)} frame ${String(p.frame).padStart(2, '0')} (${desc}${passport ? ', a passport' : ''}; ` +
        `condition "${condName}", ${MIDV.devices[p.dev]}, ${image.width}×${image.height}, resized to ${out.width}×${out.height}). ` +
        `Specimen printed from ${sourceUrl}; see frames/midv/ATTRIBUTION.md. ` +
        'Conditions guessed from dataset metadata: background and occlusion from the clip condition code; skew, distance and orientation ' +
        'computed from the ground-truth quad (corners outside the frame are kept as values outside 0..1); lighting and blur are not annotated.',
    );
    Object.assign(c, {
      file: `frames/midv/${id}.jpg`,
      preview: `previews/midv/${id}.png`,
      width: out.width,
      height: out.height,
      quad,
      docMm: MIDV.sizes[sizeClass] ?? MIDV.sizes['card-size'],
      conditions: {
        doc: 'id-card',
        background,
        lighting: 'even',
        skew: skewFromQuad(px),
        distance: distanceFromQuad(quad),
        blur: 'none',
        occlusion,
        device: 'dataset:midv-500',
        orientation: orientationFromQuad(px),
      },
    });
    cases.push(c);
  }
  mergeCases(manifest, cases);
  await writeMidvAttribution(midvFrames, manifest);
  console.log(`MIDV-500: ${cases.length} case(s) written from ${zipName}, ${(bytes / 1e6).toFixed(1)} MB of frames`);
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(await readFile(fileURLToPath(import.meta.url), 'utf8').then((s) => s.split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')));
    return;
  }
  const root = path.resolve(args.root ?? path.join(here, '..', 'corpus'));
  const tmp = path.resolve(args.tmp ?? process.env.QUICKSCAN_CORPUS_TMP ?? path.join(os.tmpdir(), 'quickscan-corpus'));
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = await loadManifest(manifestFile);

  if (!args.sample) {
    await fetchRemote(root, manifest);
    return;
  }
  const samplers = { smartdoc: sampleSmartdoc, cord: sampleCord, midv: sampleMidv };
  const sampler = samplers[args.sample];
  if (!sampler) throw new Error(`--sample must be one of ${Object.keys(samplers).join(', ')}`);
  await mkdir(tmp, { recursive: true });
  console.log(`seed ${args.seed}, scratch ${tmp}`);
  const cases = await sampler({ root, tmp, seed: args.seed, manifest });
  await saveManifest(manifestFile, manifest);
  const ids = cases.map((c) => c.id);
  console.log(`manifest: ${manifest.cases.length} case(s) total; ids ${ids[0]} … ${ids.at(-1)}`);
  const frameFiles = (await readdir(path.join(root, 'frames'), { recursive: true })).filter((f) => /\.(jpe?g|png)$/i.test(f));
  console.log(`frames/: ${frameFiles.length} committed image(s)`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
