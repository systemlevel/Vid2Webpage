import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs, safeOutputName } from "../src/args.mjs";
import { UsageError } from "../src/errors.mjs";

test("parses a source and optional output directory", () => {
  assert.deepEqual(parseCliArgs(["clip.mov", "--output", "notes"]), {
    input: "clip.mov",
    output: "notes",
    help: false,
  });
  assert.deepEqual(parseCliArgs(["-h"]), { help: true });
});

test("rejects missing and extra positional arguments", () => {
  assert.throws(() => parseCliArgs([]), UsageError);
  assert.throws(() => parseCliArgs(["one.mp4", "two.mp4"]), UsageError);
});

test("creates a bounded filesystem-safe output name", () => {
  assert.equal(safeOutputName("  Café: Market / Review!  "), "cafe-market-review");
  assert.equal(safeOutputName("***"), "v2w-output");
  assert.ok(safeOutputName("x".repeat(200)).length <= 80);
});
