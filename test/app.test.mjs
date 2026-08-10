import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { safeOutputName } from "../src/args.mjs";
import { runPipeline } from "../src/app.mjs";
import { isNonEmptyFile, pathsReferToSameFile } from "../src/fs.mjs";
import { parseVtt } from "../src/vtt.mjs";

const whisperVtt = [
  "WEBVTT",
  "",
  "00:00:00.000 --> 00:00:08.000",
  "Whisper words",
  "",
].join("\n");

const captionVtt = [
  "WEBVTT",
  "",
  "00:00:01.000 --> 00:00:03.000",
  "caption poison",
  "",
].join("\n");

async function makeHarness({
  kind,
  root,
  sourcePath,
  captionPath = null,
  completed = false,
  manifestTranscript = null,
  cachedTranscriptText,
  extractedAudioPath,
  downloadedVideoPath,
  failRender = false,
} = {}) {
  const calls = [];
  const removed = [];
  const fingerprint = `${kind}-fingerprint`;
  const cacheRoot = path.join(root, "cache");
  const cacheDir = path.join(cacheRoot, fingerprint);
  await mkdir(cacheDir, { recursive: true });
  if (cachedTranscriptText !== undefined) {
    await writeFile(path.join(cacheDir, "transcript.vtt"), cachedTranscriptText);
  }

  let manifest = {
    schemaVersion: 1,
    status: completed ? "complete" : "building",
    source: null,
    transcript: manifestTranscript,
    segments: completed
      ? [{ startMs: 0, endMs: 8_000, text: "Already complete" }]
      : [],
    images: [],
    revision: 0,
  };
  const workspace = {
    outputDir: null,
    imagesDir: null,
    cacheDir,
    async loadManifest() {
      calls.push("load-manifest");
      return manifest;
    },
    async saveManifest(value) {
      calls.push("save-manifest");
      manifest = { ...value, revision: (value.revision ?? 0) + 1 };
      return manifest;
    },
  };

  const videoPath = downloadedVideoPath ?? path.join(cacheDir, "source.webm");
  const youtubeCaptionPath = path.join(cacheDir, "captions.en.vtt");
  const services = {
    classifySource: async (input, options) => {
      calls.push("classify");
      assert.equal(options.cwd, root);
      return kind === "local"
        ? { kind, input, path: sourcePath, stat: { size: 11, mtimeMs: 1 } }
        : { kind, input, url: input };
    },
    preflight: async (sourceKind, options) => {
      calls.push("preflight");
      assert.equal(sourceKind, kind);
      assert.equal(options.cacheRoot, cacheRoot);
      return {
        mlx: true,
        whisperCpp: false,
        whisperModelPath: path.join(cacheRoot, "model.bin"),
      };
    },
    fetchYoutubeMetadata: async () => {
      calls.push("youtube-metadata");
      return {
        videoId: "abc",
        title: "YouTube lesson",
        durationMs: 8_000,
        webpageUrl: "https://www.youtube.com/watch?v=abc",
      };
    },
    localFingerprint: async () => {
      calls.push("local-fingerprint");
      return fingerprint;
    },
    youtubeFingerprint: () => {
      calls.push("youtube-fingerprint");
      return fingerprint;
    },
    defaultCacheRoot: ({ env, homedir }) => {
      calls.push("default-cache-root");
      assert.deepEqual(env, { XDG_CACHE_HOME: path.join(root, "cache-parent") });
      assert.equal(typeof homedir, "string");
      return cacheRoot;
    },
    workspaceCacheDir: (base, value) => {
      calls.push("workspace-cache-dir");
      assert.equal(base, cacheRoot);
      assert.equal(value, fingerprint);
      return cacheDir;
    },
    ensureDirectory: async (directory) => {
      calls.push("ensure-cache");
      await mkdir(directory, { recursive: true });
    },
    downloadYoutubeMedia: async ({ url, cacheDir: requestedCacheDir }) => {
      calls.push("download-media");
      assert.equal(url, "https://youtu.be/abc");
      assert.equal(requestedCacheDir, cacheDir);
      await writeFile(videoPath, "youtube-video");
      return videoPath;
    },
    downloadYoutubeCaption: async ({ cacheDir: requestedCacheDir }) => {
      calls.push("download-caption");
      assert.equal(requestedCacheDir, cacheDir);
      await writeFile(youtubeCaptionPath, captionVtt);
      return youtubeCaptionPath;
    },
    probeMedia: async (requestedVideoPath) => {
      calls.push("probe-media");
      assert.equal(requestedVideoPath, kind === "local" ? sourcePath : videoPath);
      return {
        durationMs: 8_000,
        width: 640,
        height: 360,
        hasAudio: true,
        videoStreamIndex: 0,
        subtitleStreamIndexes: [],
        frameRate: 10,
      };
    },
    discoverLocalCaption: async ({ videoPath: requestedVideoPath, outputPath }) => {
      calls.push("discover-caption");
      assert.equal(requestedVideoPath, sourcePath);
      assert.equal(outputPath, path.join(cacheDir, "captions.vtt"));
      return captionPath;
    },
    openWorkspace: async ({ cacheRoot: base, fingerprint: value, outputDir, source }) => {
      calls.push("open-workspace");
      assert.equal(base, cacheRoot);
      assert.equal(value, fingerprint);
      workspace.outputDir = outputDir;
      workspace.imagesDir = path.join(outputDir, "images");
      manifest = { ...manifest, source: manifest.source ?? source };
      return workspace;
    },
    extractAudio: async ({ inputPath, outputPath }) => {
      calls.push("extract-audio");
      assert.equal(inputPath, kind === "local" ? sourcePath : videoPath);
      const selectedPath = extractedAudioPath ?? outputPath;
      if (!extractedAudioPath) await writeFile(selectedPath, "audio");
      return selectedPath;
    },
    loadVocabPrompt: async () => {
      calls.push("load-vocab");
      return "vocabulary";
    },
    transcribeTimed: async ({ audioPath, cacheDir: requestedCacheDir, tools, vocabPrompt }) => {
      calls.push("transcribe");
      assert.equal(audioPath, extractedAudioPath ?? path.join(cacheDir, "audio.m4a"));
      assert.equal(requestedCacheDir, cacheDir);
      assert.equal(tools.mlx, true);
      assert.equal(vocabPrompt, "vocabulary");
      const transcriptPath = path.join(cacheDir, "transcript.vtt");
      await writeFile(transcriptPath, whisperVtt);
      return {
        engine: "mlx-whisper",
        vttPath: transcriptPath,
        cues: [{ startMs: 0, endMs: 8_000, text: "returned cue poison" }],
      };
    },
    parseVtt,
    inspectTranscript: (segments) => ({
      loop: segments.some((segment) => segment.text.includes("degraded")) ? {} : null,
      fragmentation: null,
      clean: !segments.some((segment) => segment.text.includes("degraded")),
    }),
    detectSceneChanges: async (requestedVideoPath) => {
      calls.push("detect-scenes");
      assert.equal(requestedVideoPath, kind === "local" ? sourcePath : videoPath);
      return [3_000];
    },
    listFrameTimestamps: async () => {
      calls.push("list-frame-times");
      return [0, 1_000, 3_250, 4_000, 7_999];
    },
    buildCapturePlan: (options) => {
      calls.push("build-capture-plan");
      assert.equal(options.segments[0].text, "Whisper words");
      assert.equal(options.captionCues[0].text, "caption poison");
      return [{
        requestedMs: 4_000,
        timestampMs: 4_000,
        reasons: ["primary", "caption"],
        associations: [{
          segmentIndex: 0,
          requestedMs: 4_000,
          reasons: ["primary", "caption"],
        }],
        filename: "000004000-primary.jpg",
      }];
    },
    extractFrames: async ({ videoPath: requestedVideoPath, captures, manifest: value }) => {
      calls.push("extract-frames");
      assert.equal(requestedVideoPath, kind === "local" ? sourcePath : videoPath);
      assert.ok(calls.indexOf("save-manifest") < calls.indexOf("extract-frames"));
      assert.equal(value.segments[0].text, "Whisper words");
      assert.equal(Object.hasOwn(captures[0], "segmentIndex"), false);
      assert.deepEqual(captures[0].associations, [{
        segmentIndex: 0,
        requestedMs: 4_000,
        reasons: ["primary", "caption"],
      }]);
      return {
        ...value,
        images: [{
          ...captures[0],
          width: 640,
          height: 360,
        }],
      };
    },
    renderOutput: async ({ workspace: requestedWorkspace, manifest: value, segments, transcriptVttPath }) => {
      calls.push("render-output");
      assert.equal(requestedWorkspace, workspace);
      assert.equal(segments[0].text, "Whisper words");
      assert.doesNotMatch(JSON.stringify(segments), /caption poison|returned cue poison/);
      assert.equal(transcriptVttPath, path.join(cacheDir, "transcript.vtt"));
      if (failRender) throw new Error("render failed");
      return { ...value, status: "complete", segments };
    },
    removeTemporary: async (file) => {
      calls.push(`remove:${path.basename(file)}`);
      removed.push(file);
      await rm(file, { force: true });
    },
    isNonEmptyFile,
    pathsReferToSameFile,
    safeOutputName,
    basenameWithoutExtension: (file) => path.basename(file, path.extname(file)),
    readText: (file) => readFile(file, "utf8"),
  };

  return { calls, removed, services, workspace, cacheDir, videoPath };
}

