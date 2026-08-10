import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifySource,
  localFingerprint,
  youtubeFingerprint,
} from "../src/source.mjs";
import { SourceError } from "../src/errors.mjs";

test("classifies a readable local file and both YouTube URL forms", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "clip.mov"), "video");

  const local = await classifySource("clip.mov", { cwd: dir });
  assert.equal(local.kind, "local");
  assert.equal(local.path, path.join(dir, "clip.mov"));

  assert.equal(
    (await classifySource("https://www.youtube.com/watch?v=abc123")).kind,
    "youtube"
  );
  assert.equal((await classifySource("https://youtu.be/abc123")).kind, "youtube");
});

test("rejects generic URLs, directories, and missing paths", async () => {
  await assert.rejects(
    classifySource("https://example.com/clip.mp4"),
    SourceError
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-directory-"));
  try {
    await assert.rejects(classifySource(dir), SourceError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await assert.rejects(classifySource("missing.mp4"), SourceError);
});

test("fingerprints are deterministic and source-specific", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-fingerprint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "clip.mp4"), "bytes");
  const source = await classifySource("clip.mp4", { cwd: dir });
  assert.equal(await localFingerprint(source), await localFingerprint(source));
  assert.notEqual(youtubeFingerprint("abc"), youtubeFingerprint("def"));
});
