#!/usr/bin/env node
// Seeded printable test pages with exact OCR ground truth (corpus bucket C).
//
// Every page is laid out from a seed, so the text file written next to it is
// exactly what the printed page shows — no transcription, no PII. The owner
// prints the PDFs (600 dpi laser, 80 g paper) and films them for the shot list in
// docs/scanner-data-plan.md; synth.mjs renders the same pages onto backgrounds.
//
//   node bench/tools/pages.mjs [--seed 1] [--set eval|train] [--out bench/pages] [--dpi 300]
//
// Outputs (gitignored, regenerable): bench/pages/<id>.pdf (vector, for printing),
// bench/pages/<id>.png (raster at --dpi, for synth.mjs), bench/pages/pages.json
// (page list with sizes in mm, fonts and text path). Ground truth goes to
// bench/corpus/text/<id>.txt (committed): UTF-8, reading order, one line per
// printed line, blank line between paragraphs, column 1 before column 2.
//
// Fonts: bench/fonts/Liberation*.ttf (SIL OFL 1.1) — metric-compatible with Times
// New Roman / Arial / Courier New, and identical on macOS and Linux CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, registerFont } from 'canvas';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { seed: 1, set: 'eval', out: 'bench/pages', dpi: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--set') args.set = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--dpi') args.dpi = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n'));
      process.exit(0);
    } else throw new Error(`Unknown argument ${a}`);
  }
  if (!['eval', 'train'].includes(args.set)) throw new Error('--set must be eval or train');
  return args;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  // pickFresh never returns the same element twice in a row (per array)
  const last = new Map();
  next.pickFresh = (arr) => {
    let v = next.pick(arr);
    if (arr.length > 1 && last.get(arr) === v) v = arr[(arr.indexOf(v) + 1) % arr.length];
    last.set(arr, v);
    return v;
  };
  return next;
}

// ---------------------------------------------------------------------------
// Fonts

