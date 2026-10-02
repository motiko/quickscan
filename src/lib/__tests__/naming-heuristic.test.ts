import { describe, it, expect } from 'vitest';
import { suggestName, detectDate, detectDocType, detectSender } from '@/lib/naming/heuristic';

const created = new Date('2026-10-01T12:00:00Z');

const GERMAN_INVOICE = `Telekom Deutschland GmbH · Landgrabenweg 151 · 53227 Bonn
Herrn Max Mustermann
Musterstraße 12
10115 Berlin
Rechnung
Kundennummer: 123456789
Rechnungsdatum: 14.09.2026
Geburtsdatum: 01.02.1980
Rechnungsbetrag: 39,95 EUR
Zahlbar bis 28.09.2026`;

const ENGLISH_RECEIPT = `ACME WIDGETS LTD
12 High Street, London
RECEIPT
Date: September 3, 2026
1x Widget 9.99
Total 9.99 GBP`;

const LETTER = `Stadtwerke München
Sehr geehrte Damen und Herren,
vielen Dank für Ihr Schreiben vom 2. März 2026.`;

describe('detectDocType', () => {
  it('picks the earliest matching keyword', () => {
    expect(detectDocType(GERMAN_INVOICE)).toBe('Rechnung');
    expect(detectDocType(ENGLISH_RECEIPT)).toBe('Receipt');
    expect(detectDocType('Lohnabrechnung für September')).toBe('Lohnabrechnung');
    expect(detectDocType('Einkommensteuerbescheid 2025')).toBe('Bescheid');
    expect(detectDocType('Nothing to see here')).toBeNull();
  });
});

describe('detectDate', () => {
  it('prefers a labelled date and skips birth dates', () => {
    expect(detectDate(GERMAN_INVOICE, created)).toBe('2026-09-14');
  });

  it('parses English month names', () => {
    expect(detectDate(ENGLISH_RECEIPT, created)).toBe('2026-09-03');
  });

  it('parses German month names and ISO dates', () => {
    expect(detectDate('vom 2. März 2026', created)).toBe('2026-03-02');
    expect(detectDate('Issued 2026-07-01', created)).toBe('2026-07-01');
  });

  it('handles day/month order in slash dates', () => {
    expect(detectDate('Date 03/04/2026', created)).toBe('2026-04-03');
    expect(detectDate('Date 04/23/2026', created)).toBe('2026-04-23');
  });

  it('rejects impossible or far-future dates', () => {
    expect(detectDate('31.02.2026', created)).toBeNull();
    expect(detectDate('01.01.2099', created)).toBeNull();
  });
});

describe('detectSender', () => {
  it('extracts a company from a letterhead line', () => {
    expect(detectSender(GERMAN_INVOICE)).toBe('Telekom Deutschland GmbH');
    expect(detectSender(ENGLISH_RECEIPT)).toBe('ACME WIDGETS LTD');
  });

  it('falls back to a short heading-like line at the top', () => {
    expect(detectSender(LETTER)).toBe('Stadtwerke München');
  });
});

describe('suggestName', () => {
  it('combines type, sender and date', () => {
    expect(suggestName(GERMAN_INVOICE, created)).toBe('Rechnung – Telekom Deutschland GmbH – 2026-09-14');
    expect(suggestName(ENGLISH_RECEIPT, created)).toBe('Receipt – ACME WIDGETS LTD – 2026-09-03');
  });

  it('drops parts it cannot find', () => {
    expect(suggestName(LETTER, created)).toBe('Stadtwerke München – 2026-03-02');
  });

  it('returns null without a type or sender', () => {
    expect(suggestName('', created)).toBeNull();
    expect(suggestName('12345 67890\n2026-01-01', created)).toBeNull();
  });
});
