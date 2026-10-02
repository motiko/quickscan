/**
 * On-device document naming from OCR text: "Type – Sender – YYYY-MM-DD".
 * Covers English and German documents.
 */

const SEPARATOR = ' – ';

// Earliest match in the text wins, so a title near the top beats a mention further down.
// Each label is shown in the language of the keyword that matched.
const DOC_TYPES: { label: string; pattern: RegExp }[] = [
  { label: 'Rechnung', pattern: /\brechnung/i },
  { label: 'Invoice', pattern: /\binvoice\b/i },
  { label: 'Gutschrift', pattern: /\bgutschrift\b/i },
  { label: 'Credit Note', pattern: /\bcredit note\b/i },
  { label: 'Quittung', pattern: /\bquittung\b/i },
  { label: 'Kassenbon', pattern: /\bkassenbon\b/i },
  { label: 'Receipt', pattern: /\breceipt\b/i },
  { label: 'Kontoauszug', pattern: /\bkontoauszug\b/i },
  { label: 'Bank Statement', pattern: /\b(bank|account) statement\b/i },
  { label: 'Lohnabrechnung', pattern: /\blohnabrechnung\b/i },
  { label: 'Gehaltsabrechnung', pattern: /\bgehaltsabrechnung\b/i },
  { label: 'Entgeltabrechnung', pattern: /\bentgeltabrechnung\b/i },
  { label: 'Payslip', pattern: /\b(payslip|pay slip|pay stub|earnings statement)\b/i },
  { label: 'Mahnung', pattern: /\bmahnung\b/i },
  { label: 'Payment Reminder', pattern: /\bpayment reminder\b/i },
  { label: 'Kündigung', pattern: /\bkündigung\b/i },
  { label: 'Auftragsbestätigung', pattern: /\bauftragsbestätigung\b/i },
  { label: 'Order Confirmation', pattern: /\border confirmation\b/i },
  { label: 'Lieferschein', pattern: /\blieferschein\b/i },
  { label: 'Delivery Note', pattern: /\bdelivery note\b/i },
  { label: 'Angebot', pattern: /\bangebot\b/i },
  { label: 'Quote', pattern: /\bquot(e|ation)\b/i },
  { label: 'Versicherungsschein', pattern: /\bversicherungsschein\b/i },
  { label: 'Insurance Policy', pattern: /\binsurance policy\b/i },
  { label: 'Bescheid', pattern: /bescheid\b/i },
  { label: 'Bescheinigung', pattern: /bescheinigung\b/i },
  { label: 'Certificate', pattern: /\bcertificate\b/i },
  { label: 'Vertrag', pattern: /\bvertrag\b/i },
  { label: 'Contract', pattern: /\b(contract|agreement)\b/i },
  { label: 'Prescription', pattern: /\bprescription\b/i },
];

const COMPANY_SUFFIX =
  /(^|[\s,])(GmbH(\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|UG|GbR|SE|e\.\s?V\.|Inc\.?|Ltd\.?|LLC|Corp\.?|PLC|S\.A\.|B\.V\.)(?=$|[\s,.])/;

const MONTHS: Record<string, number> = {
  januar: 1, january: 1, jan: 1, jänner: 1,
  februar: 2, february: 2, feb: 2,
  märz: 3, maerz: 3, march: 3, mar: 3, mär: 3,
  april: 4, apr: 4,
  mai: 5, may: 5,
  juni: 6, june: 6, jun: 6,
  juli: 7, july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nov: 11,
  dezember: 12, december: 12, dez: 12, dec: 12,
};
const MONTH_NAMES = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const DATE_PATTERNS: { re: RegExp; parse: (m: RegExpMatchArray) => [number, number, number] }[] = [
  // 2026-09-14
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, parse: (m) => [+m[1], +m[2], +m[3]] },
  // 14.09.2026 / 14.9.26
  { re: /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})\b/g, parse: (m) => [year(m[3]), +m[2], +m[1]] },
  // 14/09/2026 (day first unless that is impossible)
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g,
    parse: (m) => (+m[2] > 12 ? [year(m[3]), +m[1], +m[2]] : [year(m[3]), +m[2], +m[1]]),
  },
  // 14. September 2026 / 14 Sep 2026
  {
    re: new RegExp(`\\b(\\d{1,2})\\.?\\s+(${MONTH_NAMES})\\.?\\s+(\\d{4})\\b`, 'gi'),
    parse: (m) => [+m[3], MONTHS[m[2].toLowerCase()], +m[1]],
  },
  // September 14, 2026
  {
    re: new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'),
    parse: (m) => [+m[3], MONTHS[m[1].toLowerCase()], +m[2]],
  },
];

