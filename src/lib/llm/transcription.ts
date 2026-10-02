/** Verbatim page transcription through the configured LLM, as an alternative to Tesseract. */

import { callLlm, LlmRefusalError, stripThinking, type LlmConfig, type LlmRequest } from './client';
import type { LlmImage } from './image';

/** Longer edge sent to the model: enough to read small print without huge uploads. */
export const TRANSCRIPTION_MAX_EDGE = 2000;
const DEFAULT_TIMEOUT_MS = 120000;
// A dense page is a few thousand tokens; reasoning models also need room to think
const MAX_TOKENS = 8192;

/** Reply for a page without legible text, so silence can't be mistaken for a failure. */
export const NO_TEXT_MARKER = '[NO TEXT]';

export const TRANSCRIPTION_SYSTEM_PROMPT =
  'You transcribe scanned document pages. Reply with exactly the text printed or written on the page, verbatim. ' +
  'Do not correct spelling, grammar or apparent errors, do not translate, summarize or add commentary. ' +
  'Keep the natural reading order and the original line breaks. Copy numbers, amounts, dates, codes and ' +
  'punctuation exactly as printed. Output plain text only: no Markdown, no code fences, no labels. ' +
  `If the page has no legible text, reply with ${NO_TEXT_MARKER}.`;

const USER_PROMPT = 'Transcribe this page.';

export function buildTranscriptionRequest(image: LlmImage, timeoutMs = DEFAULT_TIMEOUT_MS): LlmRequest {
  return {
    system: TRANSCRIPTION_SYSTEM_PROMPT,
    content: [
      { type: 'image', mediaType: image.mediaType, data: image.data },
      { type: 'text', text: USER_PROMPT },
    ],
    maxTokens: MAX_TOKENS,
    timeoutMs,
    temperature: 0,
  };
}

/** The transcribed text, '' for a page without text, or null when the reply is empty. */
export function cleanTranscription(raw: string): string | null {
  let text = stripThinking(raw).replace(/\r\n?/g, '\n');
  // Models sometimes wrap the whole answer in a code fence despite the instructions
  const fenced = text.trim().match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1];
  text = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  if (text.trim() === NO_TEXT_MARKER) return '';
  return text.trim() ? text : null;
}

export async function transcribeWithLlm(
  image: LlmImage,
  config: LlmConfig,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<string> {
  const { timeoutMs, fetchImpl, signal } = options;
  let raw: string;
  try {
    raw = await callLlm(buildTranscriptionRequest(image, timeoutMs), config, { fetchImpl, signal });
  } catch (err) {
    if (err instanceof LlmRefusalError) throw new Error('The model declined to transcribe this page');
    throw err;
  }

  const text = cleanTranscription(raw);
  if (text === null) throw new Error('The model returned no text');
  return text;
}
