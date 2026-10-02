import { describe, it, expect, vi } from 'vitest';
import type { LlmConfig } from '@/lib/llm/client';
import {
  buildTranscriptionRequest,
  cleanTranscription,
  NO_TEXT_MARKER,
  TRANSCRIPTION_SYSTEM_PROMPT,
  transcribeWithLlm,
} from '@/lib/llm/transcription';
import type { LlmImage } from '@/lib/llm/image';

const image: LlmImage = { mediaType: 'image/jpeg', data: 'AAAA' };
const anthropic: LlmConfig = {
  schema: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant',
  model: 'claude-test',
};

function anthropicReply(text: string, stopReason = 'end_turn') {
  return new Response(JSON.stringify({ stop_reason: stopReason, content: [{ type: 'text', text }] }), { status: 200 });
}

describe('buildTranscriptionRequest', () => {
  it('sends the image before the instruction with a verbatim-only prompt', () => {
    const request = buildTranscriptionRequest(image);
    expect(request.system).toBe(TRANSCRIPTION_SYSTEM_PROMPT);
    expect(request.content).toEqual([
      { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' },
      { type: 'text', text: expect.any(String) },
    ]);
    expect(request.temperature).toBe(0);
    expect(request.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(TRANSCRIPTION_SYSTEM_PROMPT).toMatch(/verbatim/);
    expect(TRANSCRIPTION_SYSTEM_PROMPT).toMatch(/line breaks/);
  });
});

describe('cleanTranscription', () => {
  it('keeps line breaks and inner whitespace but trims trailing spaces and blank edges', () => {
    expect(cleanTranscription('\n\nInvoice  No. 0042   \r\nTotal: 1.234,50 €\n\n')).toBe(
      'Invoice  No. 0042\nTotal: 1.234,50 €'
    );
  });

  it('removes reasoning blocks and a wrapping code fence', () => {
    expect(cleanTranscription('<think>Looks like a receipt</think>\n```text\nACME\n2026-09-14\n```')).toBe(
      'ACME\n2026-09-14'
    );
  });

  it('maps the no-text marker to empty text and an empty reply to null', () => {
    expect(cleanTranscription(` ${NO_TEXT_MARKER}\n`)).toBe('');
    expect(cleanTranscription('  \n ')).toBeNull();
  });
});

describe('transcribeWithLlm', () => {
  it('sends the page image to Anthropic and returns the cleaned text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicReply('Line 1\nLine 2\n'));
    const text = await transcribeWithLlm(image, anthropic, { fetchImpl });

    expect(text).toBe('Line 1\nLine 2');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
    expect(body.temperature).toBe(0);
  });

  it('reports refusals and empty replies as errors', async () => {
    await expect(
      transcribeWithLlm(image, anthropic, { fetchImpl: vi.fn().mockResolvedValue(anthropicReply('', 'refusal')) })
    ).rejects.toThrow('declined');
    await expect(
      transcribeWithLlm(image, anthropic, { fetchImpl: vi.fn().mockResolvedValue(anthropicReply('  ')) })
    ).rejects.toThrow('no text');
  });
});