const DATE_LABEL = /(datum|date|dated|vom|stand)\s*:?\s*$/i;
const IGNORED_DATE_LABEL = /(geburt|birth|geb\.|fällig|due|gültig bis|valid until|expires?)\W*\S*\s*:?\s*$/i;

function year(y: string): number {
  return y.length === 2 ? 2000 + +y : +y;
}

function isValidDate(y: number, m: number, d: number, maxYear: number): boolean {
  if (y < 1990 || y > maxYear || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function detectDocType(text: string): string | null {
  let best: { label: string; index: number } | null = null;
  for (const { label, pattern } of DOC_TYPES) {
    const m = pattern.exec(text);
    if (m && (!best || m.index < best.index)) best = { label, index: m.index };
  }
  return best?.label ?? null;
}

export function detectDate(text: string, createdAt: Date = new Date()): string | null {
  const maxYear = createdAt.getFullYear() + 1;
  const found: { iso: string; index: number; labeled: boolean }[] = [];

  for (const { re, parse } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const [y, mo, d] = parse(m);
      if (!isValidDate(y, mo, d, maxYear)) continue;
      const before = text.slice(Math.max(0, m.index! - 30), m.index);
      if (IGNORED_DATE_LABEL.test(before)) continue;
      found.push({ iso: `${y}-${pad(mo)}-${pad(d)}`, index: m.index!, labeled: DATE_LABEL.test(before) });
    }
  }

  found.sort((a, b) => Number(b.labeled) - Number(a.labeled) || a.index - b.index);
  return found[0]?.iso ?? null;
}

function cleanSender(segment: string): string {
  return segment
    .replace(/^[\s\-–—•·|,:]+|[\s\-–—•·|,:]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 40)
    .trim();
}

export function detectSender(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Letterheads often pack name and address on one line: "Acme GmbH · Hauptstr. 1 · Berlin"
  for (const line of lines.slice(0, 40)) {
    for (const segment of line.split(/\s[·•|]\s|\s{2,}|,\s(?=\D)/)) {
      if (COMPANY_SUFFIX.test(segment) && /[a-zäöü]/i.test(segment)) {
        const sender = cleanSender(segment);
        if (sender.length >= 3) return sender;
      }
    }
  }

  // Otherwise a short, digit-free line near the top that isn't the document type
  for (const line of lines.slice(0, 5)) {
    const words = line.split(/\s+/);
    if (
      words.length <= 5 &&
      line.length >= 3 &&
      line.length <= 40 &&
      !/\d/.test(line) &&
      !detectDocType(line) &&
      /^[\p{L}][\p{L}\s&.'\-]+$/u.test(line)
    ) {
      return cleanSender(line);
    }
  }
  return null;
}

/** Returns a name like "Rechnung – Telekom Deutschland GmbH – 2026-09-14", or null if nothing useful was found. */
export function suggestName(text: string, createdAt: Date = new Date()): string | null {
  if (!text.trim()) return null;
  const type = detectDocType(text);
  const sender = detectSender(text);
  if (!type && !sender) return null;
  const date = detectDate(text, createdAt);
  return [type, sender, date].filter(Boolean).join(SEPARATOR);
}
