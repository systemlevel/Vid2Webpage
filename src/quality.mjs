import { cueText } from "./vtt.mjs";

export const REPETITION_DEFAULTS = {
  minLines: 20,
  minRepeatCount: 10,
  minRepeatShare: 0.1,
  minUniqueShare: 0.5,
};

export function detectRepetitionLoop(text, options = {}) {
  const { minLines, minRepeatCount, minRepeatShare, minUniqueShare } = {
    ...REPETITION_DEFAULTS,
    ...options,
  };
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean);
  if (lines.length < minLines) return null;

  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);

  let line = "";
  let count = 0;
  for (const [candidate, candidateCount] of counts) {
    if (candidateCount > count) {
      line = candidate;
      count = candidateCount;
    }
  }

  const repeatShare = count / lines.length;
  const uniqueShare = counts.size / lines.length;
  const looped =
    (count >= minRepeatCount && repeatShare >= minRepeatShare) || uniqueShare < minUniqueShare;
  if (!looped) return null;
  return { line, count, lines: lines.length, repeatShare, uniqueShare };
}

export const FRAGMENTATION_DEFAULTS = {
  minLines: 40,
  maxWordsPerLine: 3.5,
  maxSingleWordShare: 0.4,
};

export function detectFragmentation(text, options = {}) {
  const { minLines, maxWordsPerLine, maxSingleWordShare } = {
    ...FRAGMENTATION_DEFAULTS,
    ...options,
  };
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < minLines) return null;

  const counts = lines.map((line) => line.split(/\s+/).length);
  const words = counts.reduce((sum, count) => sum + count, 0);
  const wordsPerLine = words / lines.length;
  const singleWordShare = counts.filter((count) => count === 1).length / lines.length;
  if (wordsPerLine > maxWordsPerLine && singleWordShare < maxSingleWordShare) return null;

  return { lines: lines.length, words, wordsPerLine, singleWordShare };
}

export function inspectTranscript(cues) {
  const text = cueText(cues);
  const loop = detectRepetitionLoop(text);
  const fragmentation = detectFragmentation(text);
  return { loop, fragmentation, clean: !loop && !fragmentation };
}

export function distinctVocabularySize(text) {
  return new Set((text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? []).size;
}