for (const kind of ["local", "youtube"]) {
  test(`runs the complete ${kind} flow with Whisper-authoritative text`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "Local Lesson.mov");
    const sidecarPath = path.join(root, "Local Lesson.vtt");
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    const harness = await makeHarness({
      kind,
      root,
      sourcePath,
      captionPath: kind === "local" ? sidecarPath : null,
    });

    const result = await runPipeline({
      input: kind === "local" ? sourcePath : "https://youtu.be/abc",
      output: "relative-output",
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.status, "complete");
    assert.deepEqual(result.segments, [{ startMs: 0, endMs: 8_000, text: "Whisper words" }]);
    assert.equal(harness.workspace.outputDir, path.join(root, "relative-output"));
    assert.equal(result.images[0].associations[0].segmentIndex, 0);
    assert.equal(Object.hasOwn(result.images[0], "segmentIndex"), false);
    assert.equal(harness.calls.filter((call) => call === "render-output").length, 1);
    assert.ok(harness.calls.indexOf("classify") < harness.calls.indexOf("preflight"));
    assert.ok(harness.calls.indexOf("preflight") < harness.calls.indexOf(`${kind}-fingerprint`));
    assert.deepEqual(
      harness.removed.map((file) => path.basename(file)).sort(),
      kind === "youtube" ? ["audio.m4a", "source.webm"] : ["audio.m4a"],
    );
    if (kind === "local") {
      assert.equal(await readFile(sourcePath, "utf8"), "local-video");
      assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
      assert.equal(result.source.input, sourcePath);
    } else {
      assert.equal(result.source.videoId, "abc");
      assert.equal(result.source.webpageUrl, "https://www.youtube.com/watch?v=abc");
    }
  });
}

