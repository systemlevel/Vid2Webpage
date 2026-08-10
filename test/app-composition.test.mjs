import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_SERVICES, runPipeline } from "../src/app.mjs";
import { extractFrames } from "../src/frames.mjs";

const whisperVtt = [
  "WEBVTT",
  "",
  "00:00:00.000 --> 00:00:01.001",
  "Composition Whisper words",
  "",
].join("\n");

const captionVtt = [
  "WEBVTT",
  "",
  "00:00:00.100 --> 00:00:00.301",
  "caption poison",
  "",
].join("\n");

function identity(info) {
  return { dev: info.dev, ino: info.ino };
}

function frameRunner() {
  return async (command, args) => {
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), `jpeg-${args[2]}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    assert.equal(command, "ffprobe");
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
      stderr: "",
    };
  };
}

function compositionServices({ root, counters }) {
  const cacheRoot = path.join(root, "cache");
  return {
    ...DEFAULT_SERVICES,
    defaultCacheRoot: () => cacheRoot,
    preflight: async () => ({
      mlx: true,
      whisperCpp: false,
      whisperModelPath: path.join(cacheRoot, "model.bin"),
    }),
    fetchYoutubeMetadata: async () => ({
      videoId: "composition-video",
      title: "Composition YouTube",
      durationMs: 1_001,
      webpageUrl: "https://www.youtube.com/watch?v=composition-video",
    }),
    downloadYoutubeMedia: async ({ cacheDir }) => {
      counters.downloadMedia += 1;
      const videoPath = path.join(cacheDir, "source.webm");
      await writeFile(videoPath, "youtube-video");
      return videoPath;
    },
    downloadYoutubeCaption: async ({ cacheDir }) => {
      counters.downloadCaption += 1;
      const captionPath = path.join(cacheDir, "captions.en.vtt");
      await writeFile(captionPath, captionVtt);
      return captionPath;
    },
    probeMedia: async () => {
      counters.probe += 1;
      return {
        durationMs: 1_001,
        width: 640,
        height: 360,
        hasAudio: true,
        videoStreamIndex: 0,
        subtitleStreamIndexes: [],
        frameRate: 30,
      };
    },
    extractAudio: async ({ output }) => {
      counters.extractAudio += 1;
      writeFileSync(output.fd, "audio");
      return undefined;
    },
    loadVocabPrompt: async () => "composition vocabulary",
    transcribeTimed: async ({ cacheDir }) => {
      counters.transcribe += 1;
      const vttPath = path.join(cacheDir, "transcript.vtt");
      await writeFile(vttPath, whisperVtt);
      return {
        engine: "mlx-whisper",
        vttPath,
        cues: [{ startMs: 0, endMs: 1_001, text: "returned cue poison" }],
      };
    },
    detectSceneChanges: async () => {
      counters.scenes += 1;
      return [250.5];
    },
    listFrameTimestamps: async () => {
      counters.frameTimes += 1;
      return [201, 501, 1_000];
    },
    extractFrames: async (options) => {
      counters.extractFrames += 1;
      return extractFrames({
        ...options,
        run: frameRunner(),
        log: { info() {} },
      });
    },
    renderOutput: async (options) => {
      counters.render += 1;
      return DEFAULT_SERVICES.renderOutput(options);
    },
  };
}

function counters() {
  return {
    downloadMedia: 0,
    downloadCaption: 0,
    probe: 0,
    extractAudio: 0,
    transcribe: 0,
    scenes: 0,
    frameTimes: 0,
    extractFrames: 0,
    render: 0,
  };
}

async function assertPublishedOutput(outputDir, completed) {
  const manifest = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest, completed);
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.revision, manifest.images.length + 3);
  assert.equal(manifest.images.length, 2);
  assert.equal(manifest.images.every((image) =>
    !Object.hasOwn(image, "segmentIndex")
      && image.associations.length > 0
      && Number.isSafeInteger(image.requestedMs)
      && image.associations.every((association) =>
        Number.isSafeInteger(association.requestedMs))), true);
  assert.deepEqual(
    manifest.images.map((image) => image.requestedMs),
    [201, 501],
  );
  assert.deepEqual(
    (await readdir(path.join(outputDir, "images"))).sort(),
    manifest.images.map((image) => image.filename).sort(),
  );
  for (const image of manifest.images) {
    assert.ok((await stat(path.join(outputDir, "images", image.filename))).size > 0);
  }
  assert.equal(await readFile(path.join(outputDir, "transcript.vtt"), "utf8"), whisperVtt);
  assert.ok((await readFile(path.join(outputDir, "styles.css"), "utf8")).length > 0);
  const html = await readFile(path.join(outputDir, "index.html"), "utf8");
  assert.match(html, /Composition Whisper words/);
  assert.doesNotMatch(html, /caption poison|returned cue poison/);
  const inventory = [];
  const visit = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      inventory.push(relative);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
    }
  };
  await visit(outputDir);
  assert.deepEqual(inventory.sort(), [
    "images",
    ...manifest.images.map((image) => path.join("images", image.filename)),
    "index.html",
    "manifest.json",
    "styles.css",
    "transcript.vtt",
  ].sort());
  return { manifest, html };
}

test("composes the local pipeline through real workspace, timeline, frames, and renderer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-local-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "local.mov");
  const sidecarPath = path.join(root, "local.vtt");
  const outputDir = path.join(root, "site");
  await writeFile(videoPath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const videoBefore = await stat(videoPath);
  const sidecarBefore = await stat(sidecarPath);
  const observed = counters();
  const services = compositionServices({ root, counters: observed });

  const completed = await runPipeline({
    input: videoPath,
    output: outputDir,
    cwd: root,
    env: {},
  }, services);

  await assertPublishedOutput(outputDir, completed);
  assert.equal(await readFile(videoPath, "utf8"), "local-video");
  assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
  assert.deepEqual(identity(await stat(videoPath)), identity(videoBefore));
  assert.deepEqual(identity(await stat(sidecarPath)), identity(sidecarBefore));
  assert.deepEqual(observed, {
    downloadMedia: 0,
    downloadCaption: 0,
    probe: 1,
    extractAudio: 1,
    transcribe: 1,
    scenes: 1,
    frameTimes: 1,
    extractFrames: 1,
    render: 1,
  });

  const artifactBytes = await Promise.all([
    "manifest.json", "transcript.vtt", "styles.css", "index.html",
  ].map((name) => readFile(path.join(outputDir, name))));
  const resumed = await runPipeline({
    input: videoPath,
    output: outputDir,
    cwd: root,
    env: {},
  }, services);

  assert.deepEqual(resumed, completed);
  assert.deepEqual(await Promise.all([
    "manifest.json", "transcript.vtt", "styles.css", "index.html",
  ].map((name) => readFile(path.join(outputDir, name)))), artifactBytes);
  assert.equal(observed.extractAudio, 1);
  assert.equal(observed.transcribe, 1);
  assert.equal(observed.extractFrames, 1);
  assert.equal(observed.render, 1);
});

test("composes the YouTube pipeline and publishes only final inventory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-youtube-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "youtube-site");
  const observed = counters();
  const services = compositionServices({ root, counters: observed });

  const completed = await runPipeline({
    input: "https://youtu.be/composition-video",
    output: outputDir,
    cwd: root,
    env: {},
  }, services);

  await assertPublishedOutput(outputDir, completed);
  assert.equal(completed.source.kind, "youtube");
  assert.equal(completed.source.videoId, "composition-video");
  assert.deepEqual(observed, {
    downloadMedia: 1,
    downloadCaption: 1,
    probe: 1,
    extractAudio: 1,
    transcribe: 1,
    scenes: 1,
    frameTimes: 1,
    extractFrames: 1,
    render: 1,
  });
  const cacheDir = path.join(root, "cache", completed.source.fingerprint);
  await assert.rejects(access(path.join(cacheDir, "source.webm")));
  await assert.rejects(access(path.join(cacheDir, "audio.m4a")));
  assert.equal(await readFile(path.join(cacheDir, "captions.en.vtt"), "utf8"), captionVtt);
  assert.equal(await readFile(path.join(cacheDir, "transcript.vtt"), "utf8"), whisperVtt);
});