const FONT_DIR = path.join(root, 'bench', 'fonts');
export const FONTS = {
  serif: { family: 'Liberation Serif', regular: 'LiberationSerif-Regular.ttf', bold: 'LiberationSerif-Bold.ttf' },
  sans: { family: 'Liberation Sans', regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf' },
  mono: { family: 'Liberation Mono', regular: 'LiberationMono-Regular.ttf', bold: 'LiberationMono-Bold.ttf' },
};

let fontsRegistered = false;
export function ensureFonts() {
  if (fontsRegistered) return;
  for (const f of Object.values(FONTS)) {
    registerFont(path.join(FONT_DIR, f.regular), { family: f.family, weight: 'normal' });
    registerFont(path.join(FONT_DIR, f.bold), { family: f.family, weight: 'bold' });
  }
  fontsRegistered = true;
}

// ---------------------------------------------------------------------------
// Text material. Written for this corpus: natural prose with no names, addresses
// or identifiers; German paragraphs exercise umlauts, ß, „quotes“ and compounds.

const PROSE = {
  eng: [
    'The office had been quiet since the early afternoon, and the only sound was the slow hum of the printer in the corner. Someone had left a stack of forms on the table by the window, each one filled in by hand and waiting to be checked before the end of the week.',
    'Scanning a page with a phone sounds simple until the light is wrong. A lamp from the side throws a shadow across half the text, a window behind the desk turns the paper into a mirror, and the camera, trying to be helpful, brightens the shadow until the ink fades into grey.',
    'Receipts are the hardest documents in the drawer. They are printed on thin thermal paper that curls as soon as it leaves the till, the type is small and often faint, and the totals that matter sit at the very bottom where the paper is most likely to be torn.',
    'A good filter does not try to make the page beautiful. It removes the gradient left by uneven light, keeps the strokes of the letters as dark as they were, and leaves the background as close to white as the paper allows without erasing a signature or a stamp.',
    'The train left at a quarter past eight and reached the coast shortly before noon. Fields gave way to marsh, marsh to dunes, and when the carriage doors opened the air smelled of salt and diesel in roughly equal measure.',
    'Nobody remembers who first suggested keeping every document as a photograph rather than a file. It seemed careless at the time, but a photograph keeps the folds, the notes in the margin and the coffee ring, and those turned out to be the details people searched for later.',
    'Text recognition works best on pages that look like the ones it learned from: dark print on pale paper, lines that run straight across the image, and letters tall enough that the engine can tell an e from a c. Everything else is a question of preparation.',
    'By the time the meeting ended, the whiteboard was covered in arrows. Someone took a picture of it before it was wiped, and that picture, slightly tilted and with a reflection of the ceiling lights in one corner, became the only record of what had been decided.',
    'The library kept its oldest catalogue on index cards in long wooden drawers. Each card carried a typed title, a shelf mark in pencil and, on the back, the dates on which the book had been borrowed, written in a dozen different hands.',
    'In winter the shop opened an hour later, and the first customers were always the same: a man who bought one newspaper and read the headlines at the counter, and a woman who collected her bread without a word and paid in exact change.',
  ],
  deu: [
    'Das Büro war seit dem frühen Nachmittag still, und das einzige Geräusch war das leise Summen des Druckers in der Ecke. Jemand hatte einen Stapel Formulare auf dem Tisch am Fenster liegen lassen, jedes von Hand ausgefüllt und bereit zur Prüfung vor dem Wochenende.',
    'Eine Seite mit dem Telefon zu scannen klingt einfach, bis das Licht nicht stimmt. Eine Lampe von der Seite wirft einen Schatten über die Hälfte des Textes, ein Fenster hinter dem Schreibtisch verwandelt das Papier in einen Spiegel, und die Kamera hellt den Schatten so lange auf, bis die Schrift ins Graue verblasst.',
    'Kassenbons sind die schwierigsten Dokumente in der Schublade. Sie sind auf dünnem Thermopapier gedruckt, das sich rollt, sobald es die Kasse verlässt, die Schrift ist klein und oft blass, und die Summen, auf die es ankommt, stehen ganz unten, wo das Papier am ehesten einreißt.',
    'Ein guter Filter versucht nicht, die Seite schön zu machen. Er entfernt den Verlauf, den ungleichmäßiges Licht hinterlässt, erhält die Striche der Buchstaben so dunkel, wie sie waren, und lässt den Hintergrund so weiß, wie es das Papier zulässt, ohne eine Unterschrift oder einen Stempel zu löschen.',
    'Der Zug fuhr um Viertel nach acht ab und erreichte die Küste kurz vor Mittag. Felder wichen Marschland, Marschland wich Dünen, und als sich die Wagentüren öffneten, roch die Luft zu etwa gleichen Teilen nach Salz und Diesel.',
    'Niemand erinnert sich, wer zuerst vorschlug, jedes Dokument als Foto statt als Datei aufzubewahren. Damals wirkte das nachlässig, aber ein Foto bewahrt die Knicke, die Randnotizen und den Kaffeerand, und genau danach suchten die Leute später.',
    'Die Texterkennung funktioniert am besten auf Seiten, die den gelernten ähneln: dunkler Druck auf hellem Papier, Zeilen, die gerade durch das Bild laufen, und Buchstaben, die groß genug sind, dass ein e von einem c zu unterscheiden ist. Alles andere ist eine Frage der Vorbereitung.',
    'Als die Besprechung endete, war das Whiteboard voller Pfeile. Jemand fotografierte es, bevor es gewischt wurde, und dieses leicht schiefe Foto mit der Spiegelung der Deckenlampen in einer Ecke wurde zum einzigen Protokoll der Entscheidungen.',
    'Die Bibliothek bewahrte ihren ältesten Katalog auf Karteikarten in langen Holzschubladen auf. Jede Karte trug einen getippten Titel, eine Signatur mit Bleistift und auf der Rückseite die Ausleihdaten, geschrieben in einem Dutzend verschiedener Handschriften.',
    'Im Winter öffnete der Laden eine Stunde später, und die ersten Kunden waren immer dieselben: ein Mann, der eine Zeitung kaufte und die Schlagzeilen am Tresen las, und eine Frau, die ihr Brot wortlos abholte und passend bezahlte.',
    'Die Geschwindigkeitsbegrenzung auf der Umgehungsstraße wurde im Frühjahr geändert; die Beschilderung folgte erst im Herbst. Dazwischen lagen sechs Monate, in denen niemand genau wusste, was galt.',
  ],
};

const HEADINGS = {
  eng: ['Overview', 'Background', 'Method', 'Capture conditions', 'Results', 'Discussion', 'Notes on lighting', 'Summary', 'Appendix A', 'Next steps'],
  deu: ['Überblick', 'Hintergrund', 'Vorgehen', 'Aufnahmebedingungen', 'Ergebnisse', 'Diskussion', 'Hinweise zur Beleuchtung', 'Zusammenfassung', 'Anhang A', 'Nächste Schritte'],
};

const INVOICE_ITEMS = [
  ['Dokumentenscan, Grundgebühr', 1, 49.0],
  ['Seitenerkennung je Stapel', 3, 12.5],
  ['Texterkennung Deutsch/Englisch', 120, 0.08],
  ['PDF-Export mit Textebene', 2, 15.0],
  ['Archivierung 12 Monate', 1, 36.0],
  ['Support, Stunde', 2, 85.0],
  ['Schulung vor Ort, halber Tag', 1, 420.0],
  ['Datenträger, verschlüsselt', 2, 29.9],
];

const RECEIPT_ITEMS = [
  ['Roggenbrot 750g', 3.4], ['Butter 250g', 2.29], ['Milch 1,5% 1L', 1.09], ['Äpfel lose', 2.87], ['Kaffee gemahlen', 6.99],
  ['Zahnpasta', 1.95], ['Spülmittel', 1.49], ['Bananen', 1.76], ['Joghurt Natur', 0.79], ['Mineralwasser 6x1L', 3.54],
  ['Käse Gouda jung', 2.19], ['Tomaten Rispe', 2.49], ['Nudeln 500g', 0.99], ['Olivenöl 500ml', 5.49], ['Haferflocken', 1.29],
  ['Gurke Stück', 0.89], ['Eier 10er', 2.99], ['Pfand Leergut', -1.5], ['Schokolade', 1.19], ['Küchenrolle', 2.69],
];

const money = (n) => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' €';
const pad2 = (n) => String(n).padStart(2, '0');

function numberBlock(r, lang) {
  const d = `${pad2(r.int(1, 28))}.${pad2(r.int(1, 12))}.${r.int(2019, 2026)}`;
  const inv = `${r.int(2023, 2026)}-${String(r.int(1, 9999)).padStart(4, '0')}`;
  const amount = money(r.int(100, 999999) / 100);
  return lang === 'deu'
    ? [`Datum: ${d}`, `Belegnummer: ${inv}`, `Betrag: ${amount}`, `Kundennummer: ${r.int(100000, 999999)}`, 'IBAN: DE00 0000 0000 0000 0000 00']
    : [`Date: ${d}`, `Reference: ${inv}`, `Amount: ${amount}`, `Customer no.: ${r.int(100000, 999999)}`, 'IBAN: DE00 0000 0000 0000 0000 00'];
}

// ---------------------------------------------------------------------------
// Layout engine. Units: points (1/72 in). Text ground truth collects every drawn line.

const MM_PER_PT = 25.4 / 72;
const mmToPt = (mm) => mm / MM_PER_PT;

class Page {
  constructor(ctx, widthMm, heightMm, marginMm) {
    this.ctx = ctx;
    this.w = mmToPt(widthMm);
    this.h = mmToPt(heightMm);
    this.margin = mmToPt(marginMm);
    this.lines = []; // ground truth lines, '' = paragraph break
    this.y = this.margin;
    this.x0 = this.margin;
    this.colWidth = this.w - 2 * this.margin;
  }

  setFont(kind, pt, bold = false) {
    this.ctx.font = `${bold ? 'bold ' : ''}${pt}pt "${FONTS[kind].family}"`;
    this.pt = pt;
    this.leading = pt * 1.3;
  }

  wrap(text, width) {
    const words = text.split(' ');
    const out = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (this.ctx.measureText(t).width <= width || !cur) cur = t;
      else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    return out;
  }

  fits(n = 1) { return this.y + n * this.leading <= this.h - this.margin; }

  line(text, x = this.x0, { record = true, align = 'left', width = this.colWidth } = {}) {
    if (!this.fits()) return false;
    let dx = x;
    if (align === 'right') dx = x + width - this.ctx.measureText(text).width;
    else if (align === 'center') dx = x + (width - this.ctx.measureText(text).width) / 2;
    this.ctx.fillText(text, dx, this.y + this.pt);
    this.y += this.leading;
    if (record) this.lines.push(text);
    return true;
  }

  paragraph(text, { x = this.x0, width = this.colWidth, gap = 0.6 } = {}) {
    const wrapped = this.wrap(text, width);
    if (!this.fits(Math.min(wrapped.length, 2))) return false;
    for (const l of wrapped) if (!this.line(l, x, { width })) break;
    this.y += this.leading * gap;
    this.lines.push('');
    return true;
  }

  heading(text, kind, pt) {
    const saved = this.ctx.font;
    const savedPt = this.pt;
    const savedLeading = this.leading;
    this.setFont(kind, pt, true);
    const ok = this.fits(3) && this.line(text);
    if (ok) { this.y += this.leading * 0.3; this.lines.push(''); }
    this.ctx.font = saved; this.pt = savedPt; this.leading = savedLeading;
    return ok;
  }

  text() {
    // collapse runs of blank lines, trim
    const out = [];
    for (const l of this.lines) if (!(l === '' && (out.length === 0 || out[out.length - 1] === ''))) out.push(l);
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n') + '\n';
  }
}

// ---------------------------------------------------------------------------
// Page recipes. Each returns { id, lang, doc, sizeMm, font, pt, notes } and fills the Page.

function fillProse(page, r, lang, { headings = false, numbers = false, kind, pt }) {
  const prose = PROSE[lang];
  let h = 0;
  if (headings) page.heading(r.pick(HEADINGS[lang]), kind, pt + 6);
  while (page.fits(3)) {
    if (headings && h++ % 3 === 2) page.heading(r.pick(HEADINGS[lang]), kind, pt + 2);
    if (numbers && h % 4 === 1) {
      for (const l of numberBlock(r, lang)) if (!page.line(l)) break;
      page.y += page.leading * 0.6; page.lines.push('');
    }
    if (!page.paragraph(r.pickFresh(prose))) break;
    h++;
  }
}

function proseRecipe({ id, lang, kind, pt, headings = false, numbers = false, size = [210, 297], margin = 20 }) {
  return {
    id, lang, doc: size[0] === 148 ? 'a5-text' : 'a4-text', sizeMm: size, margin, font: `${FONTS[kind].family} ${pt} pt`,
    notes: `${lang} ${kind} ${pt} pt${headings ? ', headings' : ''}${numbers ? ', number blocks' : ''}, ${margin} mm margin`,
    draw(page, r) { page.setFont(kind, pt); fillProse(page, r, lang, { headings, numbers, kind, pt }); },
  };
}

function twoColumnRecipe({ id, lang, kind, pt }) {
  return {
    id, lang, doc: 'a4-text', sizeMm: [210, 297], font: `${FONTS[kind].family} ${pt} pt`, notes: `${lang} two columns, ${kind} ${pt} pt; reading order column 1 then column 2`,
    draw(page, r) {
      page.setFont(kind, pt);
      const gutter = mmToPt(8);
      const colW = (page.colWidth - gutter) / 2;
      page.heading(r.pick(HEADINGS[lang]), kind, pt + 6);
      const top = page.y;
      for (const col of [0, 1]) {
        page.y = top;
        const x = page.x0 + col * (colW + gutter);
        while (page.fits(3) && page.paragraph(r.pickFresh(PROSE[lang]), { x, width: colW })) { /* fill column */ }
      }
    },
  };
}

function finePrintRecipe({ id, lang }) {
  return {
    id, lang, doc: 'a4-text', sizeMm: [210, 297], font: `${FONTS.sans.family} 7 pt`, notes: `${lang} fine print 7 pt, two columns (Stage 3 hard case)`,
    draw(page, r) {
      page.setFont('sans', 7);
      const gutter = mmToPt(6);
      const colW = (page.colWidth - gutter) / 2;
      const top = page.y;
      for (const col of [0, 1]) {
        page.y = top;
        const x = page.x0 + col * (colW + gutter);
        while (page.fits(3) && page.paragraph(r.pickFresh(PROSE[lang]), { x, width: colW, gap: 0.4 })) { /* fill column */ }
      }
    },
  };
}

function sparseRecipe({ id, lang }) {
  return {
    id, lang, doc: 'a4-text', sizeMm: [210, 297], font: `${FONTS.serif.family} 12 pt`, notes: 'three lines only — orientation probe hard case (needs ≥ 20 confident characters)',
    draw(page, r) {
      page.setFont('serif', 12);
      page.y = mmToPt(60);
      const lines = page.wrap(r.pick(PROSE[lang]), page.colWidth).slice(0, 3);
      for (const l of lines) page.line(l);
    },
  };
}

function invoiceRecipe({ id }) {
  return {
    id, lang: 'deu', doc: 'invoice', sizeMm: [210, 297], font: `${FONTS.sans.family} 10 pt`, notes: 'fictional invoice (Musterfirma GmbH), table with amounts',
    draw(page, r) {
      page.setFont('sans', 10);
      page.heading('Musterfirma GmbH', 'sans', 16);
      for (const l of ['Beispielstraße 1', '00000 Musterstadt', 'www.example.invalid']) page.line(l);
      page.y += page.leading; page.lines.push('');
      page.heading('Rechnung', 'sans', 13);
      for (const l of numberBlock(r, 'deu').slice(0, 4)) page.line(l);
      page.y += page.leading; page.lines.push('');
      const cols = [0, mmToPt(90), mmToPt(115), mmToPt(145)];
      const widths = [mmToPt(88), mmToPt(22), mmToPt(28), mmToPt(25)];
      const row = (cells, bold = false) => {
        if (!page.fits()) return;
        const saved = page.ctx.font;
        if (bold) page.ctx.font = `bold 10pt "${FONTS.sans.family}"`;
        cells.forEach((c, i) => {
          let dx = page.x0 + cols[i];
          if (i > 0) dx += widths[i] - page.ctx.measureText(c).width;
          page.ctx.fillText(c, dx, page.y + page.pt);
        });
        page.ctx.font = saved;
        page.y += page.leading;
        page.lines.push(cells.join(' '));
      };
      row(['Leistung', 'Menge', 'Einzelpreis', 'Betrag'], true);
      const n = r.int(4, 7);
      const items = [...INVOICE_ITEMS].sort(() => r() - 0.5).slice(0, n);
      let net = 0;
      for (const [name, qty, price] of items) {
        const q = typeof qty === 'number' && qty > 10 ? r.int(60, 240) : qty;
        const sum = q * price;
        net += sum;
        row([name, String(q), money(price), money(sum)]);
      }
      page.y += page.leading * 0.5; page.lines.push('');
      const vat = Math.round(net * 19) / 100;
      row(['Nettobetrag', '', '', money(net)]);
      row(['Umsatzsteuer 19 %', '', '', money(vat)]);
      row(['Rechnungsbetrag', '', '', money(net + vat)], true);
      page.y += page.leading; page.lines.push('');
      page.paragraph('Zahlbar innerhalb von 14 Tagen ohne Abzug. Bitte geben Sie bei der Überweisung die Belegnummer an. Dieses Dokument ist ein Testdruck ohne reale Geschäftsbeziehung.');
    },
  };
}

function receiptRecipe({ id, index }) {
  return {
    id, lang: 'deu', doc: 'receipt', sizeMm: [80, 0], font: `${FONTS.mono.family} 9 pt`, notes: 'thermal-receipt layout, monospace; print at ~60 % grey on 80 g paper, cut to 80 mm, curl around a pen',
    draw(page, r) {
      page.setFont('mono', 9);
      const c = { align: 'center' };
      page.line('MUSTERMARKT', page.x0, c);
      page.line(`Filiale ${index + 1}`, page.x0, c);
      page.line('Beispielweg 2, Musterstadt', page.x0, c);
      page.y += page.leading * 0.5; page.lines.push('');
      const w = page.colWidth;
      const n = r.int(6, 12);
      const items = [...RECEIPT_ITEMS].sort(() => r() - 0.5).slice(0, n);
      let total = 0;
      for (const [name, price] of items) {
        const qty = r() < 0.2 ? r.int(2, 4) : 1;
        const sum = qty * price;
        total += sum;
        const left = qty > 1 ? `${qty} x ${name}` : name;
        const right = sum.toFixed(2).replace('.', ',');
        const gap = Math.max(1, Math.floor((w - page.ctx.measureText(left + right).width) / page.ctx.measureText(' ').width));
        page.line(left + ' '.repeat(gap) + right);
      }
      page.line('-'.repeat(Math.floor(w / page.ctx.measureText('-').width)));
      const tot = total.toFixed(2).replace('.', ',');
      page.line('SUMME EUR' + ' '.repeat(Math.max(1, Math.floor((w - page.ctx.measureText('SUMME EUR' + tot).width) / page.ctx.measureText(' ').width))) + tot);
      page.line(`enth. MwSt 7%  ${(total * 0.07 / 1.07).toFixed(2).replace('.', ',')}`);
      page.line(r() < 0.5 ? 'Zahlung: Karte' : 'Zahlung: Bar');
      page.y += page.leading * 0.5; page.lines.push('');
      page.line(`${pad2(r.int(1, 28))}.${pad2(r.int(1, 12))}.${r.int(2023, 2026)}  ${pad2(r.int(8, 20))}:${pad2(r.int(0, 59))}`, page.x0, c);
      page.line(`Bon ${r.int(1000, 9999)}  Kasse ${r.int(1, 6)}`, page.x0, c);
      page.y += page.leading * 0.5; page.lines.push('');
      page.line('Vielen Dank für Ihren Einkauf', page.x0, c);
    },
  };
}

function cardRecipe({ id }) {
  return {
    id, lang: 'deu', doc: 'business-card', sizeMm: [85, 55], font: `${FONTS.sans.family} 9 pt`, notes: 'fictional business card; print on card stock',
    draw(page) {
      page.setFont('sans', 12, true);
      page.ctx.font = `bold 12pt "${FONTS.sans.family}"`;
      page.y = mmToPt(12);
      page.line('Musterfirma GmbH');
      page.setFont('sans', 9);
      page.line('Dokumente · Scannen · Archiv');
      page.y += page.leading; page.lines.push('');
      page.line('Beispielstraße 1');
      page.line('00000 Musterstadt');
      page.line('www.example.invalid');
    },
  };
}

export function recipes(set) {
  const p = set === 'eval' ? 'e' : 't';
  const list = [
    proseRecipe({ id: `${p}-a4-eng-serif11`, lang: 'eng', kind: 'serif', pt: 11 }),
    proseRecipe({ id: `${p}-a4-eng-sans10`, lang: 'eng', kind: 'sans', pt: 10 }),
    proseRecipe({ id: `${p}-a4-eng-serif12-headings`, lang: 'eng', kind: 'serif', pt: 12, headings: true }),
    proseRecipe({ id: `${p}-a4-eng-sans8-dense`, lang: 'eng', kind: 'sans', pt: 8, margin: 15 }),
    proseRecipe({ id: `${p}-a4-eng-mono10`, lang: 'eng', kind: 'mono', pt: 10, numbers: true }),
    twoColumnRecipe({ id: `${p}-a4-eng-twocol10`, lang: 'eng', kind: 'serif', pt: 10 }),
    proseRecipe({ id: `${p}-a4-deu-serif11`, lang: 'deu', kind: 'serif', pt: 11 }),
    proseRecipe({ id: `${p}-a4-deu-sans10`, lang: 'deu', kind: 'sans', pt: 10 }),
    proseRecipe({ id: `${p}-a4-deu-serif12-headings`, lang: 'deu', kind: 'serif', pt: 12, headings: true, numbers: true }),
    proseRecipe({ id: `${p}-a4-deu-sans8-dense`, lang: 'deu', kind: 'sans', pt: 8, margin: 15 }),
    proseRecipe({ id: `${p}-a4-deu-mono10`, lang: 'deu', kind: 'mono', pt: 10, numbers: true }),
    twoColumnRecipe({ id: `${p}-a4-deu-twocol10`, lang: 'deu', kind: 'sans', pt: 10 }),
    proseRecipe({ id: `${p}-a5-eng-serif10`, lang: 'eng', kind: 'serif', pt: 10, size: [148, 210], margin: 14 }),
    finePrintRecipe({ id: `${p}-a4-eng-fine7`, lang: 'eng' }),
    finePrintRecipe({ id: `${p}-a4-deu-fine7`, lang: 'deu' }),
    sparseRecipe({ id: `${p}-a4-deu-sparse`, lang: 'deu' }),
    invoiceRecipe({ id: `${p}-a4-deu-invoice` }),
    receiptRecipe({ id: `${p}-receipt-1`, index: 0 }),
    receiptRecipe({ id: `${p}-receipt-2`, index: 1 }),
    receiptRecipe({ id: `${p}-receipt-3`, index: 2 }),
    receiptRecipe({ id: `${p}-receipt-4`, index: 3 }),
    cardRecipe({ id: `${p}-card` }),
  ];
  return list;
}

// ---------------------------------------------------------------------------
// Rendering: PDF (vector, points) and PNG (raster at dpi). Both draw the same
// recipe with the same PRNG stream, so they are identical in content.

function renderInto(canvas, recipe, seedValue, scale) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  const [w, h] = recipe.sizeMm;
  const page = new Page(ctx, w, h || 297, recipe.margin ?? (recipe.doc === 'receipt' ? 4 : recipe.doc === 'business-card' ? 6 : 20));
  recipe.draw(page, rng(seedValue));
  ctx.restore();
  return page;
}