test("retains downloaded media and extracted audio when the pipeline fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await makeHarness({ kind: "youtube", root, failRender: true });

  await assert.rejects(runPipeline({
    input: "https://youtu.be/abc",
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services), /render failed/);

  assert.deepEqual(harness.removed, []);
  assert.equal(await readFile(harness.videoPath, "utf8"), "youtube-video");
  assert.equal(await readFile(path.join(harness.cacheDir, "audio.m4a"), "utf8"), "audio");
});

test("returns a matching completed workspace without retranscribing or rewriting it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-complete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  await writeFile(sourcePath, "local-video");
  const harness = await makeHarness({ kind: "local", root, sourcePath, completed: true });

  const result = await runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services);

  assert.equal(result.status, "complete");
  assert.equal(result.segments[0].text, "Already complete");
  assert.equal(harness.workspace.outputDir, path.join(root, "lesson"));
  assert.equal(harness.calls.includes("save-manifest"), false);
  assert.equal(harness.calls.includes("extract-audio"), false);
  assert.equal(harness.calls.includes("transcribe"), false);
  assert.equal(harness.calls.includes("extract-frames"), false);
  assert.equal(harness.calls.includes("render-output"), false);
  assert.deepEqual(harness.removed, []);
  assert.equal(await readFile(sourcePath, "utf8"), "local-video");
});

