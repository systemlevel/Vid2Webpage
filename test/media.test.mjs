import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildExtractAudioArgs,
  discoverLocalCaption,
  extractAudio,
  probeMedia,
} from "../src/media.mjs";
import { SourceError } from "../src/errors.mjs";

const probeJson = JSON.stringify({
  format: { duration: "12.345" },
  streams: [
    { index: 0, codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
    { index: 1, codec_type: "audio" },
    { index: 2, codec_type: "subtitle" },
  ],
});

test("probeMedia returns validated duration, dimensions, and streams", async () => {
  const run = async () => ({ code: 0, stdout: probeJson, stderr: "" });
  assert.deepEqual(await probeMedia("/video.mov", { run }), {
    durationMs: 12345,
    width: 1920,
    height: 1080,
    hasAudio: true,
    videoStreamIndex: 0,
    subtitleStreamIndexes: [2],
    frameRate: 30000 / 1001,
  });
});

test("probeMedia rejects media without audio", async () => {
  const run = async () => ({
    code: 0,
    stdout: JSON.stringify({
      format: { duration: "2" },
      streams: [{ index: 0, codec_type: "video", width: 640, height: 360 }],
    }),
    stderr: "",
  });
  await assert.rejects(probeMedia("/silent.mp4", { run }), SourceError);
});

test("audio extraction writes AAC without touching the source", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, "source.mov");
  const outputPath = path.join(dir, "audio.m4a");
  await writeFile(inputPath, "source video");
  const run = async (_command, args) => {
    await writeFile(args.at(-1), "aac");
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.deepEqual(buildExtractAudioArgs(inputPath, outputPath), [
    "-y", "-i", inputPath, "-vn", "-acodec", "aac", "-b:a", "128k", outputPath,
  ]);
  assert.equal(await extractAudio({ inputPath, outputPath, run }), outputPath);
  assert.equal(await readFile(inputPath, "utf8"), "source video");
});

test("sidecar VTT wins over SRT and embedded subtitles", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, "lesson.mov");
  const vttPath = path.join(dir, "lesson.vtt");
  await writeFile(videoPath, "video");
  await writeFile(vttPath, "WEBVTT");
  const result = await discoverLocalCaption({
    videoPath,
    mediaInfo: { subtitleStreamIndexes: [2] },
    outputPath: path.join(dir, "embedded.vtt"),
    run: async () => { throw new Error("must not extract embedded captions"); },
  });
  assert.equal(result, vttPath);
});

test("sidecar SRT is converted to WebVTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, "lesson.mov");
  const srtPath = path.join(dir, "lesson.srt");
  const outputPath = path.join(dir, "captions.vtt");
  await writeFile(videoPath, "video");
  await writeFile(srtPath, "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
  const result = await discoverLocalCaption({
    videoPath,
    mediaInfo: { subtitleStreamIndexes: [2] },
    outputPath,
    run: async (command, args) => {
      assert.equal(command, "ffmpeg");
      assert.deepEqual(args, ["-y", "-i", srtPath, "-f", "webvtt", outputPath]);
      await writeFile(outputPath, "WEBVTT");
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result, outputPath);
});

test("embedded subtitle stream is extracted as WebVTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, "lesson.mov");
  const outputPath = path.join(dir, "embedded.vtt");
  await writeFile(videoPath, "video");
  const result = await discoverLocalCaption({
    videoPath,
    mediaInfo: { subtitleStreamIndexes: [7] },
    outputPath,
    run: async (command, args) => {
      assert.equal(command, "ffmpeg");
      assert.deepEqual(args, ["-y", "-i", videoPath, "-map", "0:7", "-f", "webvtt", outputPath]);
      await writeFile(outputPath, "WEBVTT");
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result, outputPath);
});

test("caption extraction failure warns and does not block transcription", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, "lesson.mov");
  await writeFile(videoPath, "video");
  const warnings = [];
  const result = await discoverLocalCaption({
    videoPath,
    mediaInfo: { subtitleStreamIndexes: [2] },
    outputPath: path.join(dir, "embedded.vtt"),
    run: async () => ({ code: 1, stdout: "", stderr: "unsupported subtitle" }),
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
});

test("audio extraction refuses to overwrite the source video", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, "lesson.mov");
  await writeFile(videoPath, "original video");
  await assert.rejects(
    extractAudio({
      inputPath: videoPath,
      outputPath: videoPath,
      run: async (_command, args) => {
        await writeFile(args.at(-1), "rewritten audio");
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    SourceError,
  );
  assert.equal(await readFile(videoPath, "utf8"), "original video");
});

test("audio extraction refuses an output path that resolves to the source video", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, "lesson.mov");
  const linkedDir = path.join(dir, "linked");
  await writeFile(videoPath, "original video");
  await symlink(dir, linkedDir);
  await assert.rejects(
    extractAudio({
      inputPath: videoPath,
      outputPath: path.join(linkedDir, "lesson.mov"),
      run: async (_command, args) => {
        await writeFile(args.at(-1), "rewritten audio");
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    SourceError,
  );
  assert.equal(await readFile(videoPath, "utf8"), "original video");
});
