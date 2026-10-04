// Pure metric functions for the scanner benchmark (see .claude/skills/scanner-bench/SKILL.md).

/** NFC, whitespace collapsed to single spaces, trimmed. Case and punctuation are kept. */
export function normalizeText(text) {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Levenshtein distance between two arrays (characters or words). */
export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Character errors against the ground truth, by code point after normalizeText. */
export function charErrors(hypothesis, truth) {
  const h = Array.from(normalizeText(hypothesis));
  const t = Array.from(normalizeText(truth));
  return { errors: editDistance(h, t), total: t.length };
}

/** Word errors against the ground truth, words split on whitespace after normalizeText. */
export function wordErrors(hypothesis, truth) {
  const split = (text) =>
    normalizeText(text) ? normalizeText(text).split(" ") : [];
  const t = split(truth);
  return { errors: editDistance(split(hypothesis), t), total: t.length };
}

export function cer(hypothesis, truth) {
  const { errors, total } = charErrors(hypothesis, truth);
  return total === 0 ? (errors === 0 ? 0 : 1) : errors / total;
}

export function wer(hypothesis, truth) {
  const { errors, total } = wordErrors(hypothesis, truth);
  return total === 0 ? (errors === 0 ? 0 : 1) : errors / total;
}

/**
 * Word errors ignoring order: ground-truth words with no matching word in the hypothesis
 * (as multisets), or extra hypothesis words, whichever is larger. Separates misreads from
 * reading-order differences, which CER and WER count as errors too.
 */
export function bagOfWordErrors(hypothesis, truth) {
  const split = (text) =>
    normalizeText(text) ? normalizeText(text).split(" ") : [];
  const h = split(hypothesis);
  const t = split(truth);
  const counts = new Map();
  for (const word of h) counts.set(word, (counts.get(word) ?? 0) + 1);
  let matched = 0;
  for (const word of t) {
    const n = counts.get(word) ?? 0;
    if (n > 0) {
      matched++;
      counts.set(word, n - 1);
    }
  }
  return { errors: Math.max(t.length, h.length) - matched, total: t.length };
}