test("reuses only a recorded nonempty clean Whisper transcript", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
    manifestTranscript: { engine: "mlx-whisper", filename: "transcript.vtt" },
    cachedTranscriptText: whisperVtt,
  });

  const result = await runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services);

  assert.equal(result.segments[0].text, "Whisper words");
  assert.equal(harness.calls.includes("extract-audio"), false);
  assert.equal(harness.calls.includes("transcribe"), false);
  assert.deepEqual(harness.removed, []);
});

for (const invalidCache of [
  { name: "empty", text: "", transcript: { engine: "mlx-whisper", filename: "transcript.vtt" } },
  { name: "unparseable", text: "not a VTT", transcript: { engine: "mlx-whisper", filename: "transcript.vtt" } },
  { name: "degraded", text: whisperVtt.replace("Whisper words", "degraded words"), transcript: { engine: "mlx-whisper", filename: "transcript.vtt" } },
  { name: "unrecorded", text: whisperVtt, transcript: null },
  { name: "wrong engine", text: whisperVtt, transcript: { engine: "caption-import", filename: "transcript.vtt" } },
  { name: "wrong filename", text: whisperVtt, transcript: { engine: "mlx-whisper", filename: "../transcript.vtt" } },
]) {
  test(`retranscribes instead of reusing the ${invalidCache.name} cache`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-invalid-cache-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.vtt");
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: sidecarPath,
      manifestTranscript: invalidCache.transcript,
      cachedTranscriptText: invalidCache.text,
    });

    const result = await runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.segments[0].text, "Whisper words");
    assert.equal(harness.calls.filter((call) => call === "transcribe").length, 1);
    assert.doesNotMatch(JSON.stringify(result.segments), /caption poison/);
  });
}

for (const aliasKind of ["direct", "symlink", "hard-link"]) {
  test(`successful cleanup never removes a ${aliasKind} alias of the local source`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-alias-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.vtt");
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    const cacheDir = path.join(root, "cache", "local-fingerprint");
    await mkdir(cacheDir, { recursive: true });
    let audioAlias = sourcePath;
    if (aliasKind === "symlink") {
      audioAlias = path.join(cacheDir, "audio-link.m4a");
      await symlink(sourcePath, audioAlias);
    }
    if (aliasKind === "hard-link") {
      audioAlias = path.join(cacheDir, "audio-link.m4a");
      await link(sourcePath, audioAlias);
    }
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: sidecarPath,
      extractedAudioPath: audioAlias,
    });

    const result = await runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.status, "complete");
    assert.equal(await readFile(sourcePath, "utf8"), "local-video");
    assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
    assert.equal((await stat(audioAlias)).isFile(), true);
    assert.deepEqual(harness.removed, []);
  });
}

for (const aliasKind of ["symlink", "hard-link"]) {
  test(`caption timing leaves a ${aliasKind} sidecar alias immutable`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-caption-alias-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.vtt");
    const captionAlias = path.join(root, `caption-${aliasKind}.vtt`);
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    if (aliasKind === "symlink") await symlink(sidecarPath, captionAlias);
    else await link(sidecarPath, captionAlias);
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: captionAlias,
    });

    const result = await runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.status, "complete");
    assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
    assert.equal(await readFile(captionAlias, "utf8"), captionVtt);
  });
}

test("does not clean a downloaded path outside the fingerprint cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-cleanup-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsideVideo = path.join(root, "outside.webm");
  const harness = await makeHarness({
    kind: "youtube",
    root,
    downloadedVideoPath: outsideVideo,
  });

  const result = await runPipeline({
    input: "https://youtu.be/abc",
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services);

  assert.equal(result.status, "complete");
  assert.equal(await readFile(outsideVideo, "utf8"), "youtube-video");
  assert.deepEqual(harness.removed.map((file) => path.basename(file)), ["audio.m4a"]);
});
