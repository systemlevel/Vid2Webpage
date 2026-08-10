import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  downloadYoutubeCaption,
  downloadYoutubeMedia,
  fetchYoutubeMetadata,
} from "../src/youtube.mjs";
import { SourceError } from "../src/errors.mjs";

test("parses yt-dlp metadata into the source contract", async () => {
  const run = async (command, args) => {
    assert.equal(command, "yt-dlp");
    assert.deepEqual(args, [
      "--dump-single-json", "--skip-download", "--no-playlist", "https://youtu.be/abc123",
    ]);
    return {
      code: 0,
      stdout: JSON.stringify({
        id: "abc123",
        title: "A lesson",
        duration: 12.5,
        webpage_url: "https://www.youtube.com/watch?v=abc123",
      }),
      stderr: "",
    };
  };
  assert.deepEqual(await fetchYoutubeMetadata("https://youtu.be/abc123", { run }), {
    videoId: "abc123",
    title: "A lesson",
    durationMs: 12500,
    webpageUrl: "https://www.youtube.com/watch?v=abc123",
  });
});

test("rejects incomplete metadata", async () => {
  const run = async () => ({ code: 0, stdout: "{\"id\":\"abc\"}", stderr: "" });
  await assert.rejects(fetchYoutubeMetadata("https://youtu.be/abc", { run }), SourceError);
});

test("media download returns the nonempty printed path", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-youtube-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "source.webm");
  const run = async (command, args) => {
    assert.equal(command, "yt-dlp");
    assert.deepEqual(args, [
      "--no-playlist",
      "-f", "bestvideo*+bestaudio/best",
      "--merge-output-format", "mkv",
      "-o", path.join(dir, "source.%(ext)s"),
      "--print", "after_move:filepath",
      "https://youtu.be/abc",
    ]);
    await writeFile(file, "video");
    return { code: 0, stdout: file + "\n", stderr: "" };
  };
  assert.equal(
    await downloadYoutubeMedia({ url: "https://youtu.be/abc", cacheDir: dir, run }),
    file
  );
});

test("media download rejects an empty printed path", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-youtube-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    downloadYoutubeMedia({
      url: "https://youtu.be/abc",
      cacheDir: dir,
      run: async () => ({ code: 0, stdout: path.join(dir, "missing.mkv"), stderr: "" }),
    }),
    SourceError,
  );
});

test("required YouTube failures include truncated stderr", async () => {
  const stderr = "x".repeat(301);
  await assert.rejects(
    fetchYoutubeMetadata("https://youtu.be/abc", {
      run: async () => ({ code: 1, stdout: "", stderr }),
    }),
    (error) => error instanceof SourceError && error.message.includes(stderr.slice(0, 300)),
  );
});

test("caption failure is optional", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-youtube-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await downloadYoutubeCaption({
    url: "https://youtu.be/abc",
    cacheDir: dir,
    run: async () => ({ code: 1, stdout: "", stderr: "no captions" }),
    log: { warn() {} },
  });
  assert.equal(result, null);
});

test("caption download returns the lexically first nonempty VTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-youtube-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = path.join(dir, "captions.a.vtt");
  const second = path.join(dir, "captions.b.vtt");
  const warnings = [];
  const result = await downloadYoutubeCaption({
    url: "https://youtu.be/abc",
    cacheDir: dir,
    run: async (command, args) => {
      assert.equal(command, "yt-dlp");
      assert.deepEqual(args, [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", "en.*,en",
        "--sub-format", "vtt",
        "-o", path.join(dir, "captions.%(ext)s"),
        "https://youtu.be/abc",
      ]);
      await writeFile(second, "WEBVTT\n");
      await writeFile(first, "WEBVTT\n");
      return { code: 0, stdout: "", stderr: "" };
    },
    log: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(result, first);
  assert.deepEqual(warnings, []);
});

test("caption download warns once when no nonempty VTT exists", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-youtube-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const result = await downloadYoutubeCaption({
    url: "https://youtu.be/abc",
    cacheDir: dir,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    log: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
});
