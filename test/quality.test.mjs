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

test("fragmentation uses nonempty lines and exact threshold boundaries", () => {
  const boundary = [
    ...Array.from({ length: 15 }, () => "word"),
    ...Array.from({ length: 25 }, () => "one two three four five six"),
  ].join("\n");
  assert.equal(detectFragmentation(boundary), null);
  assert.ok(detectFragmentation(boundary + "\nword\nword"));
  assert.equal(detectFragmentation("word\n\n".repeat(39)), null);
});

test("inspectTranscript returns both findings and clean status", () => {
  const cues = Array.from({ length: 50 }, (_, index) => ({
    startMs: index,
    endMs: index + 1,
    text: "word" + index,
  }));
  const result = inspectTranscript(cues);
  assert.equal(result.loop, null);
  assert.ok(result.fragmentation);
  assert.equal(result.clean, false);
});
