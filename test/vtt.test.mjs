import assert from "node:assert/strict";
import test from "node:test";

import { cueText, formatVttTimestamp, parseSrt, parseVtt } from "../src/vtt.mjs";

test("parses VTT timestamps, strips tags, and decodes entities", () => {
  const cues = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<c>Market &amp; chart</c>\n"
  );
  assert.deepEqual(cues, [{
    startMs: 1000,
    endMs: 3500,
    text: "Market & chart",
  }]);
});

test("parses SRT comma timestamps", () => {
  assert.deepEqual(
    parseSrt("1\n00:00:02,250 --> 00:00:04,000\nSlide two\n"),
    [{ startMs: 2250, endMs: 4000, text: "Slide two" }]
  );
});

test("ignores preamble, NOTE, STYLE, REGION, and malformed cues", () => {
  const input = "WEBVTT\n\nNOTE comment\nignored\n\nSTYLE\n::cue { color: red }\n\nbad --> cue\nx\n";
  assert.deepEqual(parseVtt(input), []);
});

test("produces quality text and stable timestamps", () => {
  assert.equal(cueText([
    { startMs: 0, endMs: 1, text: "one" },
    { startMs: 1, endMs: 2, text: "two" },
  ]), "one\ntwo");
  assert.equal(formatVttTimestamp(3723004), "01:02:03.004");
});
