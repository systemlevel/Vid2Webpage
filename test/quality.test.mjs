import assert from "node:assert/strict";
import test from "node:test";

import {
  detectFragmentation,
  detectRepetitionLoop,
  distinctVocabularySize,
  inspectTranscript,
} from "../src/quality.mjs";

const looped = [
  ...Array.from({ length: 60 }, () => "Why use the market?"),
  ...Array.from({ length: 40 }, (_, index) => "real sentence " + index),
].join("\n");

const fragmented = [
  ...Array.from({ length: 50 }, (_, index) => "word" + index),
  ...Array.from({ length: 10 }, (_, index) => "normal sentence number " + index),
].join("\n");

test("detects a repetition loop", () => {
  assert.equal(detectRepetitionLoop(looped).line, "why use the market?");
});

test("detects segmentation collapse", () => {
  assert.ok(detectFragmentation(fragmented));
});

test("passes a varied well-segmented transcript", () => {
  const cues = Array.from({ length: 60 }, (_, index) => ({
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: "This is a complete unique sentence number " + index,
  }));
  assert.deepEqual(inspectTranscript(cues), {
    loop: null,
    fragmentation: null,
    clean: true,
  });
});

test("counts digits and apostrophes as vocabulary", () => {
  assert.equal(distinctVocabularySize("SPX 6000 trader's SPX"), 3);
});

test("repetition normalization and minimum boundaries are deterministic", () => {
  const normalized = [
    ...Array.from({ length: 10 }, (_, index) => index % 2 ? " SAME   LINE " : "same line"),
    ...Array.from({ length: 10 }, (_, index) => `unique ${index}`),
  ].join("\n");
  assert.deepEqual(detectRepetitionLoop(normalized), {
    line: "same line",
    count: 10,
    lines: 20,
    repeatShare: 0.5,
    uniqueShare: 0.55,
  });
  assert.equal(detectRepetitionLoop("same line\n".repeat(19)), null);
});

test("repetition applies exact repeat count, repeat share, and unique share boundaries", () => {
  const belowCount = [
    ...Array.from({ length: 9 }, () => "same line"),
    ...Array.from({ length: 11 }, (_, index) => `unique ${index}`),
  ].join("\n");
  assert.equal(detectRepetitionLoop(belowCount), null);

  const exactRepeatShare = [
    ...Array.from({ length: 10 }, () => "same line"),
    ...Array.from({ length: 90 }, (_, index) => `unique ${index}`),
  ].join("\n");
  assert.equal(detectRepetitionLoop(exactRepeatShare).repeatShare, 0.1);

  const belowRepeatShare = [
    ...Array.from({ length: 10 }, () => "same line"),
    ...Array.from({ length: 91 }, (_, index) => `unique ${index}`),
  ].join("\n");
  assert.equal(detectRepetitionLoop(belowRepeatShare), null);

  const exactUniqueShare = Array.from({ length: 10 }, (_, index) =>
    `token ${index}\ntoken ${index}`
  ).join("\n");
  assert.equal(detectRepetitionLoop(exactUniqueShare), null);

  const belowUniqueShare = [
    "token 0",
    "token 0",
    "token 0",
    ...Array.from({ length: 9 }, (_, index) => `token ${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `token ${index + 1}`),
  ].join("\n");
  assert.equal(detectRepetitionLoop(belowUniqueShare).uniqueShare, 10 / 21);
});

test("fragmentation uses nonempty lines and exact threshold boundaries", () => {
  const boundary = [
    ...Array.from({ length: 15 }, () => "word"),
    ...Array.from({ length: 25 }, () => "one two three four five six"),
  ].join("\n");
  assert.equal(detectFragmentation(boundary), null);
  assert.ok(detectFragmentation(boundary + "\nword\nword"));
  assert.equal(detectFragmentation("word\n\n".repeat(39)), null);
});

test("fragmentation distinguishes the exact mean-word and single-word boundaries", () => {
  const exactMean = [
    ...Array.from({ length: 20 }, () => "one two"),
    ...Array.from({ length: 20 }, () => "one two three four five"),
  ].join("\n");
  assert.equal(detectFragmentation(exactMean).wordsPerLine, 3.5);

  const aboveMean = [
    ...Array.from({ length: 20 }, () => "one two"),
    ...Array.from({ length: 20 }, () => "one two three four five six"),
  ].join("\n");
  assert.equal(detectFragmentation(aboveMean), null);

  const exactSingleWordShare = [
    ...Array.from({ length: 16 }, () => "word"),
    ...Array.from({ length: 24 }, () => "one two three four five six"),
  ].join("\n");
  assert.equal(detectFragmentation(exactSingleWordShare).singleWordShare, 0.4);
});

test("inspectTranscript preserves simultaneous loop and fragmentation findings", () => {
  const cues = Array.from({ length: 50 }, (_, index) => ({
    startMs: index,
    endMs: index + 1,
    text: index < 10 ? "Why use the market?" : "word" + index,
  }));
  const result = inspectTranscript(cues);
  assert.equal(result.loop.line, "why use the market?");
  assert.ok(result.fragmentation);
  assert.equal(result.clean, false);
});
