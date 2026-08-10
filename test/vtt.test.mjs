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
  const input = "WEBVTT\n\nNOTE comment\nignored\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:sidebar\nwidth:40%\n\nbad --> cue\nx\n";
  assert.deepEqual(parseVtt(input), []);
});

test("rejects zero- and negative-duration cues", () => {
  const input = [
    "WEBVTT",
    "",
    "00:00:02.000 --> 00:00:02.000",
    "zero",
    "",
    "00:00:03.000 --> 00:00:02.000",
    "negative",
  ].join("\n");
  assert.deepEqual(parseVtt(input), []);
});

test("rejects invalid minute and second clock fields in VTT and SRT", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:99:00.000 --> 01:00:00.000",
    "invalid minutes",
    "",
    "00:00:00.000 --> 00:60:01.000",
    "invalid seconds",
    "",
    "00:00:00.000 --> 00:00:01.000",
    "valid",
  ].join("\n");
  const srt = "1\n00:99:00,000 --> 00:00:01,000\ninvalid minutes\n";

  assert.deepEqual(parseVtt(vtt), [{
    startMs: 0,
    endMs: 1000,
    text: "valid",
  }]);
  assert.deepEqual(parseSrt(srt), []);
});

test("keeps repeated rolling-caption timings as separate cues", () => {
  assert.deepEqual(parseVtt([
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "same words",
    "",
    "00:00:02.000 --> 00:00:03.000",
    "same words",
  ].join("\n")), [
    { startMs: 1000, endMs: 2000, text: "same words" },
    { startMs: 2000, endMs: 3000, text: "same words" },
  ]);
});

test("decodes supported entities and collapses multiline cue whitespace", () => {
  assert.deepEqual(parseVtt([
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:01.000",
    "<b>A &lt; B &gt; &quot;Q&quot; &apos;S&#39; &nbsp; end</b>",
    "next\tline",
  ].join("\n")), [{
    startMs: 0,
    endMs: 1000,
    text: 'A < B > "Q" \'S\' end next line',
  }]);
});

test("produces quality text and stable timestamps", () => {
  assert.equal(cueText([
    { startMs: 0, endMs: 1, text: "one" },
    { startMs: 1, endMs: 2, text: "two" },
  ]), "one\ntwo");
  assert.equal(formatVttTimestamp(3723004), "01:02:03.004");
});
