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
    plan.map(({ timestampMs, reasons, associations }) => ({
      timestampMs, reasons, associations,
    })),
    [
      {
        timestampMs: 2000,
        reasons: ["caption"],
        associations: [{ segmentIndex: 0, requestedMs: 2000, reasons: ["caption"] }],
      },
      {
        timestampMs: 4000,
        reasons: ["primary"],
        associations: [{ segmentIndex: 0, requestedMs: 4000, reasons: ["primary"] }],
      },
      {
        timestampMs: 5250,
        reasons: ["scene"],
        associations: [{ segmentIndex: 0, requestedMs: 5250, reasons: ["scene"] }],
      },
      {
        timestampMs: 12000,
        reasons: ["primary"],
        associations: [{ segmentIndex: 1, requestedMs: 12000, reasons: ["primary"] }],
      },
    ]
  );
});

test("rounds clamped fractional requests to the nearest integer millisecond", () => {
  const plan = buildCapturePlan({
    segments: [{ startMs: 0, endMs: 1001, text: "odd segment" }],
    captionCues: [{ startMs: 100, endMs: 301, text: "odd caption" }],
    sceneTimes: [250.5],
    frameTimes: [201, 501],
    durationMs: 1001,
  });

  assert.deepEqual(plan, [
    {
      requestedMs: 201,
      timestampMs: 201,
      reasons: ["caption"],
      associations: [{ segmentIndex: 0, requestedMs: 201, reasons: ["caption"] }],
      filename: "000000201-caption.jpg",
    },
    {
      requestedMs: 501,
      timestampMs: 501,
      reasons: ["primary", "scene"],
      associations: [{
        segmentIndex: 0,
        requestedMs: 501,
        reasons: ["primary", "scene"],
      }],
      filename: "000000501-primary.jpg",
    },
  ]);
  assert.equal(
    plan.every((capture) => Number.isSafeInteger(capture.requestedMs)
      && capture.associations.every((association) =>
        Number.isSafeInteger(association.requestedMs))),
    true,
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
  assert.deepEqual(atFour.associations, [{
    segmentIndex: 0,
    requestedMs: 4000,
    reasons: ["primary", "caption"],
  }]);
  assert.equal(atFour.filename, "000004000-primary.jpg");
  assert.equal("segmentIndex" in atFour, false);
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
  assert.deepEqual(
    plan.find((capture) => capture.reasons.includes("scene")).associations,
    [{ segmentIndex: 0, requestedMs: 4000, reasons: ["scene"] }]
  );
});

test("uses one physical capture while preserving segment primaries on a shared frame", () => {
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
  assert.deepEqual(plan, [{
    requestedMs: 500,
    timestampMs: 2000,
    reasons: ["primary"],
    associations: [
      { segmentIndex: 0, requestedMs: 500, reasons: ["primary"] },
      { segmentIndex: 1, requestedMs: 1500, reasons: ["primary"] },
    ],
    filename: "000002000-primary.jpg",
  }]);
  assert.equal(new Set(plan.map((capture) => capture.filename)).size, plan.length);
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
    associations: [{
      segmentIndex: 0,
      requestedMs: 999,
      reasons: ["primary", "caption"],
    }],
    filename: "000000999-primary.jpg",
  }]);
});

test("identical caption text at distinct decoded frames cannot deduplicate captures", () => {
  const plan = buildCapturePlan({
    segments: [{ startMs: 0, endMs: 1000, text: "one" }],
    captionCues: [
      { startMs: 1999, endMs: 2001, text: "identical caption words" },
      { startMs: 2000, endMs: 2002, text: "identical caption words" },
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
    captionCues: [{ startMs: 3000, endMs: 4800, text: "timing only" }],
    sceneTimes: [3650],
    frameTimes: [4000],
    durationMs: 8000,
  });
  assert.deepEqual(plan, [{
    requestedMs: 4000,
    timestampMs: 4000,
    reasons: ["primary", "scene", "caption"],
    associations: [{
      segmentIndex: 0,
      requestedMs: 4000,
      reasons: ["primary", "scene", "caption"],
    }],
    filename: "000004000-primary.jpg",
  }]);
});

test("attaches a supplementary frame contained by a nonzero segment", () => {
  const plan = buildCapturePlan({
    segments: [
      { startMs: 0, endMs: 1000, text: "one" },
      { startMs: 1000, endMs: 2000, text: "two" },
    ],
    captionCues: [{ startMs: 1100, endMs: 1300, text: "timing only" }],
    sceneTimes: [],
    frameTimes: [500, 1300, 1500],
    durationMs: 2000,
  });
  assert.deepEqual(
    plan.find((capture) => capture.timestampMs === 1300).associations,
    [{ segmentIndex: 1, requestedMs: 1200, reasons: ["caption"] }]
  );
});

test("attaches a gap frame closer to the later segment", () => {
  const plan = buildCapturePlan({
    segments: [
      { startMs: 0, endMs: 1000, text: "one" },
      { startMs: 5000, endMs: 6000, text: "two" },
    ],
    captionCues: [],
    sceneTimes: [3750],
    frameTimes: [500, 4000, 5500],
    durationMs: 6000,
  });
  assert.deepEqual(
    plan.find((capture) => capture.reasons.includes("scene")).associations,
    [{ segmentIndex: 1, requestedMs: 4000, reasons: ["scene"] }]
  );
});

test("overlapping segments use the first containing segment deterministically", () => {
  const plan = buildCapturePlan({
    segments: [
      { startMs: 0, endMs: 3000, text: "outer" },
      { startMs: 1000, endMs: 2000, text: "inner" },
    ],
    captionCues: [{ startMs: 1400, endMs: 1600, text: "timing only" }],
    sceneTimes: [],
    frameTimes: [1500],
    durationMs: 3000,
  });
  assert.deepEqual(plan[0].associations, [
    { segmentIndex: 0, requestedMs: 1500, reasons: ["primary", "caption"] },
    { segmentIndex: 1, requestedMs: 1500, reasons: ["primary"] },
  ]);
});

test("resolves to the first decoded frame at or after a request, not the nearest", () => {
  const plan = buildCapturePlan({
    segments: [{ startMs: 0, endMs: 1000, text: "one" }],
    captionCues: [{ startMs: 1000, endMs: 1200, text: "timing only" }],
    sceneTimes: [],
    frameTimes: [500, 1000, 3000],
    durationMs: 4000,
  });
  assert.equal(
    plan.find((capture) => capture.reasons.includes("caption")).timestampMs,
    3000
  );
});

test("falls back to the final decoded frame after the final PTS", () => {
  const plan = buildCapturePlan({
    segments: [{ startMs: 0, endMs: 1000, text: "one" }],
    captionCues: [{ startMs: 3400, endMs: 3600, text: "timing only" }],
    sceneTimes: [],
    frameTimes: [500, 3000],
    durationMs: 4000,
  });
  assert.equal(
    plan.find((capture) => capture.reasons.includes("caption")).timestampMs,
    3000
  );
});
