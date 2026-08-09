import assert from "node:assert/strict";
import test from "node:test";

import { buildCapturePlan } from "../src/timeline.mjs";

const segments = [
  { startMs: 0, endMs: 8000, text: "first" },
  { startMs: 8000, endMs: 16000, text: "second" },
];
const frames = [0, 2000, 4000, 5250, 6000, 10000, 12000, 15000, 15900];

test("keeps every segment midpoint and adds caption and scene captures", () => {
  const plan = buildCapturePlan({
    segments,
    captionCues: [{ startMs: 1000, endMs: 3000, text: "ignored caption words" }],
    sceneTimes: [5000],
    frameTimes: frames,
    durationMs: 16000,
  });
  assert.deepEqual(
    plan.map(({ timestampMs, reasons, segmentIndex }) => ({
      timestampMs, reasons, segmentIndex,
    })),
    [
      { timestampMs: 2000, reasons: ["caption"], segmentIndex: 0 },
      { timestampMs: 4000, reasons: ["primary"], segmentIndex: 0 },
      { timestampMs: 5250, reasons: ["scene"], segmentIndex: 0 },
      { timestampMs: 12000, reasons: ["primary"], segmentIndex: 1 },
    ]
  );
});

test("coalesces only candidates on the same decoded frame", () => {
  const plan = buildCapturePlan({
    segments,
    captionCues: [{ startMs: 3000, endMs: 5000, text: "timing only" }],
    sceneTimes: [],
    frameTimes: frames,
    durationMs: 16000,
  });
  const atFour = plan.find((capture) => capture.timestampMs === 4000);
  assert.deepEqual(atFour.reasons, ["primary", "caption"]);
  assert.equal(atFour.filename, "000004000-primary.jpg");
});

test("attaches gap captures to the nearest transcript segment", () => {
  const plan = buildCapturePlan({
    segments: [
      { startMs: 0, endMs: 2000, text: "one" },
      { startMs: 6000, endMs: 8000, text: "two" },
    ],
    captionCues: [],
    sceneTimes: [3750],
    frameTimes: [0, 1000, 4000, 7000],
    durationMs: 8000,
  });
  assert.equal(plan.find((capture) => capture.reasons.includes("scene")).segmentIndex, 0);
});

test("preserves each segment primary when midpoints resolve to one decoded frame", () => {
  const plan = buildCapturePlan({
    segments: [
      { startMs: 0, endMs: 1000, text: "one" },
      { startMs: 1000, endMs: 2000, text: "two" },
    ],
    captionCues: [],
    sceneTimes: [],
    frameTimes: [0, 2000],
    durationMs: 2001,
  });
  assert.deepEqual(
    plan.map(({ timestampMs, reasons, segmentIndex, filename }) => ({
      timestampMs, reasons, segmentIndex, filename,
    })),
    [
      {
        timestampMs: 2000,
        reasons: ["primary"],
        segmentIndex: 0,
        filename: "000002000-primary.jpg",
      },
      {
        timestampMs: 2000,
        reasons: ["primary"],
        segmentIndex: 1,
        filename: "000002000-primary.jpg",
      },
    ]
  );
});

test("caps scene requests before the next cut and the video end", () => {
  const plan = buildCapturePlan({
    segments: [{ startMs: 0, endMs: 2000, text: "one" }],
    captionCues: [],
    sceneTimes: [1000, 1100, 1990],
    frameTimes: [0, 1000, 1099, 1100, 1350, 1999],
    durationMs: 2000,
  });
  assert.deepEqual(
    plan.filter((capture) => capture.reasons.includes("scene"))
      .map(({ requestedMs, timestampMs }) => ({ requestedMs, timestampMs })),
    [
      { requestedMs: 1099, timestampMs: 1099 },
      { requestedMs: 1350, timestampMs: 1350 },
      { requestedMs: 1999, timestampMs: 1999 },
    ]
  );
});

test("clamps required and caption midpoint requests to the video duration", () => {
  const plan = buildCapturePlan({
    segments: [{ startMs: 0, endMs: 2200, text: "one" }],
    captionCues: [{ startMs: 1800, endMs: 2200, text: "timing only" }],
    sceneTimes: [],
    frameTimes: [0, 999],
    durationMs: 1000,
  });
  assert.deepEqual(plan, [{
    requestedMs: 999,
    timestampMs: 999,
    reasons: ["primary", "caption"],
    segmentIndex: 0,
    filename: "000000999-primary.jpg",
  }]);
});

test("retains candidates that resolve to distinct adjacent decoded frames", () => {
  const plan = buildCapturePlan({
    segments: [{ startMs: 0, endMs: 1000, text: "one" }],
    captionCues: [
      { startMs: 1999, endMs: 2001, text: "visually similar one" },
      { startMs: 2000, endMs: 2002, text: "visually similar two" },
    ],
    sceneTimes: [],
    frameTimes: [500, 2000, 2001],
    durationMs: 3000,
  });
  assert.deepEqual(
    plan.map(({ timestampMs, reasons }) => ({ timestampMs, reasons })),
    [
      { timestampMs: 500, reasons: ["primary"] },
      { timestampMs: 2000, reasons: ["caption"] },
      { timestampMs: 2001, reasons: ["caption"] },
    ]
  );
});

test("merges all supplementary reasons with deterministic priority", () => {
  const plan = buildCapturePlan({
    segments: [{ startMs: 0, endMs: 8000, text: "one" }],
    captionCues: [{ startMs: 3000, endMs: 5000, text: "timing only" }],
    sceneTimes: [3750],
    frameTimes: [4000],
    durationMs: 8000,
  });
  assert.deepEqual(plan, [{
    requestedMs: 4000,
    timestampMs: 4000,
    reasons: ["primary", "scene", "caption"],
    segmentIndex: 0,
    filename: "000004000-primary.jpg",
  }]);
});
