import { describe, it, expect, vi } from 'vitest';
import type { LlmConfig } from '@/lib/llm/client';
import { buildSummaryInput, cleanLlmSummary, summarizeWithLlm, SYSTEM_PROMPT } from '@/lib/llm/summary';
import { hashText, isSummaryOutdated, summarySourceHash } from '@/lib/document-summary';
import type { Page } from '@/types';

const config: LlmConfig = { schema: 'chat-completions', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test', model: 'some/model' };

function reply(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

function page(ocrText: string, ocrStatus: Page['ocrStatus'] = 'done'): Pick<Page, 'ocrStatus' | 'ocrText'> {
  return { ocrStatus, ocrText };
}

describe('buildSummaryInput', () => {
  it('passes a single page through unlabelled', () => {
    expect(buildSummaryInput(['  Invoice ACME  '])).toBe('Invoice ACME');
  });

  it('labels pages by their position and skips empty ones', () => {
    expect(buildSummaryInput(['First', '', 'Third'])).toBe('--- Page 1 ---\nFirst\n\n--- Page 3 ---\nThird');
  });

  it('returns an empty string when there is no text', () => {
    expect(buildSummaryInput(['', '  '])).toBe('');
  });

  it('stays within the budget and shares it so every page is represented', () => {
    const input = buildSummaryInput(['a '.repeat(5000), 'short page', 'z '.repeat(5000)], 1000);
    expect(input.length).toBeLessThanOrEqual(1000);
    expect(input).toContain('short page');
    expect(input).toContain('--- Page 3 ---\nz z');
    // Long pages are cut, marked with an ellipsis
    expect(input.match(/…/g)).toHaveLength(2);
  });
});

describe('cleanLlmSummary', () => {
  it('removes reasoning, labels, markdown and wrapping quotes', () => {
    expect(cleanLlmSummary('<think>hmm</think>\n**Summary:** An invoice from ACME.')).toBe('An invoice from ACME.');
    expect(cleanLlmSummary('Zusammenfassung: Eine Rechnung.')).toBe('Eine Rechnung.');
    expect(cleanLlmSummary('"A letter.\n\nIt asks for payment."')).toBe('A letter. It asks for payment.');
    expect(cleanLlmSummary('## Overview\n- A receipt from `Shop`.')).toBe('A receipt from Shop.');
  });
});

describe('summarizeWithLlm', () => {
  it('sends the page text with the summary prompt and returns the cleaned reply', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('An invoice from ACME for 42 EUR, due 2026-10-15.'));
    const summary = await summarizeWithLlm(['Invoice', 'Total 42 EUR'], config, { fetchImpl });

    expect(summary).toBe('An invoice from ACME for 42 EUR, due 2026-10-15.');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(body.messages[1].content).toBe('--- Page 1 ---\nInvoice\n\n--- Page 2 ---\nTotal 42 EUR');
    expect(body.max_tokens).toBe(400);
  });

  it('gives reasoning-capable APIs a larger token budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('Summary.'));
    await summarizeWithLlm(['Text'], { ...config, baseUrl: 'https://api.openai.com/v1', openaiNative: true }, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).max_completion_tokens).toBe(2048);
  });

  it('rejects documents without text before calling the model', async () => {
    const fetchImpl = vi.fn();
    await expect(summarizeWithLlm(['', ' '], config, { fetchImpl })).rejects.toThrow(/no recognized text/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports refusals and empty replies', async () => {
    const refusal = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 })
    );
    await expect(
      summarizeWithLlm(['Text'], { ...config, schema: 'anthropic-messages' }, { fetchImpl: refusal })
    ).rejects.toThrow('The model declined to summarize this document');

    const empty = vi.fn().mockResolvedValue(reply('<think>…</think>'));
    await expect(summarizeWithLlm(['Text'], config, { fetchImpl: empty })).rejects.toThrow(/empty summary/);
  });

  it('surfaces HTTP errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad key', { status: 401 }));
    await expect(summarizeWithLlm(['Text'], config, { fetchImpl })).rejects.toThrow(/401/);
  });
});

describe('summary source hash', () => {
  it('is stable and sensitive to changes', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('hellp'));
    expect(hashText('')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('only counts recognized text', () => {
    const pages = [page('One'), page('Two')];
    expect(summarySourceHash([...pages, page('', 'pending')])).toBe(summarySourceHash(pages));
    expect(summarySourceHash([...pages, page('Stale', 'error')])).toBe(summarySourceHash(pages));
  });

  it('flags a summary as outdated when pages are added, removed or re-recognized', () => {
    const pages = [page('One'), page('Two')];
    const summary = { sourceHash: summarySourceHash(pages) };

    expect(isSummaryOutdated(summary, pages)).toBe(false);
    expect(isSummaryOutdated(summary, [...pages, page('Three')])).toBe(true);
    expect(isSummaryOutdated(summary, [pages[0]])).toBe(true);
    expect(isSummaryOutdated(summary, [page('One'), page('Two!')])).toBe(true);
    expect(isSummaryOutdated(summary, [pages[1], pages[0]])).toBe(true);
  });
});