export function renderRecipe(recipe, seed, index, dpi) {
  ensureFonts();
  const seedValue = (seed * 1000 + index) >>> 0;
  const [wMm, hMmSpec] = recipe.sizeMm;
  // Receipts grow with content: measure once on a tall scratch page, then size the real page.
  let hMm = hMmSpec;
  if (!hMm) {
    const scratch = createCanvas(Math.ceil(mmToPt(wMm)), Math.ceil(mmToPt(600)));
    const page = renderInto(scratch, recipe, seedValue, 1);
    hMm = Math.ceil((page.y + page.margin) * MM_PER_PT);
  }
  const wPt = mmToPt(wMm);
  const hPt = mmToPt(hMm);

  const pdf = createCanvas(wPt, hPt, 'pdf');
  const pagePdf = renderInto(pdf, { ...recipe, sizeMm: [wMm, hMm] }, seedValue, 1);

  const scale = dpi / 72;
  const png = createCanvas(Math.round(wPt * scale), Math.round(hPt * scale));
  renderInto(png, { ...recipe, sizeMm: [wMm, hMm] }, seedValue, scale);

  return { pdf: pdf.toBuffer('application/pdf'), png, text: pagePdf.text(), sizeMm: [wMm, hMm] };
}

export function generate({ seed = 1, set = 'eval', out = 'bench/pages', dpi = 300, quiet = false } = {}) {
  const outDir = path.resolve(root, out);
  const textDir = path.join(root, 'bench', 'corpus', 'text');
  fs.mkdirSync(outDir, { recursive: true });
  if (set === 'eval') fs.mkdirSync(textDir, { recursive: true });
  const list = recipes(set);
  const index = [];
  list.forEach((recipe, i) => {
    const { pdf, png, text, sizeMm } = renderRecipe(recipe, seed, i, dpi);
    fs.writeFileSync(path.join(outDir, `${recipe.id}.pdf`), pdf);
    fs.writeFileSync(path.join(outDir, `${recipe.id}.png`), png.toBuffer('image/png'));
    // Training pages (set T) keep their text beside the PNG, never in the eval corpus.
    const textPath = set === 'eval' ? path.join(textDir, `${recipe.id}.txt`) : path.join(outDir, `${recipe.id}.txt`);
    fs.writeFileSync(textPath, text, 'utf8');
    index.push({
      id: recipe.id, set, seed, lang: recipe.lang, doc: recipe.doc, sizeMm, font: recipe.font, dpi,
      png: `${recipe.id}.png`, pdf: `${recipe.id}.pdf`, text: path.relative(root, textPath).split(path.sep).join('/'),
      chars: text.replace(/\s+/g, '').length, notes: recipe.notes,
    });
    if (!quiet) console.log(`${recipe.id.padEnd(28)} ${sizeMm[0]}×${sizeMm[1]} mm  ${String(text.replace(/\s+/g, '').length).padStart(5)} chars  ${recipe.font}`);
  });
  fs.writeFileSync(path.join(outDir, `pages-${set}.json`), JSON.stringify({ version: 1, set, seed, dpi, pages: index }, null, 2) + '\n');
  return index;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const pages = generate(args);
  console.log(`\n${pages.length} pages → ${args.out}/pages-${args.set}.json; text → ${args.set === 'eval' ? 'bench/corpus/text/' : args.out}`);
}
